// ══════════════════════════════════════════════════════════════════════════
//  archive-meta-store.mjs —— 归档会话元数据库（加速缓存）· **唯一源**
//  ---------------------------------------------------------------
//  方案：docs\归档会话元数据库-方案-20260920.md（v2 · 过审范围受限）
//        §4.1 库结构 · §4.3-② 返回契约 · §4.5 回填 · §5.2 共享件机制
//
//  定位：库 = **加速缓存**，**不是**权威源。权威源 = append-only 会话日志
//        （`session.jsonl.zstd` 里的 `session/title` / `turn/start` 事件）。
//        库全丢 ≠ 元数据丢；库存在的意义 = ①省掉每次列表全帧解压 ②承载投影
//        专有字段（token/goal）的快照 ③给已物理删除的会话留墓碑。
//
//  ⚠️ 派生副本：`tools/dsh-archive-sessions/lib/archive-meta-store.js`
//     由 `tools/sync-host-adapter.mjs` 生成（目标表 `archive-sessions-meta-store-esm`）。
//     **改接口请改本文件**——手改副本会被下一次同步覆盖，且被 check-decoupling 的
//     R5 判为违规（副本 sha ≠ 唯一源）。
//     本文件必须**自包含**（只用 node: 内置模块），因为派生副本要单独拷进插件实体。
//
//  硬约束（R2-1/E2，照 dsh-butler/lib/store.mjs 的既有契约）：
//   · tmp 唯一：`<file>.<pid>.<rand>.tmp`（禁用固定名 `file + '.tmp'`）
//   · 写前 fsync + rename + 有限重试；失败**保留 tmp 并抛错**（绝不退化为直写目标）
//   · RMW 串行：进程内 + **跨进程独占锁**（flag:'wx' 原子建锁，禁 TOCTOU；TTL + pid 存活兜底）
//   · **损坏 ⇒ fail-closed**（绝不把"损坏"当"空库"覆盖——那正是 9/17 事故的重演动作）
//   · `.bak` 落**归档区之外**（`<home>/backups/archive-meta/`，保留 3 份）
// ══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/** 共享件版本（进派生副本头，便于跨机核对）。 */
export const VERSION = '1.0.0'
/** 库的 schema 版本（bump 后旧库读法见 §4.3-② 的 version-mismatch 分支）。 */
export const SCHEMA_VERSION = 1
/** 写入者标识（写进库文件，便于归因）。 */
export const WRITTEN_BY = 'dsh-archive-sessions'
/** 库文件名（放归档根，与批次目录平级）。 */
export const STORE_FILE_NAME = 'archive-meta.json'
/** `.bak` 目录名（在 `<home>/backups/` 下）。 */
export const BACKUP_DIR_NAME = 'archive-meta'
/** 环境变量：覆盖 `.bak` 落点（测试/隔离环境用）。 */
export const BACKUP_DIR_ENV = 'ARCHIVE_META_BACKUP_DIR'
/** `.bak` 保留份数（R2-7 / d6）。 */
export const BACKUP_KEEP = 3
/** 锁文件名（与库同目录；瞬时文件，整目录硬删也不影响正确性）。 */
export const LOCK_FILE_NAME = '.archive-meta.lock'

const UUID_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** **唯一 id 判定常量**（全生态同源，R2-8）：严格形态 `session-<uuid>`。 */
export const ID_RE = new RegExp(`^session-${UUID_SRC}$`, 'i')
const BARE_UUID_RE = new RegExp(`^${UUID_SRC}$`, 'i')

const CONTENDED_CODES = new Set(['EEXIST', 'EPERM', 'EACCES'])
const FRESH_LOCK_MS = 1500
const DEFAULT_LOCK_TTL_MS = 30_000
const DEFAULT_LOCK_WAIT_MS = 8_000
/** 可接受的会话条目状态（§4.4 状态机）。 */
export const ENTRY_STATES = Object.freeze(['archived', 'restored', 'deleted', 'restoring'])
/** 计入「库内 M」的状态（R2-D1 甲案：墓碑不进分子）。 */
export const LIVE_STATES = Object.freeze(['archived', 'restoring'])

