#!/usr/bin/env node
// projcache-prune.mjs —— 清理 session_projcache 里「磁盘上已不存在」的陈旧会话记录
//
// 背景（2026-09-17 实测 · 工作 主机 A）：
//   前代单文件 `session_projcache.json` 实测 2217 KB / tables.sessions 里 651 条记录，
//   而磁盘上真实会话只有 129 个 → 524 条陈旧记录（约 793 KB 纯垃圾，占全文件约 80% 体积）。
//   上游 @deepseek-ai/dsh-session-projection-cache 的 README 明说「不提供淘汰或保留接口：
//   记录会按会话持续累积」——这就是垃圾的来源。
//   （主包 0.1.5 已改 per-record 布局，见下"形态"节。）
//
//   缓存的设计契约保证「行可能陈旧（seq 说明陈旧到哪），但绝不会错」→
//   删掉陈旧行没有正确性代价，只让下次冷读多回放一次日志（一次性、数秒）。
//
// ══════════════════════════════════════════════════════════════════════════
// 【B4 · 2026-10-10】读写口径统一：分片目录 ∪ 旧单文件
// ══════════════════════════════════════════════════════════════════════════
// ⚠️ **这是删除类工具，护栏靠"能不能正确读出记录集"** —— 读数错 = 护栏形同虚设
//    （2026-09-17 那次 651 → 256 条就是教训：默认口径把归档会话的记录一并删了）。
//
//   改动前：只读 `<home>/storages/session_projcache.json`（前代单文件）。
//     实测后果（夹具 `home-shard-empty`，与主机现网同形）：
//       · 单文件是 126 B 历史空壳 ⇒ 读到 **0 条** ⇒ 打印「没有需要清理的记录」，
//         而分片目录里真有陈旧记录（**静默失守**）；
//       · 分身 home（无单文件、只有分片）⇒ 直接 `找不到缓存文件` rc=2（数据在也读不到）。
//   改动后：口径与归档插件同源（真源 `tools\dsh-archive-sessions\lib\index.js` L139-275，
//     公共实现 `tools\lib\projcache-read.mjs`）：**分片优先、单文件兜底、并集**。
//
//   **写入同址**（只改读 = 半修）：
//     · 分片里有该记录 ⇒ **删那一份分片文档**（行级锚定，不整目录覆盖）；
//     · 只在单文件里 ⇒ 回落改写单文件（与改动前逐字节同语义）。
//     · 单文件里**没有**要删的条目 ⇒ **整份单文件一字不动**（不再无谓重写空壳）。
//
// ⚠️ 必须在 dsh 停止时执行：JSON 后端「内存中的单元状态具有最终决定权」，
//    运行中改文件会被下一次写入整体覆盖（甚至可能与内存态冲突）。
//
// 用法：
//   node projcache-prune.mjs                      # 只读预演（默认，不写任何文件）
//   node projcache-prune.mjs --apply              # 执行清理（自动备份 + 打印回滚命令）
//   node projcache-prune.mjs --storages <dir>     # 指定 storages 目录
//   node projcache-prune.mjs --sessions <dir>     # 指定 sessions 根目录
//   node projcache-prune.mjs --home <dir>         # 指定 DSH home（默认 resolveDshHome()）
//   node projcache-prune.mjs --backup-root <dir>  # 指定备份根（默认 <workspace>\_archive；R2-9 参数化）
//   node projcache-prune.mjs --drop-archived      # **显式**连归档会话的记录一起删（自带护栏）
//
// 【2026-09-28 · M2 归档元数据库】口径反转（方案 §5.1，R2-9）：
//   · 旧行为：默认删「不在 sessions 里」的记录，`--keep-archived` 才保留 ⇒ **默认正好会删归档元数据**
//     （9/17 事故的成因之一）。
//   · 新行为：**默认保留归档会话记录**（库成为可用副本后本无数据损失，但代码位置错一处就丢数据 ⇒
//     默认值必须在安全侧）；要删请**显式** `--drop-archived`，且它带护栏：
//     **库必须存在且 `state∈{archived,restoring}` 条目数 ≥ 归档会话数 × 0.9**，否则拒跑（exit 2）。
//   · `--keep-archived` 保留为**兼容 no-op**（打印弃用提示）。
//
// 退出码：0 正常 / 2 参数或环境错误 / 4 备份校验失败

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveDshHome } from './lib/dsh-home.mjs';
import { ARCHIVE_DIR } from './lib/workspace.mjs';
import {
  PROJCACHE_UNIT, PROJCACHE_SHARD_KNOWN_VERSIONS,
  projcacheLegacyFile, projcacheShardDir, projcacheShardKeys,
  readProjcacheSessionsTable, isValidShardDoc, normalizeSessionId,
} from './lib/projcache-read.mjs';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const DROP_ARCHIVED = argv.includes('--drop-archived');
const KEEP_ARCHIVED_FLAG = argv.includes('--keep-archived'); // 兼容 no-op（弃用）
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
/** 备份根（R2-9：参数化 —— 旧实现硬编码 `<workspace>\_archive`，跨机/隔离环境会写错盘）。 */
const BACKUP_ROOT = argOf('--backup-root') ?? ARCHIVE_DIR;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 递归收集目录下形如会话 id 的目录名。
 * ⚠️ 不跟随符号链接/junction（`withFileTypes` 的 `isDirectory()` 对链接返回 false）——
 *    防"含链接树"钻进生产主包（见 persona 的 junction 铁律）。
 */
