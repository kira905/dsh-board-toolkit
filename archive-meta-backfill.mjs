#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════
//  archive-meta-backfill.mjs —— 归档会话元数据库**一次性回填**（§4.5，可运行时做）
//  ---------------------------------------------------------------
//  方案：docs\归档会话元数据库-方案-20260920.md §4.5（口径 / 脚本契约 / 报告要求）
//
//  定位：库 = **加速缓存**，权威源 = append-only 会话日志 ⇒ 回填只是"加速"，不是"救命"。
//        不跑回填，面板被打开几次后读侧惰性补写也会补齐（字段质量取决于当时 projcache 还在不在）。
//
//  来源优先级（§4.5-①）：
//    ① 现 projcache（`<home>/storages/session_projcache.json`）→ title/cwd/createdAt/turns/tokens
//    ② 9/17 快照（`_archive/projcache-prune-20260917-170416/session_projcache.json.before`）→ 同上
//    ③ 日志**全帧**再生（慢路径）→ title（最后一个 `session/title`）/ turns（`turn/start` 计数）
//    ④ 日志首帧兜底 → cwd/createdAt（**turns: null**，绝不冒充 0）
//
//  口径（R2-8/R2-10，写死）：**基数一律取严格 id 归一后的会话数**
//    （`session-<uuid>` ∪ 裸 `<uuid>` → `session-<uuid>`），**取数必须带 asOf**；
//    非 uuid 名目录（测试残留）**跳过 + 报告单列**。
//
//  脚本契约（§4.5-③）：读-改-写 + 原子替换 + 备份 + 幂等 + 报告；
//    **默认不覆盖已有条目**（只补缺失，`--overwrite` 才整条重取）；
//    **默认 `--dry-run`**；一律 `resolveDshHome()`；用共享件的 id 判定常量（同源）。
//
//  用法：
//    node tools\archive-meta-backfill.mjs                     # 预演（默认，不写任何文件）
//    node tools\archive-meta-backfill.mjs --apply             # 真回填（先备份到 _archive）
//    node tools\archive-meta-backfill.mjs --apply --overwrite # 连已有条目一起重取
//    node tools\archive-meta-backfill.mjs --apply --prune-orphans  # 顺带把孤儿条目反标 restored
//  可选：--home <DSH_HOME> · --root <归档根> · --snapshot <快照> · --no-snapshot
//        --backup-root <目录> · --report <json 路径> · --limit <N>
//  退出码：0 成功 / 1 失败 / 2 用法错 / 3 库损坏（**禁写**，先修库）
// ══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from './lib/dsh-home.mjs'
import { TOOLS_DIR } from './lib/workspace.mjs'
// 【B4 · 2026-10-10】projcache 读口径统一：**分片目录 ∪ 旧单文件**（与归档插件同源）
import { projcacheSessionsTable } from './lib/projcache-read.mjs'
import {
  readStore, upsertMany, stateOf, normalizeSessionId, isStrictSessionId,
  countMetaEntries, storeFile, backupDir as metaBackupDir, LIVE_STATES,
} from './lib/archive-meta-store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE = path.dirname(HERE)
const DEFAULT_SNAPSHOT = path.join(WORKSPACE, '_archive', 'projcache-prune-20260917-170416', 'session_projcache.json.before')
const KNOWN = ['--dry-run', '--apply', '--overwrite', '--prune-orphans', '--no-snapshot', '--no-regen', '--help',
  '--home', '--root', '--snapshot', '--backup-root', '--report', '--limit']

function usage(msg) {
  if (msg) console.error('[用法错误] ' + msg)
  console.error('用法: node tools\\archive-meta-backfill.mjs [--apply] [--overwrite] [--prune-orphans] ' +
    '[--home <DSH_HOME>] [--root <归档根>] [--snapshot <projcache 快照>] [--no-snapshot] ' +
    '[--backup-root <目录>] [--report <json>] [--limit <N>]')
  process.exitCode = 2
}