// 同步 sleep：优先 Atomics.wait（零 CPU 占用），退化到忙等。锁等待在高争用时可达数秒，
// 用忙等会把 CPU 烧在自旋上（store.mjs 的 sleepSync 同款取舍）。
const sleepSync = (ms) => {
  const wait = Math.max(0, Math.floor(ms))
  if (wait <= 0) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
  } catch {
    const end = Date.now() + wait
    while (Date.now() < end) { /* spin */ }
  }
}
const randomToken = () => crypto.randomBytes(4).toString('hex')

/** 原子写失败（保留 tmp，绝不退化为直写目标）。 */
export class AtomicWriteError extends Error {
  constructor(file, tmp, attempts, cause) {
    super(`原子写失败：${file}（tmp=${tmp}，尝试 ${attempts} 次，原因 ${cause}）`)
    this.name = 'AtomicWriteError'
    this.file = file
    this.tmp = tmp
    this.attempts = attempts
  }
}

// ─────────────────────────────────────────────────────────── id 口径

/** 严格形态判定（`session-<uuid>`）。 */
export function isStrictSessionId(id) {
  return ID_RE.test(String(id ?? ''))
}

/**
 * 归一 id（R2-8/R2-10）：`session-<uuid>` ∪ 裸 `<uuid>` → `session-<uuid>`（统一小写）。
 * 非 uuid 形态（如 `session-permverify-xxx` 测试残留目录）⇒ **null**（调用方跳过 + 报告单列）。
 *
 * ⚠️ **本函数是生态唯一源**（2026-10-10 · 卡 B4 加注）：归档插件从 `lib\archive-meta-store.js`（本文件的派生副本）
 * 归一，`tools\lib\projcache-read.mjs` 也直接 re-export 本函数 ⇒ 改这里会同时影响**插件读侧**与
 * 那批 projcache 独立工具。请勿在别处另造第二套 id 判定。
 */
export function normalizeSessionId(id) {
  const s = String(id ?? '').trim()
  if (!s) return null
  if (ID_RE.test(s)) return s.toLowerCase()
  if (BARE_UUID_RE.test(s)) return ('session-' + s).toLowerCase()
  return null
}

// ─────────────────────────────────────────────────────────── 路径

/** 库文件绝对路径（root = 归档根，即 `~/.dsh/_archived-sessions`）。 */
export function storeFile(root) {
  return path.join(String(root), STORE_FILE_NAME)
}

/**
 * `.bak` 目录（**归档区之外**，R2-7）：`ARCHIVE_META_BACKUP_DIR` > `<root 的父目录>/backups/archive-meta`
 * （= `<DSH_HOME>/backups/archive-meta`，随 DSH_HOME 走 ⇒ 沙箱/隔离环境自动隔离）。
 */
export function backupDir(root, env = process.env) {
  const override = env && env[BACKUP_DIR_ENV] && String(env[BACKUP_DIR_ENV]).trim()
  if (override) return path.resolve(String(override).trim())
  return path.join(path.dirname(path.resolve(String(root))), 'backups', BACKUP_DIR_NAME)
}

