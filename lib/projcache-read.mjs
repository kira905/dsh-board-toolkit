// ============================================================
//  projcache-read.mjs — session_projcache **读写口径**统一入口（B4 · 2026-10-10）
//  ------------------------------------------------------------
//  为什么有它：主包 0.1.5 起 `session_projcache` 已是 **per-record 布局**（每条会话一个文档
//  `<home>/storages/session_projcache/sessions/<key>.json`；真源
//  `@deepseek-ai/dsh-session-projection-cache` 的 `layout:"per-record"` +
//  `@deepseek-ai/dsh-storage-json` 的 `openPerRecordUnit()`），而生态里一批独立工具
//  仍按**前代单文件** `<home>/storages/session_projcache.json` 读 —— 在分片 home 上
//  读到的是历史空壳（主机）或直接读不到（分身）⇒ 读数错。
//
//  ⚠️ 最危险的消费方是**删除类**（`projcache-prune.mjs`）：它的归档保护护栏靠
//  "能不能正确读出归档记录"，读数错 ⇒ 护栏形同虚设（2026-09-17 那次 651→256 条的教训）。
//
//  **本模块与归档插件同语义**（真源 `tools\dsh-archive-sessions\lib\index.js` L139-275）：
//    · 合并规则 = **分片优先、单文件兜底**；同 id 双源都有 ⇒ 分片赢且**逐字段**取分片值；
//    · 分片文档 version ∉ KNOWN_VERSIONS ⇒ 按"不存在的记录"处理（对齐主包，**不猜**）；
//    · 键两种命名形态都认：裸 uuid（主机现网）与 `session-<uuid>`（分身 home）；
//    · 读侧**绝不创建目录**（新 home 首启前分片目录不存在是正常态）。
//
//  ⚠️ `PROJCACHE_SHARD_KNOWN_VERSIONS` 是**硬编码**的：主包再升世代必须回来加号，
//     否则新一代分片会被当空气（症状与本次修的 bug 一模一样）。
//     挂上游探源的建议见 `docs\交付报告-冲刺600-补restore口径-20261010.md` §10.2③。
//
//  用法：
//    import { readProjcacheSessionsTable, projcacheSessionsTable, findProjcacheRecord,
//             hasProjcacheShard, projcacheShardDir, projcacheLegacyFile,
//             normalizeSessionId, PROJCACHE_KNOWN_VERSIONS } from './lib/projcache-read.mjs'
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// ⚠️ id 归一**不另造第二套**：唯一源 = `tools\lib\archive-meta-store.mjs`（归档插件也从它归一，
//    见 `lib\archive-meta-store.js` 派生副本）⇒ 工具与插件对"同一个会话 id"的判定必须逐字一致。
import { normalizeSessionId as canonNormalizeSessionId } from './archive-meta-store.mjs';

export const PROJCACHE_UNIT = 'session_projcache';
export const PROJCACHE_TABLE = 'sessions';

/**
 * 分片文档 `version` 的**已知世代**集合（与归档插件 `PROJCACHE_SHARD_KNOWN_VERSIONS` 同源）。
 * 实测口径（2026-10-10）：主包现 `version: 7` · 主机现网分片实测 `5` · `6` 留位防误弃。
 * 未知版本按"不存在的记录"处理（与主包 `readRecord` 一致，**不猜**）。
 */
export const PROJCACHE_SHARD_KNOWN_VERSIONS = new Set([5, 6, 7]);
export const PROJCACHE_KNOWN_VERSIONS = PROJCACHE_SHARD_KNOWN_VERSIONS;

/** 会话 id 归一：`session-<uuid>` / 裸 `<uuid>` → `session-<uuid>`；非 uuid 形态回 `null`。 */
export function normalizeSessionId(id) {
  return canonNormalizeSessionId(id);
}

/** 严格判定：是不是合法的会话 id（裸 uuid 或 `session-<uuid>`）。 */
export function isSessionIdLike(id) {
  return normalizeSessionId(id) !== null;
}