async function main() {
const argv = process.argv.slice(2)
const flags = {}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) { usage('不认识的参数：' + a); return }
  const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a
  if (!KNOWN.includes(name)) { usage('不认识的参数：' + a); return }
  const inlineVal = a.includes('=') ? a.slice(a.indexOf('=') + 1) : null
  if (inlineVal !== null) { flags[name] = inlineVal; continue }
  const next = argv[i + 1]
  const takesValue = ['--home', '--root', '--snapshot', '--backup-root', '--report', '--limit'].includes(name)
  if (takesValue) {
    if (!next || next.startsWith('--')) { usage(name + ' 需要一个值'); return }
    flags[name] = next
    i += 1
  } else {
    flags[name] = true
  }
}
if (flags['--help']) { usage(); process.exitCode = 0; return }

const MODE = flags['--apply'] ? 'apply' : 'dry-run'
const HOME = resolveDshHome(flags['--home'] ?? undefined)
const ROOT = flags['--root'] ? path.resolve(flags['--root']) : path.join(HOME, '_archived-sessions')
const STORE = storeFile(ROOT)
const LIMIT = Number.isFinite(Number(flags['--limit'])) ? Math.max(0, Number(flags['--limit'])) : 0
const SNAPSHOT = flags['--no-snapshot'] ? null : path.resolve(flags['--snapshot'] ?? DEFAULT_SNAPSHOT)
const BACKUP_ROOT = path.resolve(flags['--backup-root'] ?? (path.join(WORKSPACE, '_archive')))
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const BACKUP_DIR = path.join(BACKUP_ROOT, 'archive-meta-backfill-' + stamp)
const REPORT_PATH = flags['--report'] ? path.resolve(flags['--report']) : path.join(BACKUP_DIR, 'backfill-report.json')

const log = (m) => console.log(m)
const sha256 = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null)
const readJsonSafe = (file) => {
  if (!file || !fs.existsSync(file)) return null
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** 归档区两路结构：`<root>\<批次>\<id>` 与 `<root>\cards\<批次>\<id>`（照插件 forEachArchivedDir 口径）。 */
function forEachArchivedDir(cb) {
  const walk = (base, lane) => {
    if (!fs.existsSync(base)) return
    for (const batch of fs.readdirSync(base)) {
      const batchDir = path.join(base, batch)
      let st
      try { st = fs.statSync(batchDir) } catch { continue }
      if (!st.isDirectory()) continue
      for (const entry of fs.readdirSync(batchDir)) {
        const dir = path.join(batchDir, entry)
        try { if (!fs.statSync(dir).isDirectory()) continue } catch { continue }
        cb({ lane, batch, batchDir, entry, dir })
      }
    }
  }
  walk(ROOT, 'main')
  walk(path.join(ROOT, 'cards'), 'card')
}

function projcacheTable(file) {
  const j = readJsonSafe(file)
  const t = j?.tables?.sessions
  return t && typeof t === 'object' ? t : null
}

// ── 场景采集 ───────────────────────────────────────────────────────────────
const storeRead = readStore(ROOT)
const storeState = stateOf(storeRead)
if (!storeRead.ok && storeRead.reason !== 'missing') {
  console.error(`[中止] 元数据库状态=${storeState}（${storeRead.detail ?? storeRead.reason}）。`)
  console.error('  损坏/版本不符期**禁止回填**（§7-②：那正是 9/17 事故的重演动作）。先修库（面板/日报）。')
  process.exitCode = 3
  return
}

// 【B4 · 2026-10-10 · projcache 读写口径统一】现库读侧改成 **分片目录 ∪ 旧单文件**（与归档插件同源）。
//   改动前只读 `<home>/storages/session_projcache.json` ⇒ 0.1.5 分片 home 上"现 projcache"这级**恒空**
//   ⇒ 每条例目都多走一遍快照/日志（慢，且质量掉到"首帧兜底"）。
const liveTable = projcacheSessionsTable(HOME) ?? {}
const snapTable = flags['--no-snapshot'] ? null : projcacheTable(SNAPSHOT)
const snapExists = snapTable !== null

const dirs = []
let nonId = 0
let batchDirs = new Set()
const skipped = []
const seen = new Map()
let duplicateDirs = 0
forEachArchivedDir((d) => {
  batchDirs.add(d.lane === 'card' ? path.join('cards', d.batch) : d.batch)
  const nid = normalizeSessionId(d.entry)
  if (!nid) { nonId += 1; skipped.push({ dir: d.dir, entry: d.entry, reason: 'non-id-name（测试残留，跳过）' }); return }
  if (seen.has(nid)) {
    duplicateDirs += 1
    // 同 id 多目录：库中只 1 条 ⇒ 取 mtime 较新（= 最近一次归档）那份
    let prev = 0
    try { prev = fs.statSync(seen.get(nid).dir).mtimeMs } catch { prev = 0 }
    let cur = 0
    try { cur = fs.statSync(d.dir).mtimeMs } catch { cur = 0 }
    if (cur > prev) seen.set(nid, d)
    return
  }
  seen.set(nid, d)
  dirs.push(d)
})

// ── 会话日志解码（多世代 + zstd 多帧）─────────────────────────────────────
//  ⚠️ 生产归档区**全是 `session.jsonl.zstd` / `session.v3.jsonl.zstd`**（明文 jsonl 只在测试夹具里）。
//     首版只读明文 ⇒ 生产回填 901 条全部落"首帧兜底"且**连 cwd 都取不到**（质量归零）。
//     解码算法与插件 `lib/index.js` 的 `scanZstdFrames()` / `decodeZstdLog()` 同源（多帧必须逐帧解，
//     只解第一帧会误判——见插件内注释与 `docs\坑库`）。
const ZSTD_MAGIC = 4247762216 // 0xFD2FB528 LE

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) break
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) break
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) break
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) break
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** 会话日志候选文件（多世代；`session.jsonl.zstd` / `session.v3.jsonl.zstd` / 明文 jsonl）。 */
function candidateFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^session.*\.jsonl(\.zstd)?$/i.test(f))
      .map((f) => path.join(dir, f))
  } catch { return [] }
}

