// ============================================================
//  board-archive-view.mjs — 看板「归档批次面」只读视图（K3 · 2026-09-24）
//  ------------------------------------------------------------
//  为什么需要（方案 docs\看板瘦身与归档物理化-方案-20260924.md）：
//    归档物理化之后，归档卡**不在主账本**里，而住在
//    `$DSH_HOME/task-board/archive/<batchId>/cards.json`（K1 交付形态；
//    manifest = {batchId,at,count,ids[],fromRevision,tool,host}，
//    另有缓存索引 `archive-index.json` = {schemaVersion:1,batches:[{…,ids[]}]}）。
//    工具面若只读主账本就会「静默少看卡」—— 这正是 §8 #6 / #8 / #10 / #11 的同一个根因。
//
//  ★两条数据源、各有其位（K3 口径 · 不许互串）：
//    · **HTTP `scope=all`**（Host 内 `mergeBoardView`，K2 已交付）= 主账本 + 全部批次的
//      **合并视图**。凡「要整本」的读（建卡查重 / 跨机并回）**一律用它** ——
//      唯一真源在 Host，工具不重复实现合并（方案 §3 D-10 已被 K2 按 (a) 落地）。
//    · **本模块（直读文件）** = 只给「Host 侧拿不到、或不想让 Host 付代价」的场景：
//      高频 tick（`dup-cards-merge` / 主线清账，30 分钟一轮）只需要归档卡的
//      **标题 / 归属线**这类聚合视图，直读文件 **零 Host 负载**（不过 HTTP、不序列化、
//      不压 dsh 主线程）—— 而 `GET /state` 的 all 视图是 Host 在 dsh 进程内拼的。
//
//  ★铁律：
//    · **只读**：不写任何文件、不加锁。归档批次文件由 Host（单写者）持有，
//      读者可能撞上「半完成批次」⇒ 一切解析失败必须**可见**（errors[]/ok=false），
//      **绝不静默当成「没有归档」**（那会退化成"少看卡"）。
//    · **不跟链接**：批次目录条目一律 lstat 判目录 + 跳过 symlink/junction
//      （本机有「跟删 junction 清空目标目录」的血泪史）。
//    · **「没有归档面」≠「读不到」**（两者必须分开，否则 fail-open）：
//        `boardDir` 在、`archive/` 不在  ⇒ `source:'none'`    = 合法（还没搬过卡）
//        `boardDir` 本身不在             ⇒ `source:'unavailable'` = 环境不可判定（DSH_HOME 指错了）
// ============================================================
import fs from 'node:fs'
import path from 'node:path'

import { resolveDshHome } from './dsh-home.mjs'

export const BOARD_ARCHIVE_VIEW_VERSION = '0.1.0'

const ARCHIVE_DIR_NAME = 'archive'
const ARCHIVE_INDEX_FILE = 'archive-index.json'

/** 解析路径三件套（home 口径 = `dsh-home.mjs`，与部署/回滚脚本同源）。 */
export function archivePaths(home) {
  const resolved = resolveDshHome(home)
  const boardDir = path.join(resolved, 'task-board')
  return {
    home: resolved,
    boardDir,
    archiveDir: path.join(boardDir, ARCHIVE_DIR_NAME),
    indexFile: path.join(boardDir, ARCHIVE_INDEX_FILE),
  }
}

/**
 * batchId 形状校验（**拼路径前必过**，防路径穿越）。
 * ⚠️ 与 Host 侧 `dsh-task-board-local/src/core/archive-id.ts` 的 `isValidArchiveBatchId`
 * **逐字同源**（同一正则 + 同一 `..` 禁则）—— 本地比 Host 松会白挨一次 `permanent` 400，
 * 比 Host 紧会误拒合法 id。三处（Host / 本模块 / `dsh-butler/lib/ledger-api.mjs`）
 * 各自的单测都断言同一组用例，漂移即红。
 */