/** 现存 `.bak` 列表（新 → 旧）。 */
export function backupFiles(root, env = process.env) {
  const dir = backupDir(root, env)
  if (!fs.existsSync(dir)) return []
  let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names
    .filter((n) => n.startsWith('archive-meta-') && n.endsWith('.json.bak'))
    .map((n) => {
      const full = path.join(dir, n)
      let mtime = 0
      try { mtime = fs.statSync(full).mtimeMs } catch { /* skip */ }
      return { file: full, name: n, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

// ─────────────────────────────────────────────────────────── 读

/** 空库骨架（写路径与 missing 态共用）。 */
function emptyStore() {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: Date.now(),
    writtenBy: WRITTEN_BY,
    state: {
      writeFailedTotal: 0,
      writeFailedStreak: 0,
      lastWriteAt: null,
      lastWriteError: null,
      corruptDetectedAt: null,
    },
    sessions: {},
  }
}

/** 库结构校验（**拆开"不存在"与"损坏"**，R2-1）。 */
function validateStore(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'top-level-not-object'
  const ver = data.schemaVersion
  if (!Number.isFinite(Number(ver))) return 'schemaVersion-missing'
  if (!data.sessions || typeof data.sessions !== 'object' || Array.isArray(data.sessions)) return 'sessions-not-object'
  return null
}

/**
 * 读库（**唯一读入口**，插件不得再用 `readJsonSafe` 读库）。
 *
 * 返回四态（§4.3-②，写死）：
 *   `{ok:true,  sessions, reason:'ok'}`                  正常
 *   `{ok:true,  sessions:{}, reason:'missing'}`          文件不存在（首跑/新机/刚删库）⇒ 视为空库，**允许写**
 *   `{ok:false, reason:'corrupt', detail, file}`         解析失败/结构不符 ⇒ **写侧 fail-closed**
 *   `{ok:false, reason:'version-mismatch', found, expected}` schemaVersion 更高且无迁移 ⇒ fail-closed
 *
 * ⚠️ **本函数是纯读，绝不写盘**（`.bak` 恢复是显式动作：`recoverFromBackup()`，
 *    由读侧检出 corrupt 后调用一次，见 §4.3-② 的「尝试从 .bak 恢复」落点）。
 */
export function readStore(root) {
  const file = storeFile(root)
  if (!fs.existsSync(file)) {
    return { ok: true, sessions: {}, reason: 'missing', file, schemaVersion: SCHEMA_VERSION }
  }
  let raw = null
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return { ok: false, reason: 'corrupt', detail: 'unreadable: ' + (e?.message ?? e), file }
  }
  // 0 字节 / 全空白：主包生态把"空状态文件"当"尚无状态"（见 store.mjs L221）⇒ 归 missing，不归 corrupt
  if (!raw.trim()) return { ok: true, sessions: {}, reason: 'missing', file, schemaVersion: SCHEMA_VERSION }
  let data = null
  try {
    data = JSON.parse(raw)
  } catch (e) {
    return { ok: false, reason: 'corrupt', detail: 'json-parse: ' + (e?.message ?? e), file }
  }
  const bad = validateStore(data)
  if (bad) return { ok: false, reason: 'corrupt', detail: 'structure: ' + bad, file }
  const found = Number(data.schemaVersion)
  if (found > SCHEMA_VERSION) {
    return { ok: false, reason: 'version-mismatch', found, expected: SCHEMA_VERSION, file }
  }
  if (found < SCHEMA_VERSION) {
    return { ok: false, reason: 'corrupt', detail: 'structure: schemaVersion-too-old(' + found + ')', file }
  }
  const sessions = {}
  for (const [k, v] of Object.entries(data.sessions)) {
    const id = normalizeSessionId(k)
    if (!id || !v || typeof v !== 'object') continue
    sessions[id] = v
  }
  return {
    ok: true,
    sessions,
    reason: 'ok',
    file,
    schemaVersion: found,
    updatedAt: Number(data.updatedAt) || null,
    state: (data.state && typeof data.state === 'object') ? data.state : emptyStore().state,
  }
}

/** 读结果 → 对外状态词（§7-② 写进 API 响应与面板）。 */
export function stateOf(readResult) {
  if (!readResult) return 'missing'
  if (readResult.ok) return readResult.reason === 'missing' ? 'missing' : 'ok'
  if (readResult.reason === 'version-mismatch') return 'version-mismatch'
  return 'corrupted'
}

/** 库里那一份条目（归一 id 查；库损坏/缺条目 ⇒ null）。 */
export function resolveMeta(root, id) {
  const sid = normalizeSessionId(id)
  if (!sid) return null
  const r = readStore(root)
  if (!r.ok) return null
  return r.sessions[sid] ?? null
}

/** 库内「M」口径：`state ∈ {archived, restoring}` 的条目数（墓碑不计，R2-D1 甲案）。 */
export function countMetaEntries(sessions, states = LIVE_STATES) {
  const allow = new Set(states)
  let n = 0
  for (const v of Object.values(sessions ?? {})) {
    const st = v && typeof v === 'object' ? (v.state ?? 'archived') : 'archived'
    if (allow.has(st)) n += 1
  }
  return n
}

// ─────────────────────────────────────────────────────────── 写（原子 + 锁）

function atomicWriteJson(file, data, opts = {}) {
  const text = JSON.stringify(data, null, 2) + '\n'
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${randomToken()}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, text, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  // 测试钩子：rename 之前挂起（验"中途 kill ⇒ 目标仍是旧完整内容" / 计写次数）
  if (opts.hooks && typeof opts.hooks.beforeRename === 'function') opts.hooks.beforeRename(tmp, file)
  const delays = Array.isArray(opts.retryDelaysMs) ? opts.retryDelaysMs : [50, 150, 400]
  let lastErr = null
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      fs.renameSync(tmp, file)
      return { ok: true, file, bytes: Buffer.byteLength(text, 'utf8'), attempts: attempt + 1, tmp }
    } catch (e) {
      lastErr = e
      if (attempt < delays.length) sleepSync(delays[attempt])
    }
  }
  // 绝不退化为直写目标：保留 tmp 抛错（下次写入会覆盖它）
  throw new AtomicWriteError(file, tmp, delays.length + 1, `${lastErr?.code ?? ''} ${lastErr?.message ?? lastErr}`)
}