function collectSessionIds(root, set, depth = 0) {
  if (!fs.existsSync(root) || depth > 4) return;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (SESSION_ID_RE.test(e.name)) set.add(e.name);
    collectSessionIds(path.join(root, e.name), set, depth + 1);
  }
}

/**
 * `--drop-archived` 的护栏（R2-9）：库必须存在且覆盖足够。
 * 理由：归档元数据库是归档会话元数据的**可用副本**；库覆盖不足时删 projcache 里的归档记录，
 * 等于把 9/17 的损失面重新打开（那正是本方案要堵的洞）。
 * @returns {{ok:boolean, reason?:string, live?:number, archived?:number}}
 */function archivedRecordGuard(archivedSet, metaRoot) {
  const metaFile = path.join(metaRoot, 'archive-meta.json');
  if (!fs.existsSync(metaFile)) {
    return { ok: false, reason: `元数据库不存在：${metaFile}（先跑 archive-meta-backfill.mjs --apply，或先打开一次归档面板让其惰性补写）` };
  }
  let live = 0;
  try {
    const j = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const sessions = j?.sessions;
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
      return { ok: false, reason: `元数据库结构不符（sessions 非对象）：${metaFile}` };
    }
    for (const v of Object.values(sessions)) {
      const st = v && typeof v === 'object' ? (v.state ?? 'archived') : 'archived';
      if (st === 'archived' || st === 'restoring') live += 1;
    }
  } catch (e) {
    return { ok: false, reason: `元数据库不可解析：${e?.message ?? e}` };
  }
  const need = Math.ceil(archivedSet.size * 0.9);
  if (live < need) {
    return { ok: false, reason: `库覆盖不足：库内 ${live} 条 < 归档会话 ${archivedSet.size} × 0.9 = ${need} 条`, live, archived: archivedSet.size };
  }
  return { ok: true, live, archived: archivedSet.size };
}