const ARCHIVE_BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isSafeBatchId(batchId) {
  return typeof batchId === 'string' && ARCHIVE_BATCH_ID_PATTERN.test(batchId) && !batchId.includes('..')
}

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function readJsonValue(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** 目录条目：只认**真实目录**（lstat 判 + 拒 symlink/junction），名字须是安全 batchId。 */
function listBatchDirNames(archiveDir) {
  let entries = []
  try {
    entries = fs.readdirSync(archiveDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of entries) {
    if (!isSafeBatchId(e.name)) continue
    const full = path.join(archiveDir, e.name)
    try {
      const st = fs.lstatSync(full)
      if (st.isSymbolicLink() || !st.isDirectory()) continue
    } catch {
      continue
    }
    out.push(e.name)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

/** 单批 manifest（目录扫描兜底用；index 缺失/损坏时唯一事实源）。 */
function readManifest(archiveDir, batchId) {
  const raw = readJsonValue(path.join(archiveDir, batchId, 'manifest.json'))
  if (!raw || typeof raw !== 'object') return null
  const ids = Array.isArray(raw.ids) ? raw.ids.filter((x) => typeof x === 'string' && x !== '') : []
  return {
    batchId,
    at: numOrNull(raw.at),
    count: numOrNull(raw.count) ?? ids.length,
    ids,
    fromRevision: numOrNull(raw.fromRevision),
    tool: typeof raw.tool === 'string' ? raw.tool : null,
    host: typeof raw.host === 'string' ? raw.host : null,
    source: 'manifest',
  }
}

function normalizeBatchRow(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null
  const batchId = String(raw.batchId ?? fallbackId ?? '')
  if (!isSafeBatchId(batchId)) return null
  const ids = Array.isArray(raw.ids) ? raw.ids.filter((x) => typeof x === 'string' && x !== '') : []
  return {
    batchId,
    at: numOrNull(raw.at),
    count: numOrNull(raw.count) ?? ids.length,
    bytes: numOrNull(raw.bytes),
    path: typeof raw.path === 'string' && raw.path !== '' ? raw.path : `${ARCHIVE_DIR_NAME}/${batchId}`,
    ids,
    restoredAt: numOrNull(raw.restoredAt),
    source: 'index',
  }
}

function sortBatches(rows) {
  return rows.slice().sort((a, b) => {
    const at = (a.at ?? 0) - (b.at ?? 0)
    return at !== 0 ? at : a.batchId.localeCompare(b.batchId)
  })
}

/**
 * 读归档批次**索引**（带目录扫描兜底）。
 *
 * `source` 语义（**别混用**）：
 *   `'file'`        —— 索引或目录扫描拿到了批次表（`present:true/false` 只表示"有没有批次"）
 *   `'none'`        —— `boardDir` 在、`archive/` 不在 ⇒ **确认没有归档批次**（合法）
 *   `'unavailable'` —— `boardDir` 本身不在 ⇒ 环境不可判定（DSH_HOME 指错了）⇒ 调用方**必须**可见地降级
 *
 * @param {string} [home] 显式 home（缺省走 `resolveDshHome`：BUTLER_DSH_HOME > DSH_HOME > ~/.dsh）
 * @param {{now?:number, fresh?:boolean}} [opts]
 */
export function readArchiveIndexSync(home, opts = {}) {
  const p = archivePaths(home)
  const base = {
    version: BOARD_ARCHIVE_VIEW_VERSION,
    home: p.home, boardDir: p.boardDir, archiveDir: p.archiveDir, indexFile: p.indexFile,
    present: false, batches: [], cards: 0, errors: [], readAt: opts.now ?? Date.now(),
  }
  if (!dirExists(p.boardDir)) {
    return { ...base, ok: false, source: 'unavailable', reason: 'board-dir-missing' }
  }
  if (!dirExists(p.archiveDir)) {
    return { ...base, ok: true, source: 'none', reason: 'no-archive-dir' }
  }

  const errors = []
  let batches = []
  let reason = 'ok'
  let schemaVersion = null

  const idxRaw = readJsonValue(p.indexFile)
  if (idxRaw && typeof idxRaw === 'object' && Array.isArray(idxRaw.batches)) {
    schemaVersion = numOrNull(idxRaw.schemaVersion)
    batches = idxRaw.batches.map((row) => normalizeBatchRow(row, null)).filter(Boolean)
    if (idxRaw.batches.length !== batches.length) {
      errors.push(`archive-index.json 有 ${idxRaw.batches.length - batches.length} 行形状非法（已忽略）`)
    }
    // 索引可能陈旧（缓存可从 manifest 重建，方案 §3 状态文件清单）⇒ 目录里多出来的批次补进来
    const known = new Set(batches.map((b) => b.batchId))
    for (const name of listBatchDirNames(p.archiveDir)) {
      if (known.has(name)) continue
      const m = readManifest(p.archiveDir, name)
      if (m) batches.push(m)
      else errors.push(`批次目录 ${name} 无可用 manifest.json（索引里也没有它）`)
    }
  } else {
    // 索引缺失 / 损坏 / 形状不对 ⇒ 目录扫描兜底（批次是个位数，成本可接受）
    const names = listBatchDirNames(p.archiveDir)
    if (fs.existsSync(p.indexFile)) errors.push('archive-index.json 不可解析 → 已按 manifest 目录扫描兜底')
    else if (names.length) errors.push('archive-index.json 缺失 → 已按 manifest 目录扫描兜底')
    batches = names.map((n) => readManifest(p.archiveDir, n)).filter(Boolean)
    reason = names.length ? 'index-rebuilt-from-dirs' : 'index-missing'
  }

  batches = sortBatches(batches)
  const cards = batches.reduce((n, b) => n + (b.count ?? b.ids.length), 0)
  return {
    ...base,
    ok: true,
    source: 'file',
    reason,
    schemaVersion,
    present: batches.length > 0,
    batches,
    cards,
    errors,
  }
}

// ---------------------------------------------------------------- 归档卡视图（读 cards.json）

/** 进程内缓存（tickd 是常驻进程；30 分钟一轮不必每次重读 5 MB）。key = home。 */
const CARDS_CACHE = new Map()

/** 缓存键：索引签名（索引 mtime+size + 批次表）。任一项变化即失效（批次被 trim / 新增都会动索引）。 */
function archiveSignature(indexResult) {
  if (indexResult.source !== 'file') return `${indexResult.source}:${indexResult.reason}`
  let stat = 'no-index'
  try {
    const st = fs.statSync(indexResult.indexFile)
    stat = `${Math.trunc(st.mtimeMs)}:${st.size}`
  } catch { /* 目录扫描兜底路径没有索引文件 */ }
  const batchSig = indexResult.batches.map((b) => `${b.batchId}#${b.count}#${b.restoredAt ?? ''}`).join(',')
  return `${stat}|${batchSig}`
}

/** 清缓存（单测/长生命周期进程自检用）。 */
export function resetArchiveViewCache() {
  CARDS_CACHE.clear()
}

function lineKeyOf(card) {
  const raw = card?.line
  const s = raw === undefined || raw === null ? '' : String(raw).trim()
  return s === '' ? null : s
}

/**
 * 读归档批次的**卡全量**（逐批 cards.json 合并；同 id 只取首个并记 warning）。
 *
 * @returns {{ok:boolean, source:string, reason:string, cards:object[], count:number,
 *            byId:Map<string,object>, byLine:Map<string,number>, byTitle:Map<string,object[]>,
 *            batches:object[], errors:string[], cache:'hit'|'miss'|'bypass'}}
 */
export function readArchivedCardsSync(home, opts = {}) {
  const idx = readArchiveIndexSync(home, opts)
  const empty = {
    version: BOARD_ARCHIVE_VIEW_VERSION,
    home: idx.home, source: idx.source, reason: idx.reason, ok: idx.ok,
    cards: [], count: 0, byId: new Map(), byLine: new Map(), byTitle: new Map(),
    batches: [], errors: [...(idx.errors ?? [])], cache: 'bypass',
  }
  if (idx.source !== 'file' || !idx.present) return { ...empty, batches: idx.batches ?? [] }

  const sig = archiveSignature(idx)
  const useCache = opts.fresh !== true && opts.cache !== false
  if (useCache) {
    const hit = CARDS_CACHE.get(idx.home)
    if (hit && hit.sig === sig) return { ...hit.value, cache: 'hit' }
  }

  const errors = [...(idx.errors ?? [])]
  const cards = []
  const seen = new Set()
  for (const b of idx.batches) {
    const file = path.join(idx.archiveDir, b.batchId, 'cards.json')
    const raw = readJsonValue(file)
    if (!Array.isArray(raw)) {
      errors.push(`批次 ${b.batchId} 的 cards.json 不可读（${file}）`)
      continue
    }
    if (b.count !== undefined && b.count !== null && raw.length !== b.count) {
      errors.push(`批次 ${b.batchId}：cards.json ${raw.length} 张 ≠ manifest.count ${b.count}（三方一致对账）`)
    }
    for (const card of raw) {
      if (!card || typeof card !== 'object' || typeof card.id !== 'string' || card.id === '') continue
      if (seen.has(card.id)) { errors.push(`卡 ${card.id} 在多个批次里出现（只取首个）`); continue }
      seen.add(card.id)
      cards.push(card)
    }
  }

  const byId = new Map()
  const byLine = new Map()
  const byTitle = new Map()
  for (const card of cards) {
    byId.set(card.id, card)
    const line = lineKeyOf(card)
    if (line) byLine.set(line, (byLine.get(line) ?? 0) + 1)
    const title = String(card.title ?? '')
    if (title) {
      if (!byTitle.has(title)) byTitle.set(title, [])
      byTitle.get(title).push(card)
    }
  }

  const value = {
    version: BOARD_ARCHIVE_VIEW_VERSION,
    home: idx.home, source: 'file', reason: errors.length ? 'cards-partial' : idx.reason,
    ok: idx.ok && errors.length === 0,
    cards, count: cards.length, byId, byLine, byTitle,
    batches: idx.batches, errors,
  }
  if (useCache) CARDS_CACHE.set(idx.home, { sig, value })
  return { ...value, cache: useCache ? 'miss' : 'bypass' }
}

/** 只要 id 集合（跨机并回的"本机有没有这张卡"判据；**不读 cards.json**，走索引 ids[]）。 */
export function readArchivedIdsSync(home, opts = {}) {
  const idx = readArchiveIndexSync(home, opts)
  const ids = new Set()
  for (const b of idx.batches ?? []) for (const id of b.ids ?? []) ids.add(id)
  return {
    version: BOARD_ARCHIVE_VIEW_VERSION,
    ok: idx.ok, source: idx.source, reason: idx.reason,
    home: idx.home, batches: (idx.batches ?? []).length, count: ids.size,
    ids, errors: [...(idx.errors ?? [])],
  }
}

/** 按归属线计数（主线清账的「另有归档 N 张」口径；需读卡）。 */
export function readArchivedLineCountsSync(home, opts = {}) {
  const view = readArchivedCardsSync(home, opts)
  return {
    version: BOARD_ARCHIVE_VIEW_VERSION,
    ok: view.ok, source: view.source, reason: view.reason,
    byLine: view.byLine, count: view.count, batches: view.batches.length,
    errors: view.errors, cache: view.cache,
  }
}