function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try { process.kill(n, 0); return true } catch (e) { return e?.code === 'EPERM' }
}

function releaseLock(lockPath, pid) {
  try {
    const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    if (Number(cur?.pid) === Number(pid)) fs.rmSync(lockPath, { force: true })
  } catch { /* 已被抢占/已释放 */ }
}

/**
 * 跨进程独占锁（照 store.mjs L294-334 的竞争/抢占语义，**禁 TOCTOU**）。
 * `waitMs <= 0` ⇒ 抢不到立即返回 `{ok:false, reason:'held'}`。
 */
function withLock(root, opts, fn) {
  const lockPath = path.join(String(root), LOCK_FILE_NAME)
  fs.mkdirSync(String(root), { recursive: true })
  const ttlMs = Number.isFinite(Number(opts.lockTtlMs)) ? Math.max(1000, Number(opts.lockTtlMs)) : DEFAULT_LOCK_TTL_MS
  const waitMs = Number.isFinite(Number(opts.lockWaitMs)) ? Math.max(0, Number(opts.lockWaitMs)) : DEFAULT_LOCK_WAIT_MS
  const data = { pid: process.pid, startedAt: Date.now(), ttl: ttlMs, kind: 'archive-meta' }
  const deadline = Date.now() + waitMs
  let takeovers = 0
  for (;;) {
    let acquired = false
    try {
      fs.writeFileSync(lockPath, JSON.stringify(data), { flag: 'wx' })
      acquired = true
    } catch (e) {
      if (!CONTENDED_CODES.has(e?.code)) throw e
    }
    if (acquired) {
      try {
        return fn()
      } finally {
        releaseLock(lockPath, data.pid)
      }
    }
    let st = null
    try { st = fs.statSync(lockPath) } catch { st = null }
    if (!st) continue // 持有者刚释放 ⇒ 立即重试（绝不在这里删锁）
    let cur = null
    try { cur = JSON.parse(fs.readFileSync(lockPath, 'utf8')) } catch { cur = null }
    const holderAge = cur ? Date.now() - Number(cur.startedAt ?? 0) : null
    const ttl = Number(cur?.ttl ?? ttlMs)
    const fileAge = Date.now() - st.mtimeMs
    const byTtl = cur
      ? (!Number.isFinite(holderAge) || holderAge > ttl)
      : fileAge > FRESH_LOCK_MS
    // pid 存活兜底：持有者进程已死 ⇒ 即便没到 TTL 也视为失效
    const byPid = cur ? !pidAlive(cur.pid) : false
    if (byTtl || byPid) {
      if (++takeovers > 50) return { ok: false, reason: 'takeover-thrash', holder: cur }
      try { fs.rmSync(lockPath, { force: true }) } catch { /* 竞争失败，下一轮再试 */ }
      continue
    }
    if (waitMs <= 0) return { ok: false, reason: 'held', holder: cur }
    if (Date.now() >= deadline) return { ok: false, reason: 'locked', holder: cur }
    sleepSync(10 + Math.floor(Math.random() * 20))
  }
}