function decodeZstdFile(file, full) {
  let buf
  try { buf = fs.readFileSync(file) } catch { return '' }
  const frames = scanZstdFrames(buf)
  if (frames.length === 0) {
    try { return zstdDecompressSync(buf).toString('utf8') } catch { return '' }
  }
  if (!full) {
    try { return zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8') } catch { return '' }
  }
  const chunks = []
  for (const { start, end } of frames) {
    try { chunks.push(zstdDecompressSync(buf.subarray(start, end))) } catch { /* 容忍尾部坏帧 */ }
  }
  return Buffer.concat(chunks).toString('utf8')
}

const textCache = new Map()
/** 目录里**内容最全**的那份日志文本（多世代候选链；zstd 多帧 / 明文皆可）。 */
function logTextOf(dir, full) {
  const key = dir + '|' + (full ? 'full' : 'first')
  if (textCache.has(key)) return textCache.get(key)
  let best = ''
  for (const f of candidateFiles(dir)) {
    const t = /\.zstd$/i.test(f) ? decodeZstdFile(f, full) : (() => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } })()
    if (t && t.length > best.length) best = t
  }
  textCache.set(key, best)
  return best
}

// ── 采集（来源优先级 ①②③④）──────────────────────────────────────────────
function regenFromLog(dir) {
  const text = logTextOf(dir, true)
  if (!text) return null
  let title = null
  let turns = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev?.type === 'session/title') {
      const t = ev.data?.title ?? ev.data?.value ?? ev.title ?? null
      if (typeof t === 'string' && t.trim()) title = t.trim()
    } else if (ev?.type === 'turn/start') turns += 1
  }
  if (title || turns > 0) return { title, turns, source: 'log-full' }
  return null
}

function headerOf(dir) {
  const text = logTextOf(dir, false)
  if (!text) return null
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const ev = JSON.parse(line)
      if (ev?.type === 'session') return ev
    } catch { /* skip */ }
  }
  return null
}

function firstUserMessage(dir) {
  const text = logTextOf(dir, false)
  if (!text) return null
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const ev = JSON.parse(line)
      if (ev?.type !== 'user/message') continue
      for (const item of (Array.isArray(ev.data?.content) ? ev.data.content : [])) {
        if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
          return item.text.split('<system-reminder>')[0].trim().slice(0, 80)
        }
      }
    } catch { /* skip */ }
  }
  return null
}