/** 读单文件原文（不存在 ⇒ null）。 */
function readLegacyRaw(file) {
  if (!fs.existsSync(file)) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function main() {
  // home 口径与生态同源（BUTLER_DSH_HOME > DSH_HOME > ~/.dsh；§5.4-⑦ 类修复）
  const homeArg = argOf('--home');
  const dshHome = homeArg ? path.resolve(homeArg) : resolveDshHome();
  if (!dshHome) {
    console.error('取不到 DSH home，拒绝在猜测路径上动手');
    return 2;
  }
  if (KEEP_ARCHIVED_FLAG) {
    console.log('[弃用] --keep-archived 已无作用：**默认即保留归档会话记录**（2026-09-28 口径反转）；要删请显式 --drop-archived。');
  }

  const storagesDir = argOf('--storages') ?? path.join(dshHome, 'storages');
  const sessionsRoot = argOf('--sessions') ?? path.join(dshHome, 'sessions');
  const archivedRoot = argOf('--meta-store') ?? path.join(dshHome, '_archived-sessions');
  // ⚠️ 单文件/分片路径必须**同址**：`--storages` 显式给出时，两侧都从它推导
  //    （`projcache-read.mjs` 的 helper 是按 home 推导的，故显式 storages 时在本文件内拼）。
  const unitFile = path.join(storagesDir, `${PROJCACHE_UNIT}.json`);
  const shardDir = path.join(storagesDir, PROJCACHE_UNIT, 'sessions');
  const readHome = path.dirname(storagesDir); // 让读模块与上面的 storagesDir 同址
  const sameAsHelper = path.resolve(path.join(storagesDir, PROJCACHE_UNIT, 'sessions')) === path.resolve(projcacheShardDir(readHome));
  if (!sameAsHelper) {
    console.error(`storages 目录与 home 推导不一致（${storagesDir}）——本脚本要求二者同源，拒绝继续`);
    return 2;
  }

  const hasShardDir = fs.existsSync(shardDir);
  const hasLegacy = fs.existsSync(unitFile);
  if (!hasShardDir && !hasLegacy) {
    console.error(`既没有分片目录也没有旧单文件，无从判断 projcache 形态，拒绝处理:\n  ${shardDir}\n  ${unitFile}`);
    return 2;
  }

  // ── 读：**分片 ∪ 单文件**（与归档插件同源口径）─────────────────────────
  const read = readProjcacheSessionsTable(readHome);
  const table = read.table;
  const allIds = Object.keys(table);

  // 单文件原文（写侧只在"确实要删单文件条目"时才重写它）
  const legacyRaw = readLegacyRaw(unitFile);
  let legacyDoc = null;
  if (legacyRaw !== null) {
    try { legacyDoc = JSON.parse(legacyRaw); } catch {
      console.error(`旧单文件存在但不是合法 JSON，拒绝处理: ${unitFile}`);
      return 2;
    }
    if (legacyDoc?.unit?.name !== undefined && legacyDoc.unit.name !== PROJCACHE_UNIT) {
      console.error(`旧单文件 unit 头不对（${JSON.stringify(legacyDoc?.unit)}），拒绝处理`);
      return 2;
    }
  }
  const legacyRecords = legacyDoc?.tables?.sessions ?? {};

  // ── 保护集：磁盘活跃会话 + 归档区会话 ────────────────────────────────────
  // ⚠️⚠️ **必须按归一 id 比较，不能按名字逐字节比**（2026-10-10 实测踩到，是本卡的重点发现）：
  //    分片文档的**键**可能是 `session-<uuid>`（分身/farm 形态），而磁盘与归档区的**目录名**
  //    是**裸 uuid**。改动前"名字相等"的判据在这两种形态混用时**恒不匹配** ⇒
  //    归档保护护栏对这类记录**静默失效**（实测：归档会话 `session-<uuid>` 分片被当陈旧删掉）。
  //    故这里对两个集合都登记「原样名 + 归一名」，成员判定走"任一形态命中即算"。
  const onDisk = new Set();
  collectSessionIds(sessionsRoot, onDisk);
  const archived = new Set();
  collectSessionIds(archivedRoot, archived);
  const withNorm = (set) => {
    const out = new Set(set);
    for (const n of set) { const norm = normalizeSessionId(n); if (norm) out.add(norm); }
    return out;
  };
  const onDiskIds = withNorm(onDisk);
  const archivedIds = withNorm(archived);
  /** 某 id 是否命中某个"名字集合"（原样 / 归一 / 裸 uuid 三种形态都试）。 */
  const hit = (set, id) => {
    const norm = normalizeSessionId(id);
    const bare = typeof id === 'string' ? id.replace(/^session-/i, '') : null;
    for (const k of [id, norm, bare]) if (typeof k === 'string' && k && set.has(k)) return true;
    return false;
  };

  const staleSet = new Set();
  const protectedCount = { onDisk: 0, archived: 0 };
  for (const id of allIds) {
    if (hit(onDiskIds, id)) { protectedCount.onDisk += 1; continue; }
    // 【2026-09-28】默认**保留**归档会话记录（口径反转，§5.1）；只有显式 --drop-archived 才删
    if (!DROP_ARCHIVED && hit(archivedIds, id)) { protectedCount.archived += 1; continue; }
    staleSet.add(id);
  }
  // 护栏（R2-9）：显式删归档记录前，先证明库覆盖足够
  let guard = null;
  if (DROP_ARCHIVED) {
    guard = archivedRecordGuard(archived, archivedRoot);
    if (!guard.ok) {
      console.error(`[拒绝] --drop-archived 护栏未过：${guard.reason}`);
      console.error('  ⇒ 已中止（未写任何文件）。这条护栏防的是"把归档元数据从两个载体同时删掉"。');
      return 2;
    }
  }

  // ── 删除前双重证明 ──────────────────────────────────────────────────────
  // ① **完整性**：**快照内**的每条记录都能在分片目录（任意命形态）或单文件里找到落点。
  //    ⚠️ 只查 "在本次快照里读到、但现在两侧都找不到落点" 的 id（= 真缺陷）；
  //       快照**之后**才出现的文档天生不在表里，那属于并发churn，不算缺陷（见 ②）。
  // ② **静默**：本工具的既定前提是 **dsh 已停**（见档头）。运行期 dsh 自己每分钟都在写分片，
  //    任何"边扫边变"都说明前提不成立。
  //    · `--apply` ⇒ **fail-closed 拒绝**（不做任何删除）；
  //    · 预演 ⇒ **不拒绝，但把不确定性显式打出来**（否则"0 条陈旧"会被误读成"真没有"——
  //      2026-10-10 生产实测踩到：读快照 933 条、复扫 935 条 ⇒ "0 条"其实是并发污染的读数）。
  let shardFilesNow = [];
  if (hasShardDir) {
    try { shardFilesNow = fs.readdirSync(shardDir); } catch { shardFilesNow = []; }
  }
  const shardDocsNow = new Set();
  for (const f of shardFilesNow) {
    if (!f.endsWith('.json')) continue;
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(path.join(shardDir, f), 'utf8')); } catch { doc = null; }
    if (isValidShardDoc(doc)) shardDocsNow.add(f.slice(0, -5));
  }
  // 并发 churn 判据：现在有、快照里没有（算记录的）文档
  const appeared = [...shardDocsNow].filter((k) => !(k in table));
  const churn = appeared.length > 0;
  const shardKeyExists = (id) => {
    const norm = normalizeSessionId(id);
    const bare = typeof id === 'string' ? id.replace(/^session-/i, '') : null;
    for (const k of [id, norm, bare]) if (typeof k === 'string' && k && shardDocsNow.has(k)) return true;
    return false;
  };
  const missing = allIds.filter((id) => !shardKeyExists(id) && !Object.prototype.hasOwnProperty.call(legacyRecords, id));
  if (missing.length > 0 && !churn) {
    console.error(`[拒绝] 完整性证明失败：${missing.length} 条快照内的记录在分片目录与单文件里都找不到落点`);
    console.error(`  样例：${missing.slice(0, 5).join(', ')}`);
    console.error('  这是读口径缺陷（或分区错位），绝不在这种状态下做删除。');
    return 2;
  }
  if (churn && APPLY) {
    console.error(`[拒绝] 静默证明失败：读取快照之后分片目录里**新出现** ${appeared.length} 条记录`);
    console.error(`  样例：${appeared.slice(0, 5).join(', ')}`);
    console.error('  ⇒ 说明 projcache 正在被并发写入（dsh 还在跑？）。');
    console.error('  ⚠️ 本工具的前提是「dsh 已停」（JSON 后端的内存态会在下次整文件写回时覆盖本次改动）——');
    console.error('     先停 dsh（或用停机窗口 offline-prune-run.mjs）再跑。**未写任何文件。**');
    return 2;
  }

  // 陈旧记录按"物理落点"分为两批（写侧同址）
  // ⚠️ 分片侧要记**实际文件名键**（表键可能只是它的某种形态：裸 uuid / session-<uuid>）
  const staleInShard = [];   // 要删的分片文档**文件名键**
  const staleInLegacy = [];  // 要从单文件表里删掉的键
  const staleNoSource = [];  // 读到过、但现在两侧都找不到（理论上不会发生）
  const resolveShardFileKey = (id) => {
    const norm = normalizeSessionId(id);
    const bare = typeof id === 'string' ? id.replace(/^session-/i, '') : null;
    for (const k of [id, norm, bare]) if (typeof k === 'string' && k && shardDocsNow.has(k)) return k;
    return null;
  };
  for (const id of staleSet) {
    const shardFileKey = resolveShardFileKey(id);
    const inLegacy = Object.prototype.hasOwnProperty.call(legacyRecords, id);
    if (shardFileKey) staleInShard.push(shardFileKey);
    if (inLegacy) staleInLegacy.push(id);
    if (!shardFileKey && !inLegacy) staleNoSource.push(id);
  }

  const bytesOf = (id) => {
    const rec = table[id];
    if (!rec) return 0;
    const shardFileKey = resolveShardFileKey(id);
    if (shardFileKey) {
      try { return fs.statSync(path.join(shardDir, `${shardFileKey}.json`)).size; } catch { /* 落统计 */ }
    }
    return Buffer.byteLength(JSON.stringify(rec), 'utf8');
  };
  const staleBytes = [...staleSet].reduce((a, id) => a + bytesOf(id), 0);

  // 单文件改写后的内容（只在 staleInLegacy 非空时才写盘）
  let outText = null;
  let legacyTouched = false;
  if (legacyDoc && staleInLegacy.length > 0) {
    const keptFinal = {};
    for (const [k, v] of Object.entries(legacyRecords)) if (!staleInLegacy.includes(k)) keptFinal[k] = v;
    // 严格复刻上游 dsh-storage-json 的 serialize()：
    // {unit:{name,version}, global, tables} + JSON.stringify(..., null, 2) + '\n'
    const outDoc = {
      unit: { name: legacyDoc.unit?.name ?? PROJCACHE_UNIT, version: legacyDoc.unit?.version ?? 3 },
      global: legacyDoc.global ?? null,
      tables: { sessions: keptFinal },
    };
    outText = `${JSON.stringify(outDoc, null, 2)}\n`;
    legacyTouched = true;
  }

  console.log('=== session_projcache 清理预演 ===');
  console.log(`  home          : ${readHome}`);
  console.log(`  分片目录      : ${shardDir}${hasShardDir ? `（${shardDocsNow.size} 条记录 / ${read.shardFiles} 个文档，其中 ${read.ignoredShardFiles.length} 个按"不存在"跳过）` : '（不存在）'}`);
  console.log(`  旧单文件      : ${unitFile}${hasLegacy ? `（${(Buffer.byteLength(legacyRaw, 'utf8') / 1024).toFixed(0)} KB / ${Object.keys(legacyRecords).length} 条）` : '（不存在）'}`);
  console.log(`  读口径        : 分片 ∪ 单文件 = ${allIds.length} 条（source=${read.source} · shardCount=${read.shardCount} · legacyCount=${read.legacyCount}）`);
  console.log(`  磁盘活跃会话  : ${onDisk.size}`);
  console.log(`  归档会话      : ${archived.size}${DROP_ARCHIVED ? '（**--drop-archived：记录一并删除**）' : '（保留其记录 ← 默认安全侧）'}`);
  console.log(`  护栏命中      : 活跃 ${protectedCount.onDisk} 条 · 归档 ${protectedCount.archived} 条（按**归一 id**比较，覆盖 session-/裸 uuid 两种形态）`);
  if (guard && guard.ok) console.log(`  护栏          : 库内 ${guard.live} 条 ≥ 归档 ${guard.archived} × 0.9 ✅`);
  console.log(`  【陈旧记录】  : ${staleSet.size} 条（分片侧 ${staleInShard.length} · 单文件侧 ${staleInLegacy.length}${staleNoSource.length ? ` · 无落点 ${staleNoSource.length}` : ''}）`);
  console.log(`  陈旧数据大小  : ${(staleBytes / 1024).toFixed(0)} KB`);
  if (churn) {
    console.log(`  ⚠️ 读数可信度  : **可疑** —— 读取快照之后分片目录里新出现 ${appeared.length} 条记录，`);
    console.log(`                  说明 projcache 正在被**并发写入**（本工具前提 = dsh 已停）。`);
    console.log(`                  下面的"陈旧记录"数可能偏低，**不要把 0 读成"真的没有"**；`);
    console.log(`                  --apply 会在这种状态下直接拒绝。`);
  }
  if (hasLegacy && legacyTouched) console.log(`  单文件处理    : 改写（删 ${staleInLegacy.length} 条，保留 ${Object.keys(legacyRecords).length - staleInLegacy.length} 条）`);
  else if (hasLegacy) console.log(`  单文件处理    : **一字不动**（单文件里没有要删的条目）`);
  console.log('');

  if (staleSet.size === 0) {
    console.log('没有需要清理的记录，无需动作。');
    return 0;
  }

  if (outText !== null) {
    const outBytes = Buffer.byteLength(outText, 'utf8');
    console.log(`  单文件清理后  : ${(outBytes / 1024).toFixed(0)} KB（原 ${(Buffer.byteLength(legacyRaw, 'utf8') / 1024).toFixed(0)} KB）`);
  }

  if (!APPLY) {
    console.log('');
    console.log('[预演模式] 未写入任何文件。加 --apply 执行清理。');
    return 0;
  }

  // ── 备份（行级/文件级锚定；绝不整目录覆盖）─────────────────────────────
  // ⚠️ 不能用 toISOString().slice(0,15)：会得到 "20260917090208."（末尾带点），
  //    Windows 静默去掉尾点建目录，打印出来的回滚路径就指向不存在的目录。
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const backupDir = path.join(BACKUP_ROOT, `projcache-prune-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });

  const manifest = { ranAt: d.toISOString(), backupDir, shardDir, unitFile, legacyTouched, shards: [], legacy: null, warning: '逐文件回滚（据 shards[].key/backup 与 legacy 一一对应，回写前核 sha256）；禁止整目录覆盖。' };

  // ① 分片：只备份要删的那几份文档，并**先核 sha**
  for (const key of staleInShard) {
    const src = path.join(shardDir, `${key}.json`);
    const dst = path.join(backupDir, `${key}.json.before`);
    fs.copyFileSync(src, dst);
    const beforeSha = sha256(fs.readFileSync(src));
    if (beforeSha !== sha256(fs.readFileSync(dst))) {
      console.error(`备份 sha256 校验失败（分片 ${key}），中止（未删除任何文件）`);
      return 4;
    }
    manifest.shards.push({ key, src, backup: path.basename(dst), bytes: fs.statSync(src).size, sha256: beforeSha });
  }
  // ② 单文件：只在真要改写时备份
  if (legacyTouched) {
    const backupFile = path.join(backupDir, `${PROJCACHE_UNIT}.json.before`);
    fs.copyFileSync(unitFile, backupFile);
    const beforeSha = sha256(fs.readFileSync(unitFile));
    if (beforeSha !== sha256(fs.readFileSync(backupFile))) {
      console.error('备份 sha256 校验失败（单文件），中止写入');
      return 4;
    }
    manifest.legacy = { src: unitFile, backup: path.basename(backupFile), bytes: fs.statSync(unitFile).size, sha256: beforeSha };
  }
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // ── ① 删分片文档（行级锚定：逐个 unlink，绝不整目录覆盖）───────────────
  const deletedShards = [];
  for (const key of staleInShard) {
    const target = path.join(shardDir, `${key}.json`);
    try { fs.unlinkSync(target); deletedShards.push(key); }
    catch (e) { console.error(`删分片失败 ${target}：${e.message}（已成功删除 ${deletedShards.length} 份；备份在 ${backupDir}）`); return 4; }
  }

  // ── ② 单文件（原子替换，与上游 writeAtomic 同协议）──────────────────────
  let legacyShaAfter = null;
  if (legacyTouched) {
    const tmp = path.join(storagesDir, `.projcache-prune-${process.pid}.tmp`);
    fs.writeFileSync(tmp, outText, 'utf8');
    let verify;
    try { verify = JSON.parse(fs.readFileSync(tmp, 'utf8')); } catch (error) {
      fs.rmSync(tmp, { force: true });
      console.error(`临时文件回读失败，已删除，未动原文件: ${error.message}`);
      return 4;
    }
    const expectLegacy = Object.keys(legacyRecords).length - staleInLegacy.length;
    if (Object.keys(verify.tables.sessions).length !== expectLegacy) {
      fs.rmSync(tmp, { force: true });
      console.error(`临时文件回读校验失败：记录数 ${Object.keys(verify.tables.sessions).length} ≠ 预期 ${expectLegacy}，未动原文件`);
      return 4;
    }
    fs.renameSync(tmp, unitFile);
    legacyShaAfter = sha256(fs.readFileSync(unitFile));
  }

  // ── ③ 删后复验：读口径必须真的少了这些条目 ─────────────────────────────
  const after = readProjcacheSessionsTable(readHome);
  const afterIds = new Set(Object.keys(after.table));
  const stillThere = [...staleSet].filter((id) => afterIds.has(id));
  if (stillThere.length > 0) {
    console.error(`[警告] 删后复验：仍有 ${stillThere.length} 条陈旧记录可读到（${stillThere.slice(0, 5).join(', ') }…）`);
    console.error(`  备份在 ${backupDir}（逐文件回滚见 manifest.json）。`);
    return 4;
  }

  console.log('');
  console.log('✅ 清理完成');
  console.log(`   备份目录  : ${backupDir}`);
  console.log(`   删分片    : ${deletedShards.length} 份`);
  if (legacyTouched) {
    console.log(`   单文件    : ${manifest.legacy.sha256.slice(0, 12)} → ${legacyShaAfter.slice(0, 12)}`);
  } else {
    console.log('   单文件    : 未改动');
  }
  console.log(`   删后读数  : 分片 ${after.shardCount} 条 ∪ 单文件 ${after.legacyCount} 条 = ${Object.keys(after.table).length} 条`);
  console.log('');
  console.log('   回滚（逐文件锚定）：');
  for (const s of manifest.shards) console.log(`     Copy-Item -LiteralPath '${path.join(backupDir, s.backup)}' -Destination '${s.src}' -Force`);
  if (manifest.legacy) console.log(`     Copy-Item -LiteralPath '${path.join(backupDir, manifest.legacy.backup)}' -Destination '${manifest.legacy.src}' -Force`);
  return 0;
}

process.exitCode = main();