function stampOf(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** `.bak` 轮转：保留最近 BACKUP_KEEP 份（按 mtime 删最旧）。 */
function rotateBackups(root, env, keep = BACKUP_KEEP) {
  const list = backupFiles(root, env)
  for (const item of list.slice(Math.max(0, keep))) {
    try { fs.rmSync(item.file, { force: true }) } catch { /* best effort */ }
  }
}

/**
 * 落盘：**先写 `.bak`（当前库副本）→ 再原子替换正本**（§4.1-⑤ 的顺序，写死）。
 * `.bak` 目录不存在则递归创建（U7：实测 `~/.dsh/backups` 整体不存在，缺这步会把
 * "备份失败"放大成"整轮写库失败"）。
 */
function commit(root, store, opts) {
  const file = storeFile(root)
  const dir = backupDir(root, opts.env)
  fs.mkdirSync(dir, { recursive: true })
  if (fs.existsSync(file)) {
    const bak = path.join(dir, `archive-meta-${stampOf()}-${randomToken()}.json.bak`)
    try {
      fs.copyFileSync(file, bak)
      rotateBackups(root, opts.env)
    } catch (e) {
      throw new Error('备份写失败（正本未替换）：' + (e?.message ?? e))
    }
  }
  return atomicWriteJson(file, store, opts)
}

// ─────────────────────────────────────────────────────────── 合并语义

/**
 * 条目合并（§4.2.1「同 id 多目录」U3 整改 + §4.4 生命周期）：
 *  · **id 复用（同 id 不同生命周期）**：`createdAt` 与库中已有条目不同（且都非空）⇒ 整条覆写；
 *  · **同 id 同生命周期**：字段级合并；`archivedAt` 取**最近一次**（同刻取批名较大），`batch` 随之；
 *  · `restored`/`deleted` 后**再次归档** ⇒ 条目覆写回 `archived`（清 restoredAt/deletedAt）。
 */
function mergeEntry(cur, incoming) {
  const now = Date.now()
  const sameLife = cur && Number.isFinite(Number(cur.createdAt)) && Number.isFinite(Number(incoming.createdAt))
    ? Number(cur.createdAt) === Number(incoming.createdAt)
    : true
  // ⚠️ 必须在字段覆盖**之前**记下旧值：覆盖后 `next.archivedAt` 已是 incoming 的值，
  //    拿它比大小必然恒真（首版 bug：三次写 1000/2000/1500 会错记 1500）。
  const curArchivedAt = sameLife ? Number(cur?.archivedAt) : NaN
  const curBatch = sameLife ? cur?.batch : undefined
  const next = sameLife ? { ...(cur ?? {}) } : {}
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue
    if (k === 'id') continue
    // null = **未知/取不到**（≠ 空字符串）；显式 null 也照写，读侧据此走兜底
    next[k] = v
  }
  const incAt = Number(incoming.archivedAt)
  // `archivedAt` 记**最近一次**（同 id 多目录口径，U3 整改）：大者胜，小者不覆盖
  if (Number.isFinite(incAt) && (!Number.isFinite(curArchivedAt) || incAt >= curArchivedAt)) {
    next.archivedAt = incAt
    if (incoming.batch !== undefined) next.batch = incoming.batch
  } else if (Number.isFinite(curArchivedAt)) {
    next.archivedAt = curArchivedAt
    if (curBatch !== undefined) next.batch = curBatch
  } else if (!Number.isFinite(Number(next.archivedAt))) {
    next.archivedAt = now
  }
  next.state = incoming.state ?? (sameLife ? (cur?.state ?? 'archived') : 'archived')
  if (next.state === 'archived') {
    delete next.restoredAt
    delete next.deletedAt
  }
  if (next.turns !== null && next.turns !== undefined) {
    const t = Number(next.turns)
    next.turns = Number.isFinite(t) ? t : null
  } else {
    next.turns = null
  }
  return next
}

// ─────────────────────────────────────────────────────────── 写入口