const numOr = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
function fromRecord(rec, dir, batch, source) {
  const entry = {
    id: null,
    title: (typeof rec?.rows?.title?.val === 'string' && rec.rows.title.val.trim()) ? rec.rows.title.val : null,
    cwd: rec?.identity?.cwd ?? null,
    createdAt: numOr(rec?.identity?.createdAt),
    turns: numOr(rec?.rows?.sessionStats?.val?.turns),
    lastActiveAt: numOr(rec?.rows?.sessionListMetadata?.val?.lastPromptAt),
    batch,
    archivedAt: Date.now(),
    state: 'archived',
    source,
  }
  const t = rec?.rows?.tokenUsage?.val?.totals
  if (t && typeof t === 'object') {
    const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0)
    const four = { uncachedInputTokens: n(t.uncachedInputTokens), outputTokens: n(t.outputTokens), cacheReadTokens: n(t.cacheReadTokens), cacheWriteTokens: n(t.cacheWriteTokens) }
    entry.tokens = { ...four, total: four.uncachedInputTokens + four.outputTokens + four.cacheReadTokens + four.cacheWriteTokens }
  }
  return entry
}
function fillFromHeader(entry, dir) {
  const h = (() => { try { return headerOf(dir) } catch { return null } })()
  if (entry.cwd === null && h?.cwd) entry.cwd = h.cwd
  if (entry.createdAt === null) entry.createdAt = numOr(h?.createdAt)
  return h
}

const details = []
const sources = { projcache: 0, backfill: 0, 'log-full': 0, 'log-header': 0, existing: 0, overwrite: 0 }
const toWrite = []
let scanned = 0
for (const d of dirs) {
  if (LIMIT > 0 && scanned >= LIMIT) break
  scanned += 1
  const nid = normalizeSessionId(d.entry)
  const cur = storeRead.ok ? storeRead.sessions[nid] : null
  if (cur && !flags['--overwrite']) {
    sources.existing += 1
    details.push({ id: nid, source: 'existing', title: cur.title ?? null, turns: cur.turns ?? null, dir: d.dir, state: cur.state ?? 'archived' })
    continue
  }
  let entry
  if (liveTable[nid]) {
    entry = fromRecord(liveTable[nid], d.dir, d.batch, 'projcache')
  } else if (snapTable && snapTable[nid]) {
    entry = fromRecord(snapTable[nid], d.dir, d.batch, 'backfill')
  } else {
    entry = fromRecord(null, d.dir, d.batch, 'log-header')
  }
  fillFromHeader(entry, d.dir)
  if (entry.title === null || entry.turns === null) {
    // ③ 日志**全帧**再生（zstd 多帧解码；`--no-regen` 可关闭 ⇒ 退化到纯首帧兜底）
    const regen = flags['--no-regen'] ? null : (() => { try { return regenFromLog(d.dir) } catch { return null } })()
    if (regen) {
      if (regen.title) entry.title = regen.title
      if (entry.turns === null) entry.turns = regen.turns
      entry.source = 'log-full'
    } else if (entry.title === null) {
      const u = (() => { try { return firstUserMessage(d.dir) } catch { return null } })()
      if (u) { entry.title = u; entry.source = 'log-header' }
    }
  }
  entry.id = nid
  sources[entry.source] = (Number(sources[entry.source]) || 0) + 1
  if (cur && flags['--overwrite']) sources.overwrite += 1
  toWrite.push(entry)
  details.push({ id: nid, source: entry.source, title: entry.title, turns: entry.turns, dir: d.dir })
}

// ── 孤儿（库有、目录无）─────────────────────────────────────────────────
const presentIds = new Set(seen.keys())
const orphans = []
for (const [id, v] of Object.entries(storeRead.ok ? storeRead.sessions : {})) {
  if (!LIVE_STATES.includes(v?.state ?? 'archived')) continue
  if (!presentIds.has(id)) orphans.push(id)
}

// ── 报告 + 落盘 ────────────────────────────────────────────────────────────
const cmdline = 'node ' + path.join(TOOLS_DIR, 'archive-meta-backfill.mjs') + ' ' + (MODE === 'apply' ? '--apply' : '') +
  (flags['--overwrite'] ? ' --overwrite' : '') + (flags['--no-snapshot'] ? ' --no-snapshot' : '') +
  (flags['--home'] ? ' --home ' + flags['--home'] : '') + (flags['--root'] ? ' --root ' + flags['--root'] : '')