/** storages 目录（显式传入 > 由 home 推导）。 */
export function projcacheStoragesDir(home) {
  return path.join(home, 'storages');
}
/** 旧单文件路径（前代形态）。 */
export function projcacheLegacyFile(home) {
  return path.join(projcacheStoragesDir(home), `${PROJCACHE_UNIT}.json`);
}
/** 分片单元目录（per-record 布局的 unit 根）。 */
export function projcacheDir(home) {
  return path.join(projcacheStoragesDir(home), PROJCACHE_UNIT);
}
/** 单条分片文档目录（`<单元>/<表>/`）。 */
export function projcacheShardDir(home) {
  return path.join(projcacheDir(home), PROJCACHE_TABLE);
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 分片文档路径的**候选键**（去重，含原样）：会话 id 的两种命形态都覆盖。
 * 少了任何一侧，同一张表按哪一侧命名就会一半命中一半落空。
 */
export function projcacheShardKeys(sessionId) {
  const norm = normalizeSessionId(sessionId);
  const bare = typeof sessionId === 'string' ? sessionId.replace(/^session-/i, '') : null;
  const out = [];
  for (const k of [sessionId, norm, bare]) {
    if (typeof k === 'string' && k && !out.includes(k)) out.push(k);
  }
  return out;
}

/** 单条分片文档是否"算一条记录"（能解析 + 含 record + version 已知）。 */
export function isValidShardDoc(doc) {
  if (!doc || typeof doc !== 'object') return false;
  const rec = doc.record;
  if (!rec || typeof rec !== 'object') return false;
  return PROJCACHE_SHARD_KNOWN_VERSIONS.has(Number(doc.version));
}

/**
 * 读**一个**分片文档 → 该会话的 record（`{ identity, rows }`），取不到返回 `null`。
 * 只读，**绝不创建目录**。
 */
export function readProjcacheShardRecord(home, sessionId) {
  const dir = projcacheShardDir(home);
  if (!fs.existsSync(dir)) return null;
  for (const key of projcacheShardKeys(sessionId)) {
    const doc = readJsonSafe(path.join(dir, `${key}.json`));
    if (!isValidShardDoc(doc)) continue;
    return doc.record;
  }
  return null;
}

/**
 * 旧单文件的会话表（前代形态）。文件不在/坏了 ⇒ `{}`（与改动前**逐字节同语义**）。
 * 单元名对不上（不是 `session_projcache`）⇒ 也当空，防串表。
 */
export function legacyProjcacheTable(home) {
  const doc = readJsonSafe(projcacheLegacyFile(home));
  if (!doc || typeof doc !== 'object') return {};
  if (doc.unit && doc.unit.name !== undefined && doc.unit.name !== PROJCACHE_UNIT) return {};
  const t = doc?.tables?.[PROJCACHE_TABLE];
  return (t && typeof t === 'object') ? t : {};
}

/**
 * 合并后的会话表：**分片优先、单文件兜底**。
 *
 * 合并规则（同一 id 双源都有 ⇒ 分片赢，且**逐字段**取分片值、缺失字段才用单文件补）：
 *   · 分片是主包当前真源 ⇒ 它的字段才是最新的；
 *   · 单文件里"分片没有的条目"照旧保留 ⇒ 主机现网（单文件空壳）与老 home（只有单文件）
 *     行为都不变，不会因为这次改动丢元数据。
 *
 * @returns {{table: Record<string, any>, shardCount: number, legacyCount: number, source: 'shard'|'legacy'|'none', shardFiles: number, ignoredShardFiles: string[]}}
 *   `source` = `shard`（分片命中 ≥1）｜`legacy`（无分片、单文件有）｜`none`（两处都空）。
 */
export function readProjcacheSessionsTable(home) {
  const legacy = legacyProjcacheTable(home);
  const dir = projcacheShardDir(home);
  const table = {};
  for (const [k, v] of Object.entries(legacy)) table[k] = v;
  let shardCount = 0;
  let shardFiles = 0;
  const ignoredShardFiles = [];
  if (fs.existsSync(dir)) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { files = []; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      shardFiles += 1;
      const key = f.slice(0, -5);
      const doc = readJsonSafe(path.join(dir, f));
      if (!isValidShardDoc(doc)) { ignoredShardFiles.push(f); continue; }
      const rec = doc.record;
      const prev = table[key];
      table[key] = prev ? {
        ...prev,
        ...rec,
        identity: { ...(prev.identity ?? {}), ...(rec.identity ?? {}) },
        rows: { ...(prev.rows ?? {}), ...(rec.rows ?? {}) },
      } : rec;
      shardCount += 1;
    }
  }
  const legacyCount = Object.keys(legacy).length;
  const source = shardCount > 0 ? 'shard' : (legacyCount > 0 ? 'legacy' : 'none');
  return { table, shardCount, legacyCount, source, shardFiles, ignoredShardFiles };
}

/** 只要表的便捷入口（等价于改动前的 `?.tables?.sessions ?? {}`，但**含分片**）。 */
export function projcacheSessionsTable(home) {
  return readProjcacheSessionsTable(home).table;
}

/**
 * 表内按会话 id 取 record，**键两种命名形态都认**（分片文件名与归一 id 可能不同形）。
 * @returns {{key: string, record: any} | null} `key` = 表里实际命中的键（写侧同址要用它）。
 */
export function lookupProjcacheRecord(table, sessionId) {
  if (!table || typeof table !== 'object') return null;
  const norm = normalizeSessionId(sessionId);
  const bare = typeof sessionId === 'string' ? sessionId.replace(/^session-/i, '') : null;
  for (const k of [sessionId, norm, bare, norm ? norm.replace(/^session-/i, '') : null]) {
    if (typeof k !== 'string' || !k) continue;
    const rec = table[k];
    if (rec && typeof rec === 'object') return { key: k, record: rec };
  }
  return null;
}