/**
 * 批量写（**RMW + 原子替换**，§4.2-① 的批量语义：整批采集 → 轮末一次 ⇒ 每轮 ≤1 次 RMW）。
 * @param {string} root 归档根
 * @param {Array<object>} entries 每条必须含 `id`（严格/裸 uuid 皆可，内部归一）
 * @param {{hooks?:object, env?:object, counters?:object, now?:number, lockWaitMs?:number}} [opts]
 * @returns {{ok:true, written:number, created:number, updated:number, skipped:number, unchanged:boolean}
 *          |{ok:false, reason:string, detail?:string, written:0, failClosed?:boolean}}
 */
export function upsertMany(root, entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : []
  const valid = []
  let skipped = 0
  for (const e of list) {
    const id = e && typeof e === 'object' ? normalizeSessionId(e.id) : null
    if (!id) { skipped += 1; continue }
    valid.push({ ...e, id })
  }
  if (!valid.length) return { ok: true, written: 0, created: 0, updated: 0, skipped, unchanged: true }

  const run = withLock(root, opts, () => {
    const before = readStore(root)
    if (!before.ok) {
      // **损坏/版本不符 ⇒ 拒写**（fail-closed）：绝不把库当空库覆盖
      return { ok: false, reason: before.reason, detail: before.detail ?? null, written: 0, skipped, failClosed: true }
    }
    const sessions = { ...before.sessions }
    let created = 0
    let changed = 0
    const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now()
    for (const e of valid) {
      const cur = sessions[e.id]
      const merged = mergeEntry(cur, e)
      if (!cur) created += 1
      const a = cur ? JSON.stringify(cur) : null
      const b = JSON.stringify(merged)
      if (a !== b) changed += 1
      sessions[e.id] = merged
    }
    if (changed === 0) {
      return { ok: true, written: 0, created: 0, updated: 0, skipped, unchanged: true, sessions: Object.keys(sessions).length }
    }
    const store = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: now,
      writtenBy: WRITTEN_BY,
      state: {
        ...emptyStore().state,
        ...(before.state ?? {}),
        lastWriteAt: now,
        lastWriteError: null,
        ...(opts.counters && typeof opts.counters === 'object' ? opts.counters : {}),
      },
      sessions,
    }
    try {
      const w = commit(root, store, opts)
      return {
        ok: true,
        written: changed,
        created,
        updated: changed - created,
        skipped,
        unchanged: false,
        bytes: w.bytes,
        sessions: Object.keys(sessions).length,
      }
    } catch (e) {
      return { ok: false, reason: 'write-failed', detail: e?.message ?? String(e), written: 0, skipped, tmp: e?.tmp ?? null }
    }
  })
  return run && typeof run === 'object' && 'ok' in run ? run : { ok: false, reason: 'unknown', written: 0, skipped }
}

/**
 * 单条状态迁移（恢复 / 墓碑 / restoring）。
 * **删除点是 fail-closed**：库写不进去 ⇒ 调用方**不得**删目录（§4.2-③ ③ / R3-6）。
 * @returns {{ok:true, entry:object}|{ok:false, reason:string, failClosed?:boolean}}
 */
