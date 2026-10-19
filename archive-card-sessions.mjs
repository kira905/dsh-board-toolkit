#!/usr/bin/env node
// archive-card-sessions.mjs — 只归档「看板卡触发的执行会话」中超过 N 小时未活跃的
// 判据：① 该会话 id 出现在 ledger executions[].sessionId ② zstd mtime 距今 >= --hours（默认 6）
//       ③ Host API 未报 running ④ 尾部无未闭合 turn ⑤ 仓2 有字节相同副本（--allow-unsynced 可放开）
// 参数：--hours=N（默认 6） --include-subagents（含卡会话派生的子代理）
//       --all-subagents（含所有 subagent 派生会话，不限根是谁） --allow-unsynced --apply
// 默认 dry-run；--apply 才真移动。移动=两段式（复制→校验字节→删源），写 manifest。
import { readFileSync, statSync, mkdirSync, writeFileSync, cpSync, rmSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { hostRpc, hostRpcJson } from './lib/dsh-rpc-client.mjs';
// 会话日志文件名判据：**唯一真源**（2026-09-24 卡「修·V3判据④」；0.1.5 起 `session.jsonl.zstd`
// → `session.v3.jsonl.zstd`，写死旧名会让本脚本对换代后的活跃树"一个会话都看不见"）。
import { collectSessionFilesByDir, collectSessionFilesInTree, listSessionFilesInDir } from './lib/session-file-name.mjs';
// 元数据库（**唯一读写入口** = 共享件；禁另造第二套读写）：旁路搬移成功后把本批会话写进库。
import { upsertMany as metaUpsertMany, normalizeSessionId } from './lib/archive-meta-store.mjs';
import { zstdDecompressSync } from 'node:zlib';
// zstd 多帧拆帧：**CLI 侧唯一源**（`tools\lib\zstd-frames.mjs`，严格帧结构解析）。
// 原「魔数搜索 + 游标推进」启发式已删除（弱点：压缩数据里恰好出现 magic 字节会把一帧切成两半）。
import { scanZstdFrames } from './lib/zstd-frames.mjs';
import { join, basename, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { SYNCED_SESSIONS_DIR } from './lib/workspace.mjs';
// DSH 数据根：**统一解析**（BUTLER_DSH_HOME > DSH_HOME > ~/.dsh；2026-09-28 · M2 遗留①）。
// 旧写法 `process.env.DSH_HOME || ~/.dsh` 有两个缺口：①不认 BUTLER_DSH_HOME（测试/金丝雀口径分叉）
// ②纯空白取值被当成"已设置"（静默落到 `'   \sessions'`）。**不设变量时与旧口径逐字一致**。
import { resolveDshHome } from './lib/dsh-home.mjs';
// R-065 删除面三件套（2026-10-16 · 锁6）：真删源目录前必须过闸（reparse / 白名单 / 作用域 / 生产判定）。
import { gateDestructive } from './lib/production-guard.mjs';

const ARGS = process.argv.slice(2);
const DRY = !ARGS.includes('--apply');
const ALLOW_UNSYNCED = ARGS.includes('--allow-unsynced');
// R-065 逃生舱：仅当"确实要连 junction 指向的真实数据一起删"时才显式给（留痕）。
const ALLOW_REPARSE = ARGS.includes('--allow-reparse');
const INCLUDE_SUB = ARGS.includes('--include-subagents');
const ALL_SUB = ARGS.includes('--all-subagents');
const HOURS = (() => { const m = ARGS.find(a => a.startsWith('--hours=')); const v = m ? parseFloat(m.split('=')[1]) : 6; return Number.isFinite(v) ? v : 6; })();
const DSH_HOME = resolveDshHome();
const SESS_ROOT = join(DSH_HOME, 'sessions');
const ARCHIVE_BASE = join(DSH_HOME, '_archived-sessions');
const LEDGER = join(DSH_HOME, 'task-board', 'ledger-v2.json');
const SYNCED_REPO = SYNCED_SESSIONS_DIR;
const HOST_API = process.env.DSH_HOST_API_URL || 'http://localhost:3080';
const now = Date.now();

/**
 * 目录内「任一世代尾部未闭合」= 未闭合（保守口径）。
 * 为什么不只看一个文件：两代并存时新世代可能只是补写壳（尾部 `session/end-seed`），
 * 而旧世代尾部才是真回合状态 ⇒ 任一未闭合即不搬，避免误搬未闭合会话。
 * @returns {{unclosed:boolean, last:string|null, decodable:boolean}}
 */
function unclosedIn(files) {
  let decodable = false; let lastType = null;
  for (const f of files) {
    const types = tailTypes(f.file);
    if (types === null) continue; // 该世代不可解 → 由 decodable 汇总裁决
    decodable = true;
    const last = types.at(-1);
    if (last === 'turn/start' || last === 'step/start') return { unclosed: true, last, decodable: true };
    lastType = last;
  }
  return { unclosed: false, last: lastType, decodable };
}
function sha256File(p) { return createHash('sha256').update(readFileSync(p)).digest('hex'); }
function tailTypes(file, nFrames = 8) {
  let buf; try { buf = readFileSync(file); } catch { return null; }
  // 严格帧结构解析（**共享件唯一源**）：只取完整帧；尾部撕裂帧（tornStart）丢弃 —— 残字节一律不当帧解。
  const { frames } = scanZstdFrames(buf);
  if (!frames.length) return null;
  const types = [];
  for (const fr of frames.slice(-nFrames)) {
    let dec; try { dec = zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString('utf8'); } catch { continue; }
    for (const line of dec.split('\n')) { if (!line.trim()) continue; try { const o = JSON.parse(line); if (o && o.type) types.push(o.type); } catch {} }
  }
  return types;
}
/** 只读文件头部若干字节，解出 session 元事件（首帧）。 */
function readSessionMeta(zstdPath) {
  let fd;
  try {
    fd = openSync(zstdPath, 'r');
    // 性能特性**保留不变**：只读前 256KB（会话首帧远小于此，读全量没必要）。
    // 严格解析在**截断尾部**会给 tornStart —— 属预期，这里只取 frames[0]（首帧），截断影响不到它，
    // **不得**因为尾帧撕裂而判本会话不可解。
    const buf = Buffer.alloc(262144);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const b = buf.subarray(0, n);
    const { frames } = scanZstdFrames(b);
    if (!frames.length) return null;
    const first = frames[0];
    const dec = zstdDecompressSync(b.subarray(first.start, first.end)).toString('utf8');
    for (const line of dec.split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o && o.type === 'session') return o; } catch {}
    }
    return null;
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

// ── 元数据库条目采集（旁路搬移接线 · M2 遗留①）──────────────────────────────
// 口径对齐共享件 `tools\lib\archive-meta-store.mjs`（字段名与三态语义写死，**禁另造第二套**）：
//   id / title / cwd / createdAt / turns / lastActiveAt / batch / archivedAt / state / source
//   · `turns` **三态**：>0 真实轮数 / `0` 真实零轮 / **`null` = 未知**（取不到，绝不写 0 冒充）
//   · `title` 取不到写 `null`（≠ 空字符串）；`tokens` 取不到整块省略（不写 0 冒充）
//   · `archivedAt` = 本次搬移时刻（与插件 `collectMetaSnapshot()` 同口径，**不用目录 mtime**）
// 采集时机 = **搬移前**（源目录还在；搬完再采就晚了）；入库时机 = **本批搬移全部结束后一次**
//   （共享件的批量语义：每轮 ≤1 次 RMW）。
// ⚠️ **本函数只读、不写盘、不抛**：库是加速缓存，采集失败只是字段缺，绝不阻断搬移。
// 【B4 · 2026-10-10】projcache 读写口径统一：**分片目录 ∪ 旧单文件**（与归档插件同源）。
//   改动前只读 `<home>/storages/session_projcache.json` ⇒ 0.1.5 分片 home 上恒读到空表
//   ⇒ 每条例目的 `source` 都落 'log-header'（元数据少 title/turns；功能不丢但质量掉）。
import { projcacheSessionsTable } from './lib/projcache-read.mjs';
const PROJCACHE_FILE = join(DSH_HOME, 'storages', 'session_projcache.json');
let _projSessions;
/** projcache 的会话表（惰性读**一次**；**分片 ∪ 单文件**；读不到/坏了 ⇒ 空表，不抛）。 */
function projcacheSessions() {
  if (_projSessions === undefined) {
    try { _projSessions = projcacheSessionsTable(DSH_HOME) ?? {}; }
    catch { _projSessions = {}; }
  }
  return _projSessions;
}

/** 拆帧 → 逐个**完整帧**的字节切片（消费共享件严格解析；返回形状不变 = Buffer 数组）。 */
function framesOf(file) {
  let buf; try { buf = readFileSync(file); } catch { return []; }
  const { frames } = scanZstdFrames(buf);
  return frames.map((fr) => buf.subarray(fr.start, fr.end)); // 尾部撕裂帧不在其中（残字节不当帧）
}

/** 目录内**内容最全**的日志文本（多世代候选链；zstd 逐帧解 / 明文 jsonl 直读）。 */
function logTextInDir(dir) {
  let best = '';
  for (const f of listSessionFilesInDir(dir)) {
    const chunks = [];
    for (const frame of framesOf(f.file)) {
      try { chunks.push(zstdDecompressSync(frame).toString('utf8')); } catch { /* 容忍坏帧 */ }
    }
    const text = chunks.join('');
    if (text.length > best.length) best = text;
  }
  return best;
}

/**
 * 采集一条待归档会话的条目（`id` 传目录名，裸 uuid 也认 —— 共享件内部归一）。
 * 来源优先级：① projcache（搬移前采集，此时记录可能还在）② 日志全帧（title/turns/cwd/createdAt）。
 */
function collectMetaEntry(id, dir, batch, archivedAt) {
  const numOr = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const norm = normalizeSessionId(id);
  const table = projcacheSessions();
  const rec = (norm ? table[norm] : null) ?? table[id] ?? null;
  const title = rec?.rows?.title?.val;
  const entry = {
    id,
    title: (typeof title === 'string' && title.trim()) ? title.trim() : null,
    cwd: rec?.identity?.cwd ?? null,
    createdAt: numOr(rec?.identity?.createdAt),
    turns: numOr(rec?.rows?.sessionStats?.val?.turns),
    lastActiveAt: numOr(rec?.rows?.sessionListMetadata?.val?.lastPromptAt),
    batch,
    archivedAt,
    state: 'archived',
    source: rec ? 'projcache' : 'log-header',
  };
  const totals = rec?.rows?.tokenUsage?.val?.totals;
  if (totals && typeof totals === 'object') {
    const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
    const four = {
      uncachedInputTokens: n(totals.uncachedInputTokens), outputTokens: n(totals.outputTokens),
      cacheReadTokens: n(totals.cacheReadTokens), cacheWriteTokens: n(totals.cacheWriteTokens),
    };
    entry.tokens = { ...four, total: four.uncachedInputTokens + four.outputTokens + four.cacheReadTokens + four.cacheWriteTokens };
  }
  // 日志兜底：projcache 已被裁剪/清空（生产现状是 126 B 空壳）⇒ 首帧 `session` 头给 cwd/createdAt，
  // 全帧再生给 title（最后一个 `session/title`）与 turns（`turn/start` 计数）。
  if (entry.cwd === null || entry.createdAt === null || entry.title === null || entry.turns === null) {
    try {
      const text = logTextInDir(dir);
      let titleFromLog = null, turns = 0, events = 0;
      for (const line of text.split('\n')) {
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (!ev || typeof ev !== 'object' || !ev.type) continue;
        events += 1;
        if (ev.type === 'session') {
          if (entry.cwd === null && ev.cwd) entry.cwd = ev.cwd;
          if (entry.createdAt === null) entry.createdAt = numOr(ev.createdAt);
        } else if (ev.type === 'session/title') {
          const t = ev.data?.title ?? ev.data?.value ?? ev.title;
          if (typeof t === 'string' && t.trim()) titleFromLog = t.trim();
        } else if (ev.type === 'turn/start') { turns += 1; }
      }
      if (entry.title === null && titleFromLog) entry.title = titleFromLog;
      // 日志**可解**（至少解出 1 个事件）才敢断言轮数：解出 0 个 turn/start = 真实零轮（三态里的 `0`），
      // 一句都解不出来 = **未知**（保持 null，绝不写 0 冒充）。
      if (entry.turns === null && events > 0) entry.turns = turns;
      if (!rec && (titleFromLog || events > 0)) entry.source = 'log-full';
    } catch { /* 采集失败只丢字段，不阻断搬移 */ }
  }
  return entry;
}

/** 沿 parentSession 链上溯到根会话 id（根 = 没有 parentSession 的那个）。 */
function rootOf(id, meta, seen = new Set()) {
  if (seen.has(id)) return id;
  seen.add(id);
  const m = meta.get(id);
  if (!m || !m.parentSession) return id;
  return rootOf(m.parentSession, meta, seen);
}

async function fetchRunningIds() {
  // 0.1.5 换线（2026-09-22）：旧 POST /api/session.list 已 404/401 → 走共享适配层
  const { status, body: j } = await hostRpc(HOST_API, 'session.list', {}, { timeoutMs: 20_000 });
  if (j?.result === undefined) throw new Error(`session.list HTTP ${status}`);
  const items = j?.result?.value?.items ?? [];
  return { running: new Set(items.filter(x => x && x.running === true).map(x => x.sessionId)), total: items.length };
}

// ---- 1. 卡触发会话集合 ----
const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
const cardSessions = new Map(); // sessionId -> { titles:Set, statuses:Set }
for (const c of (ledger.tasks || [])) {
  for (const e of (c.executions || [])) {
    if (!e || !e.sessionId) continue;
    const k = String(e.sessionId);
    if (!cardSessions.has(k)) cardSessions.set(k, { titles: new Set(), statuses: new Set(), endedAt: [] });
    const rec = cardSessions.get(k);
    rec.titles.add(c.title); rec.statuses.add(c.status);
    if (e.endedAt) rec.endedAt.push(e.endedAt);
  }
}
console.log(`=== 卡触发会话归档扫描 ===`);
console.log(`账本: ${LEDGER}  revision=${ledger.revision} 卡数=${(ledger.tasks || []).length}`);
console.log(`卡 executions 里的不同 sessionId: ${cardSessions.size}`);
console.log(`判据: mtime >= ${HOURS}h 未活跃 且 尾部无未闭合 turn 且 非 running` + (ALLOW_UNSYNCED ? '（已放开「必须过河」）' : ' 且 仓2 有字节相同副本') + (ALL_SUB ? '；范围=所有 subagent 派生会话（含手工会话派生）' : INCLUDE_SUB ? '；范围含卡会话派生的 subagent 会话' : ''));
console.log(`模式: ${DRY ? 'DRY-RUN（不移动）' : '**实际移动**'}`);

// ---- 2. running 集合 ----
let running = new Set(); let hardStop = false;
try {
  const r = await fetchRunningIds();
  running = r.running;
  console.log(`Host API: 会话共 ${r.total} 个，其中 running ${running.size} 个（排除）`);
} catch (e) {
  hardStop = true;
  console.error(`!! 取 running 失败（${e.message}）→ fail-closed，本次不移动任何文件。`);
}

// ---- 3. 仓2 索引（是否已过河）----
const repoIndex = new Map();
if (existsSync(SYNCED_REPO)) {
  // 键 = **会话目录**的相对路径（不是文件路径）：换代后本地与仓里可能各持不同世代，
  // 按目录对齐才认得出「同一个会话」，再比对该目录「当前那份」的字节。
  for (const s of collectSessionFilesByDir(SYNCED_REPO)) {
    repoIndex.set(relative(SYNCED_REPO, s.dir).replace(/\\/g, '/'), s.current);
  }
}
console.log(`仓2 副本索引: ${repoIndex.size} 个会话目录（每会话取当前那份）`);

// ---- 4. 扫描 sessions ----
const here = new Set(); // 当前 sessions 里的会话 id
const cand = [], skipActive = [], skipRunning = [], skipUnclosed = [], skipUnsynced = [], skipFail = [];
const allSessions = collectSessionFilesByDir(SESS_ROOT);
const meta = new Map();
if (INCLUDE_SUB || ALL_SUB) {
  for (const s of allSessions) { const m = readSessionMeta(s.current); if (m) meta.set(basename(s.dir), m); }
  console.log(`会话元信息（首帧）: ${meta.size} 个；其中 subagent 派生 ${[...meta.values()].filter(m => m.origin === 'subagent').length} 个`);
}
for (const sess of allSessions) {
  const dir = sess.dir;
  const currentPath = sess.current;
  const id = basename(dir);
  here.add(id);
  let derivedFrom = null;
  if (!cardSessions.has(id)) {
    if (ALL_SUB) {
      const m = meta.get(id);
      if (!(m && m.origin === 'subagent')) continue; // 只收子代理会话（不论根是谁）
      derivedFrom = rootOf(id, meta);
    } else if (INCLUDE_SUB) {
      const root = rootOf(id, meta);
      if (!cardSessions.has(root)) continue; // 上溯到根仍不是卡会话 → 不碰
      derivedFrom = root;
    } else {
      continue; // 非卡触发 → 不碰
    }
  }
  const st = statSync(currentPath);
  const mb = st.size / 1048576;
  const ageH = (now - st.mtimeMs) / 3600000;
  const info = cardSessions.get(id) || cardSessions.get(derivedFrom) || { titles: new Set(['(手工会话派生的子代理)']), statuses: new Set(['-']) };
  const titles = [...info.titles].slice(0, 2).join(' / ');
  if (ageH < HOURS) { skipActive.push({ id, ageH, mb, titles }); continue; }
  if (running.has(id)) { skipRunning.push({ id, ageH, mb, titles }); continue; }
  const tail = unclosedIn(sess.files);
  if (!tail.decodable) { skipFail.push({ id, ageH, mb, titles, why: '日志不可解' }); continue; }
  if (tail.unclosed) { skipUnclosed.push({ id, ageH, mb, titles, last: tail.last }); continue; }
  const rel = relative(SESS_ROOT, dir).replace(/\\/g, '/');
  let synced = false, whyUn = '未过河(仓里没有)';
  const rp = repoIndex.get(rel);
  if (rp) {
    if (statSync(rp).size === st.size && sha256File(rp) === sha256File(currentPath)) synced = true;
    else whyUn = '未过河(仓里是旧版)';
  }
  if (!synced && !ALLOW_UNSYNCED) { skipUnsynced.push({ id, ageH, mb, titles, why: whyUn }); continue; }
  cand.push({ dir, id, mb, ageH, titles, synced, derived: !!derivedFrom, root: derivedFrom, statuses: [...info.statuses].join(','), last: tail.last });
}

cand.sort((a, b) => b.mb - a.mb);
console.log(`\n--- 命中待归档: ${cand.length} 个（其中 subagent 派生 ${cand.filter(c => c.derived).length} 个），共 ${cand.reduce((s, x) => s + x.mb, 0).toFixed(1)} MB ---`);
for (const c of cand.slice(0, 40)) {
  console.log(`  [${c.mb.toFixed(2)}MB ${c.ageH.toFixed(1)}h ${c.synced ? '已过河' : '未过河!'} ${c.derived ? '派生←' + c.root : c.statuses}] ${c.id}  «${c.titles}»`);
}
if (cand.length > 40) console.log(`  ...另有 ${cand.length - 40} 个`);
console.log(`\n保留: 太新(<${HOURS}h) ${skipActive.length} · 无未闭合turn ${skipUnclosed.length} · running ${skipRunning.length} · 未过河(剪枝) ${skipUnsynced.length} · 不可解 ${skipFail.length}`);
if (skipUnclosed.length) { console.log('未闭合样例:'); for (const s of skipUnclosed.slice(0, 5)) console.log(`  [${s.ageH.toFixed(1)}h] ${s.id} 尾=${s.last} «${s.titles}»`); }
if (skipUnsynced.length) { console.log('未过河样例（未归档）:'); for (const s of skipUnsynced.slice(0, 10)) console.log(`  [${s.mb.toFixed(2)}MB ${s.ageH.toFixed(1)}h] ${s.id} ${s.why} «${s.titles}»`); }
if (skipActive.length) { console.log('太新样例:'); for (const s of skipActive.slice(0, 5)) console.log(`  [${s.ageH.toFixed(2)}h] ${s.id} «${s.titles}»`); }

// 账本里有、但 sessions 里已经不存在的卡会话（早前归档/删除）
const missing = [...cardSessions.keys()].filter(id => !here.has(id));
const archDirs = collectSessionFilesInTree(ARCHIVE_BASE).map((p) => basename(dirname(p)));
const archSet = new Set(archDirs);
let inArch = 0; const noWhere = [];
for (const id of missing) { if (archSet.has(id)) inArch++; else noWhere.push(id); }
console.log(`\n卡会话不在 sessions 现存目录: ${missing.length}（其中已在 _archived-sessions: ${inArch}；哪儿都找不到: ${noWhere.length}）`);

if (DRY || hardStop) {
  console.log(`\n${hardStop ? 'fail-closed：' : 'DRY-RUN：'}未移动任何文件。`);
  process.exitCode = hardStop ? 3 : 0;
} else {
  const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ARCHIVE_ROOT = join(ARCHIVE_BASE, STAMP);
  mkdirSync(ARCHIVE_ROOT, { recursive: true });
  const manifest = []; let moved = 0, skipped = 0;
  // 元数据库（M2 遗留①）：本批**搬移成功**的会话快照 —— 循环内只压内存，轮末一次写库
  const archivedAt = Date.now();
  const metaSnapshots = [];
  for (const c of cand) {
    const dest = join(ARCHIVE_ROOT, basename(c.dir));
    try {
      // 元数据快照必须在**搬移前**采集（源目录马上要被删）——采集本身绝不阻断搬移
      let metaSnapshot = null;
      try { metaSnapshot = collectMetaEntry(c.id, c.dir, STAMP, archivedAt); } catch { metaSnapshot = null; }
      cpSync(c.dir, dest, { recursive: true, force: true });
      // 逐文件校验（**认全世代**）：两代并存时旧名与新名都要比 —— 只比一个文件名会漏掉另一世代的复制损坏。
      const srcFiles = listSessionFilesInDir(c.dir);
      if (!srcFiles.length) throw new Error('source dir has no session file');
      let anyDecodable = false;
      for (const f of srcFiles) {
        const relName = relative(c.dir, f.file);
        const dstFile = join(dest, relName);
        if (!existsSync(dstFile)) throw new Error(`dest missing ${relName}`);
        const srcBytes = statSync(f.file).size;
        const dstBytes = statSync(dstFile).size;
        if (srcBytes !== dstBytes) throw new Error(`size mismatch ${relName} (${srcBytes} vs ${dstBytes})`);
        if (sha256File(f.file) !== sha256File(dstFile)) throw new Error(`sha mismatch ${relName}`);
        // 既有语义保留：源可解的世代，复制产物也必须可解（否则视为复制失败 → SKIP 且不动源）
        if (tailTypes(f.file) !== null) {
          anyDecodable = true;
          if (tailTypes(dstFile, 1) === null) throw new Error('dest not decodable');
        }
      }
      if (!anyDecodable) throw new Error('dest not decodable');
      // ── R-065 删除面三件套（2026-10-16 · 锁6）：删源目录前过闸 ──
      // ① reparse 拒删（2026-09-09 生图历史永久损失就是"跟 junction 一起删"的形态）
      // ② 白名单锁死 <DSH_HOME>\sessions：本脚本只准删业务根之下的会话目录，跑出范围即拒
      // ③ 作用域点明 file 面；dry-run 由上方 `if (DRY || hardStop)` 提前返回（本行只在真跑路径上）
      // ④ 生产判定：本分支已被显式 `--apply` 放行 ⇒ 以 allowProduction 承接该"显式"语义
      // 被拒 ⇒ throw ⇒ 落到下方 catch：记 SKIP、**源目录不动**、其余会话照常继续（fail-closed 不炸整批）。
      const dg = gateDestructive({
        targets: [{ path: c.dir, label: c.id }], whitelist: [SESS_ROOT], op: '删',
        scope: ['file'], requires: ['file'], dryRun: false,
        allowProduction: true, allowReparse: ALLOW_REPARSE,
        reason: `归档后删源目录 ${c.id}`,
      });
      if (!dg.ok) throw new Error(`R-065 拒绝（${dg.code}）`);
      rmSync(c.dir, { recursive: true, force: true });
      manifest.push({ sessionId: c.id, from: c.dir, to: dest, mb: c.mb, ageH: Number(c.ageH.toFixed(2)), titles: c.titles, derived: c.derived, root: c.root });
      // **文件已成功落到归档区**（校验通过 + 源已删）才收快照 ⇒ 跳过/失败的那条不入库
      if (metaSnapshot) metaSnapshots.push(metaSnapshot);
      moved++;
    } catch (e) {
      skipped++; console.log(`  SKIP ${basename(c.dir)} — ${e.message}`);
    }
  }
  const mf = join(ARCHIVE_ROOT, 'manifest.json');
  writeFileSync(mf, JSON.stringify({ kind: 'card-sessions-archive', stamp: STAMP, hours: HOURS, moved, entries: manifest }, null, 2), 'utf8');
  console.log(`已归档: ${moved} 个 → ${ARCHIVE_ROOT}（失败 ${skipped}）`);
  console.log(`合计 ${manifest.reduce((s, x) => s + x.mb, 0).toFixed(1)} MB，清单: ${mf}`);

  // ── 元数据库接线（M2 遗留① · 旁路搬移）─────────────────────────────────────
  //  判据：**只有真搬移成功**（归档区已落文件、源目录已删）的会话才入库；跳过/失败不写。
  //  `--dry-run`（DRY）与 fail-closed（hardStop）在上一分支就结束了，**永不进这里** ⇒ dry-run 零写库。
  //  fail-soft：写库失败只打一行 warning，**不改搬移结果、不置非零退出码**（旁路失败不拖垮归档）。
  //  ⚠️ **不传 `counters`**：插件的写失败计数宿主在 `_archived-sessions\.auto-archive.json`（本脚本无权代管），
  //     透传会把它的 `writeFailedStreak` 抹成 0；不传则共享件按 `before.state` 原样保留。
  if (metaSnapshots.length > 0) {
    try {
      const w = metaUpsertMany(ARCHIVE_BASE, metaSnapshots);
      if (w.ok) {
        console.log(`元数据库: 写入 ${w.written} 条（新建 ${w.created} / 更新 ${w.updated}` +
          `${w.skipped ? ` / 跳过非 id 名 ${w.skipped}` : ''}${w.unchanged ? ' · 幂等无变化' : ''}）`);
      } else {
        console.warn(`[warning] 元数据库写入失败（${w.reason}${w.detail ? ': ' + w.detail : ''}）` +
          `—— **不影响本次搬移结果**；面板元数据将回落到 projcache/日志（读侧惰性补写兜底）。`);
      }
    } catch (e) {
      console.warn(`[warning] 元数据库写入异常（${e?.message ?? e}）—— 不影响本次搬移结果。`);
    }
  }
}