/**
 * 分片目录是否**已经是**该会话的权威存放处（= 单文件不该再被这条会话改写）。
 * @returns {string|null} 命中的键 or null。
 */
export function hasProjcacheShard(home, sessionId) {
  const dir = projcacheShardDir(home);
  if (!fs.existsSync(dir)) return null;
  for (const k of projcacheShardKeys(sessionId)) {
    if (fs.existsSync(path.join(dir, `${k}.json`))) return k;
  }
  return null;
}

/** 分片目录里"算记录"的键清单（键 = 文件名去 `.json`）。 */
export function listProjcacheShardKeys(home) {
  const dir = projcacheShardDir(home);
  const out = [];
  if (!fs.existsSync(dir)) return out;
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const doc = readJsonSafe(path.join(dir, f));
    if (!isValidShardDoc(doc)) continue;
    out.push(f.slice(0, -5));
  }
  return out;
}

/**
 * 分片 ↔ 单文件 **并集**的 id 集合（判据用）。
 * 判据串：某 id 出现在**任一侧**就算"库里存在该记录"。
 * 删除/写入前证明"读到的记录集 = 分片 ∪ 单文件并集"就用它（配合 `readProjcacheSessionsTable`）。
 */
export function projcacheUnionIds(home) {
  const { table, shardCount, legacyCount } = readProjcacheSessionsTable(home);
  return { ids: Object.keys(table), shardCount, legacyCount, table };
}

/** 该 home 的 projcache 形态（给人看的诊断用）。 */
export function projcacheLayoutOf(home) {
  const dir = projcacheShardDir(home);
  const legacyIn = fs.existsSync(projcacheLegacyFile(home));
  if (!fs.existsSync(dir)) return legacyIn ? 'legacy-only' : 'absent';
  const n = listProjcacheShardKeys(home).length;
  if (n === 0) return legacyIn ? 'legacy-only' : 'shard-empty';
  return legacyIn ? 'shard+legacy' : 'shard-only';
}

// ─────────────────────────────────────────────────────────── 写侧（同址）

/**
 * 判断"该会话的写侧落点"——**与归档插件 `hasProjcacheShard()` 同语义**。
 * @returns {{target:'shard'|'legacy', key:string|null, shardFile:string|null}}
 *   `shard` = 已有分片文档（写它，主包才读得到）；`legacy` = 无分片 ⇒ 回落旧单文件。
 */
export function projcacheWriteTarget(home, sessionId) {
  const key = hasProjcacheShard(home, sessionId);
  if (key) return { target: 'shard', key, shardFile: path.join(projcacheShardDir(home), `${key}.json`) };
  return { target: 'legacy', key: null, shardFile: null };
}

/**
 * **原子写单条分片文档**（读 → 就地改 → 临时文件 + 同盘 rename）。
 *
 * @param home DSH home
 * @param key 分片文件名（不含 `.json`）
 * @param mutate `(doc) => void|false`：就地改 `doc`；返回 `false` 表示"无需写"（跳过）。
 * @returns {{changed:boolean, reason?:string, sha256?:string, version?:number}}
 *   ⚠️ 只改分片文档，**绝不创建/改写旧单文件**（写侧同址铁律）。
 */
export function mutateProjcacheShard(home, key, mutate) {
  const file = path.join(projcacheShardDir(home), `${key}.json`);
  let doc = readJsonSafe(file);
  if (!doc || typeof doc !== 'object') return { changed: false, reason: 'doc-unreadable' };
  if (!PROJCACHE_SHARD_KNOWN_VERSIONS.has(Number(doc.version))) return { changed: false, reason: 'version-unknown' };
  const snapshot = JSON.stringify(doc);
  const ret = mutate(doc);
  if (ret === false) return { changed: false, reason: 'noop' };
  if (typeof doc.record !== 'object' || doc.record === null) return { changed: false, reason: 'record-missing' };
  if (JSON.stringify(doc) === snapshot) return { changed: false, reason: 'noop' };
  const tmp = `${file}.pcw-${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  let verify = null;
  try { verify = JSON.parse(fs.readFileSync(tmp, 'utf8')); } catch { /* fallthrough */ }
  if (!isValidShardDoc(verify) || Number(verify.version) !== Number(doc.version)) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return { changed: false, reason: 'verify-failed' };
  }
  fs.renameSync(tmp, file);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return { changed: true, sha256, version: Number(doc.version) };
}

/**
 * 便捷入口：把某会话分片 record 里的一个字段路径设为值（如 `identity.cwd`）。
 * @returns 同 `mutateProjcacheShard`
 */
export function writeProjcacheShardField(home, key, fieldPath, value) {
  return mutateProjcacheShard(home, key, (doc) => {
    const parts = String(fieldPath).split('.');
    let node = doc.record;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (node[parts[i]] === undefined) node[parts[i]] = {};
      node = node[parts[i]];
      if (!node || typeof node !== 'object') return false;
    }
    const last = parts[parts.length - 1];
    if (node[last] === value) return false;
    node[last] = value;
  });
}