export function setState(root, id, state, extra = {}, opts = {}) {
  const sid = normalizeSessionId(id)
  if (!sid) return { ok: false, reason: 'invalid-id' }
  if (!ENTRY_STATES.includes(state)) return { ok: false, reason: 'invalid-state' }
  const run = withLock(root, opts, () => {
    const before = readStore(root)
    if (!before.ok) {
      return { ok: false, reason: before.reason, detail: before.detail ?? null, failClosed: true }
    }
    const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now()
    const cur = before.sessions[sid] ?? null
    const entry = { ...(cur ?? {}) }
    delete entry.id
    for (const [k, v] of Object.entries(extra ?? {})) {
      if (k === 'id' || v === undefined) continue
      entry[k] = v
    }
    entry.state = state
    if (state === 'archived') {
      entry.archivedAt = Number.isFinite(Number(extra.archivedAt)) ? Number(extra.archivedAt) : (cur?.archivedAt ?? now)
      delete entry.restoredAt
      delete entry.deletedAt
    } else if (state === 'restored') {
      entry.restoredAt = Number.isFinite(Number(extra.restoredAt)) ? Number(extra.restoredAt) : now
      delete entry.deletedAt
    } else if (state === 'deleted') {
      entry.deletedAt = Number.isFinite(Number(extra.deletedAt)) ? Number(extra.deletedAt) : now
    }
    // 迁移也要留"曾经在归档区何处"的溯源字段（墓碑可辨识"我删的是哪个"）
    if (cur?.batch !== undefined && entry.batch === undefined) entry.batch = cur.batch
    if (cur?.archivedAt !== undefined && entry.archivedAt === undefined) entry.archivedAt = cur.archivedAt
    const sessions = { ...before.sessions, [sid]: entry }
    const store = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: now,
      writtenBy: WRITTEN_BY,
      state: { ...emptyStore().state, ...(before.state ?? {}), lastWriteAt: now, lastWriteError: null },
      sessions,
    }
    try {
      commit(root, store, opts)
      return { ok: true, entry, id: sid }
    } catch (e) {
      return { ok: false, reason: 'write-failed', detail: e?.message ?? String(e) }
    }
  })
  return run && typeof run === 'object' && 'ok' in run ? run : { ok: false, reason: 'unknown' }
}

/**
 * 从 `.bak` 恢复损坏库（§4.3-② 的「尝试从 `.bak` 恢复」落点，**显式动作**）：
 * 最新可解析的 `.bak` ⇒ 覆盖正本；损坏件另存 `<backupDir>/archive-meta.corrupt-<stamp>.json`（**不删**）；
 * 记 `state.corruptDetectedAt`。`.bak` 也坏 ⇒ 保持只读 + 报警（调用方据此红标）。
 */
export function recoverFromBackup(root, opts = {}) {
  const file = storeFile(root)
  if (!fs.existsSync(file)) return { ok: false, reason: 'no-store' }
  const cur = readStore(root)
  if (cur.ok) return { ok: false, reason: 'not-corrupt' }
  if (cur.reason !== 'corrupt') return { ok: false, reason: cur.reason }
  const candidates = backupFiles(root, opts.env)
  if (!candidates.length) return { ok: false, reason: 'no-backup', backups: 0 }
  const dir = backupDir(root, opts.env)
  fs.mkdirSync(dir, { recursive: true })
  for (const cand of candidates) {
    let data = null
    try { data = JSON.parse(fs.readFileSync(cand.file, 'utf8')) } catch { data = null }
    if (validateStore(data)) continue
    let corruptFile = null
    try {
      corruptFile = path.join(dir, `archive-meta.corrupt-${stampOf()}-${randomToken()}.json`)
      fs.copyFileSync(file, corruptFile)
    } catch { corruptFile = null }
    const stamp = Date.now()
    data.schemaVersion = SCHEMA_VERSION
    data.updatedAt = stamp
    data.state = { ...emptyStore().state, ...(data.state ?? {}), corruptDetectedAt: data.state?.corruptDetectedAt ?? stamp }
    try {
      atomicWriteJson(file, data, opts)
    } catch (e) {
      return { ok: false, reason: 'restore-write-failed', detail: e?.message ?? String(e), corruptFile }
    }
    return {
      ok: true,
      recovered: true,
      bakFile: cand.file,
      corruptFile,
      sessions: Object.keys(data.sessions ?? {}).length,
    }
  }
  return { ok: false, reason: 'backup-corrupt', backups: candidates.length }
}

/** 库路径速查（面板/报告展示用）。 */
export function describePaths(root, env = process.env) {
  return { root: path.resolve(String(root)), store: storeFile(root), backupDir: backupDir(root, env), lock: path.join(String(root), LOCK_FILE_NAME) }
}

export { sleepSync, stampOf }
export default {
  VERSION,
  SCHEMA_VERSION,
  ID_RE,
  readStore,
  upsertMany,
  setState,
  resolveMeta,
  normalizeSessionId,
  isStrictSessionId,
  countMetaEntries,
  recoverFromBackup,
  stateOf,
  storeFile,
  backupDir,
  backupFiles,
  describePaths,
  ENTRY_STATES,
  LIVE_STATES,
}