const beforeSha = sha256(STORE)
const report = {
  asOf: new Date().toISOString(),
  asOfMs: Date.now(),
  command: cmdline.trim(),
  mode: MODE,
  home: HOME,
  root: ROOT,
  store: STORE,
  backupDir: metaBackupDir(ROOT),
  snapshot: SNAPSHOT,
  snapshotUsed: snapExists,
  bases: {
    batchDirs: batchDirs.size,
    strict: dirs.filter((d) => isStrictSessionId(d.entry)).length,
    bare: dirs.filter((d) => !isStrictSessionId(d.entry)).length,
    normalizedUnique: dirs.length,
    duplicateDirs,
    nonIdNameDirs: nonId,
  },
  sources,
  skipped,
  orphans,
  coverage: {
    storeEntries: countMetaEntries(storeRead.ok ? storeRead.sessions : {}, LIVE_STATES),
    archivedSessions: dirs.length,
    ratio: dirs.length > 0 ? Number((countMetaEntries(storeRead.ok ? storeRead.sessions : {}, LIVE_STATES) / dirs.length).toFixed(4)) : 1,
  },
  planned: toWrite.length,
  before: { sha256: beforeSha },
  after: null,
  written: 0,
  details,
}

log(`=== 归档元数据库回填（${MODE}）===`)
log(`  home : ${HOME}`)
log(`  root : ${ROOT}`)
log(`  库   : ${STORE}（状态 ${storeState}）`)
log(`  快照 : ${snapExists ? SNAPSHOT : '（无/未用）'}`)
log(`  基数 : 批次 ${report.bases.batchDirs} · 严格 id ${report.bases.strict} · 裸 uuid ${report.bases.bare} · ` +
  `归一唯一 **${report.bases.normalizedUnique}** · 重复多余 ${duplicateDirs} · 非 id 名 ${nonId}（跳过）`)
log(`  来源 : 现 projcache ${sources.projcache} · 9/17 快照 ${sources.backfill} · 日志全帧再生 ${sources['log-full']} · ` +
  `首帧兜底 ${sources['log-header']} · 库已有(跳过) ${sources.existing}`)
log(`  孤儿 : ${orphans.length}（库有、目录无${flags['--prune-orphans'] ? ' ⇒ 将反标 restored' : ''}）`)
log(`  计划写入 ${toWrite.length} 条`)

if (MODE === 'dry-run') {
  report.after = null
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true })
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8')
  log(`\n[dry-run] 未写任何文件（除报告）；预演报告 → ${REPORT_PATH}`)
} else {
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  if (fs.existsSync(STORE)) fs.copyFileSync(STORE, path.join(BACKUP_DIR, 'archive-meta.json.before'))
  fs.writeFileSync(path.join(BACKUP_DIR, 'command.txt'), cmdline + '\n', 'utf8')

  const pending = toWrite.slice()
  if (flags['--prune-orphans']) for (const id of orphans) pending.push({ id, state: 'restored', restoredAt: Date.now() })

  if (pending.length > 0) {
    const w = upsertMany(ROOT, pending)
    if (!w.ok) {
      console.error(`[失败] 写库失败：${w.reason}（${w.detail ?? ''}）`)
      if (w.failClosed) console.error('  库损坏/版本不符期禁止回填（§7-②）。')
      report.after = { sha256: sha256(STORE) }
      fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8')
      process.exitCode = w.failClosed ? 3 : 1
      return
    }
    report.written = w.written
    log(`\n[apply] 写入 ${w.written} 条（创建 ${w.created} / 更新 ${w.updated}）`)
  } else {
    log('\n[apply] 无需写入（幂等）')
  }
  report.after = { sha256: sha256(STORE) }
  const after = readStore(ROOT)
  report.coverage.storeEntries = countMetaEntries(after.ok ? after.sessions : {}, LIVE_STATES)
  report.coverage.ratio = dirs.length > 0 ? Number((report.coverage.storeEntries / dirs.length).toFixed(4)) : 1
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8')
  log(`  覆盖率 : 库 ${report.coverage.storeEntries} / 归档 ${dirs.length} = ${report.coverage.ratio}`)
  log(`  备份   : ${BACKUP_DIR}（before + command.txt）`)
  log(`  报告   : ${REPORT_PATH}`)
  log(`  回滚   : 把 ${path.join(BACKUP_DIR, 'archive-meta.json.before')} 拷回 ${STORE}（并清 .bak 目录避免旧备份覆盖新库）`)
}
}

main().catch((e) => {
  console.error('[未捕获] ' + (e?.stack ?? e))
  process.exitCode = 1
})
