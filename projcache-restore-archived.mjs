#!/usr/bin/env node
// projcache-restore-archived.mjs —— 把历史 projcache 备份里「属于已归档会话」的记录合并回现库
//
// 背景（2026-09-20 取证 · 工作 主机 A）：
//   2026-09-17 17:03 跑过 `projcache-prune.mjs --apply`（默认口径 = 不在 sessions 目录里的
//   记录一律删）。当时 `_archived-sessions` 里已有 508 个会话，它们的投影记录（标题 / 轮数 /
//   token / 工作区 / 目标 / 待办）被一并删掉：projcache 651 条 → 256 条。
//   后果：归档面板里那些会话只能解压会话头兜底 —— 标题退化成首条用户消息（取不到就显示
//   「（无标题）xxxxxxxx」）、轮数恒 0、token/目标/待办全空。会话日志本身一字未少。
//   本脚本从 9/17 裁剪前的备份里把这些记录捞回来。
//
// ⚠️ 必须在 dsh 停止时执行：dsh-storage-json 后端的「内存单元状态具有最终决定权」，
//    运行中改文件会被下一次整文件写回覆盖（白干一场）。脚本默认会探测 3080 端口并拒跑。
//
// 用法：
//   node projcache-restore-archived.mjs                  # 只读预演（默认，不写任何文件）
//   node projcache-restore-archived.mjs --apply          # 执行合并（自动备份 + 打印回滚命令）
//   node projcache-restore-archived.mjs --from <file>    # 指定来源快照（可多次；默认用 9/17 备份）
//   node projcache-restore-archived.mjs --storages <dir> # 指定 storages 目录
//   node projcache-restore-archived.mjs --archived <dir> # 指定归档根（默认 ~/.dsh/_archived-sessions）
//   node projcache-restore-archived.mjs --backup-root <dir> # 备份根（默认 <workspace>\_archive；测试用）
//   node projcache-restore-archived.mjs --no-verify      # 跳过 identity 校验（默认校验，见下）
//   node projcache-restore-archived.mjs --force          # 端口探测到 dsh 在跑也继续（危险，慎用）
//
// 合并判据（三条同时满足才捞）：
//   ① 该 id 在 `_archived-sessions` 里能找到会话目录（只捞归档会话，不动活跃会话）
//   ② 现库 `tables.sessions` 里没有该 id（已有记录的不覆盖，幂等）
//   ③ identity 校验通过：备份记录的 identity.createdAt / cwd 与该会话日志头一致
//      （主包读缓存时用这套 identity 认「是不是同一个生命周期」，不一致的行会被丢弃）
//
// 代价与风险（写进这里免得下次重新推）：
//   · projcache 的设计契约是「行可能陈旧（seq 说明陈旧到哪），但绝不会错」→ 写回旧行没有
//     正确性风险；代价是：这些会话下次被冷读 / 恢复时要多回放一段日志（一次性、数秒），
//     以及列表上显示的是「当时的标题」（若之后改过标题，会显示旧的）。
//   · 文件体积会涨（实测约 +817KB）。
//
// 退出码：0 正常 / 2 参数或环境错误 / 3 dsh 仍在运行 / 4 备份或回读校验失败

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import crypto from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { ARCHIVE_DIR } from './lib/workspace.mjs'
// 【B4 · 2026-10-10】projcache 读写口径统一：分片目录 ∪ 旧单文件（与归档插件同源）
//   改动前只读/只写 `<home>/storages/session_projcache.json` ⇒ 分片 home 上
//   ① "现库已有该 id" 判据恒假（会重复回灌）② 写出去的文件主包从不读（白干）。
import {
  PROJCACHE_SHARD_KNOWN_VERSIONS, PROJCACHE_UNIT,
  projcacheShardDir, isValidShardDoc,
  readProjcacheSessionsTable, hasProjcacheShard, normalizeSessionId,
} from './lib/projcache-read.mjs'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const FORCE = argv.includes('--force')
const VERIFY = !argv.includes('--no-verify')
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
const argAll = (flag) => argv.reduce((acc, a, i) => (a === flag && argv[i + 1] ? [...acc, argv[i + 1]] : acc), [])

const ZSTD_MAGIC = 4247762216
// 【CW-6 · 2026-09-25】归档区两路结构：卡执行会话在顶层 `cards\<批次>\`，主线在 `<批次>\`。
// 归档扫描必须两层——漏一层 ⇒ 「该 id 在归档区里能找到」这条判据对卡会话恒为假，投影恢复漏项。
const CARDS_DIR = 'cards'
const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DEFAULT_FROM = process.env.PROJCACHE_PRUNE_SNAPSHOT || ''
const BACKUP_ROOT_DEFAULT = ARCHIVE_DIR

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// ── zstd 多帧解码（照搬 tools\dsh-archive-sessions\lib\index.js 生态已验证实现）──
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset); offset += 1
    if ((descriptor & 24) !== 0) break
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remaining = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remaining) break
    offset += remaining
    for (;;) {
      if (buffer.length - offset < 3) break
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) break
      const payload = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payload) break
      offset += payload
      if (lastBlock) break
    }
    if (checksum) { if (buffer.length - offset < 4) break; offset += 4 }
    frames.push({ start, end: offset })
  }
  return frames
}
function decodeFirstFrame(file) {
  const buf = fs.readFileSync(file)
  const frames = scanZstdFrames(buf)
  if (frames.length === 0) return ''
  return zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8')
}

/** 从会话目录解出日志头（首个 {type:'session'} 事件）。 */
function sessionHeader(dir) {
  const z = path.join(dir, 'session.jsonl.zstd')
  const j = path.join(dir, 'session.jsonl')
  let text = ''
  try {
    if (fs.existsSync(z)) text = decodeFirstFrame(z)
    else if (fs.existsSync(j)) text = fs.readFileSync(j, 'utf8')
  } catch { return null }
  if (!text) return null
  for (const line of text.split('\n')) {
    if (!line) continue
    try { const ev = JSON.parse(line); if (ev?.type === 'session') return ev } catch { /* skip */ }
  }
  return null
}

/**
 * 扫归档区（两层：`<批次>\` 与 `cards\<批次>\`）：id → { batch, dir, lane }。
 *
 * ⚠️ 【B4 · 2026-10-10】**按归一 id 为键**（一个会话只登记一条）。
 *    归档目录名可能是裸 uuid，而快照/分片的键是 `session-<uuid>`（反之亦然）
 *    ⇒ 只按名字逐字节比会**漏判"该 id 在归档区"**（夹具实测：4 条候选只认到 1 条）。
 *    但也不能"两种形态各登记一条"——那会让 `archived.size` **翻倍**，把
 *    「现库缺其记录 / 无源可救」这类**计数**虚增（既有自检 `test-projcache-restore-archived.mjs`
 *    的 `unrecoverable 为空` 就是这样被打破的）。
 *    ⇒ 键 = `normalizeSessionId(name)`（非 uuid 名回退原名）；查侧同样归一后查。
 *    同一 id 多批次都有目录时，**保留先扫到的那个**（与改动前同序：main 先于 cards）。
 */
function collectArchived(root) {
  const map = new Map()
  if (!fs.existsSync(root)) return map
  const add = (name, info) => {
    const k = normalizeSessionId(name) ?? name
    if (!map.has(k)) map.set(k, info)
  }
  const scanLane = (base, lane) => {
    if (!fs.existsSync(base)) return
    let batches = []
    try { batches = fs.readdirSync(base) } catch { return }
    for (const batch of batches) {
      if (lane === 'main' && batch === CARDS_DIR) continue // cards 是 lane 容器，不是批次
      const bd = path.join(base, batch)
      let es = []
      try { es = fs.readdirSync(bd, { withFileTypes: true }) } catch { continue }
      for (const e of es) {
        if (!e.isDirectory() || !SESSION_ID_RE.test(e.name)) continue
        add(e.name, { batch, dir: path.join(bd, e.name), lane })
      }
    }
  }
  scanLane(root, 'main')
  scanLane(path.join(root, CARDS_DIR), 'card')
  return map
}

/** 某 id（任意命形态）在归档 map 里有没有；返回命中的条目或 undefined。 */
function archivedOf(map, id) {
  const k = normalizeSessionId(id) ?? id
  return map.get(k)
}

function portInUse(port, host) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host })
    let done = false
    const fin = (v) => { if (!done) { done = true; try { s.destroy() } catch {} ; resolve(v) } }
    s.setTimeout(1500)
    s.on('connect', () => fin(true))
    s.on('timeout', () => fin(false))
    s.on('error', () => fin(false))
  })
}

async function main() {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 30).join('\n'))
    return 0
  }

  const HOME = process.env.USERPROFILE || process.env.HOME || ''
  if (!HOME) { console.error('取不到 USERPROFILE/HOME，拒绝在猜测路径上动手'); return 2 }

  const storagesDir = argOf('--storages') ?? path.join(HOME, '.dsh', 'storages')
  const archivedRoot = argOf('--archived') ?? path.join(HOME, '.dsh', '_archived-sessions')
  const unitFile = path.join(storagesDir, `${PROJCACHE_UNIT}.json`)
  const shardDir = path.join(storagesDir, PROJCACHE_UNIT, 'sessions')
  const readHome = path.dirname(storagesDir)
  const fromFiles = argAll('--from').length > 0 ? argAll('--from') : (DEFAULT_FROM ? [DEFAULT_FROM] : [])
  if (fromFiles.length === 0) {
    console.error('需要 --from <快照文件>（或用 $PROJCACHE_PRUNE_SNAPSHOT 指定默认快照）'); return 2
  }

  // 形态判定：分片目录有效 或 旧单文件存在，二者**任一**即可作业（改动前只认单文件）
  const hasShard = fs.existsSync(shardDir)
  if (!hasShard && !fs.existsSync(unitFile)) {
    console.error(`既没有分片目录也没有现库单文件，无从处理:\n  ${shardDir}\n  ${unitFile}`); return 2
  }
  const missingSources = fromFiles.filter((f) => !fs.existsSync(f))
  if (missingSources.length > 0) { console.error(`来源快照不存在:\n  ${missingSources.join('\n  ')}`); return 2 }

  // ── 现库：**分片 ∪ 单文件**（与归档插件同源口径）─────────────────────────
  const read = readProjcacheSessionsTable(readHome)
  const nowRecords = read.table
  // 单文件原文（写侧只在"确有回落条目"时才重写它）
  let nowDoc = null, raw = ''
  if (fs.existsSync(unitFile)) {
    raw = fs.readFileSync(unitFile, 'utf8')
    try { nowDoc = JSON.parse(raw) } catch (e) { console.error(`现库不是合法 JSON，拒绝处理: ${e.message}`); return 2 }
    if (nowDoc?.unit?.name !== PROJCACHE_UNIT) { console.error(`现库 unit 头不对（${JSON.stringify(nowDoc?.unit)}），拒绝处理`); return 2 }
  }

  // ── 来源并集（同 id 取 rows 更全的那份）──
  const rowsCount = (r) => Object.keys(r?.rows ?? {}).length
  const cand = new Map()
  const srcStat = []
  for (const f of fromFiles) {
    let doc
    try { doc = JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { console.error(`来源快照不可读，跳过: ${f} (${e.message})`); continue }
    const t = doc?.tables?.sessions ?? {}
    let taken = 0
    for (const [id, rec] of Object.entries(t)) {
      const prev = cand.get(id)
      if (!prev || rowsCount(rec) > rowsCount(prev.rec)) { cand.set(id, { rec, from: f }); taken++ }
    }
    srcStat.push({ file: f, records: Object.keys(t).length, better: taken })
  }

  // ── 判据 ──
  const archived = collectArchived(archivedRoot)
  const toMerge = []
  const skipped = { notArchived: 0, alreadyPresent: 0, identityFailed: [], headerMissing: [] }

  for (const [id, { rec, from }] of cand) {
    const archEntry = archivedOf(archived, id)
    if (!archEntry) { skipped.notArchived++; continue }
    if (nowRecords[id]) { skipped.alreadyPresent++; continue }
    const ident = rec?.identity ?? {}
    if (VERIFY) {
      const hdr = sessionHeader(archEntry.dir)
      if (!hdr || typeof hdr.createdAt !== 'number') { skipped.headerMissing.push(id); continue }
      const sameCreated = hdr.createdAt === ident.createdAt
      const sameCwd = ident.cwd === undefined || hdr.cwd === undefined ? true : hdr.cwd === ident.cwd
      if (!sameCreated || !sameCwd) { skipped.identityFailed.push({ id, logCreatedAt: hdr.createdAt, recCreatedAt: ident.createdAt, logCwd: hdr.cwd, recCwd: ident.cwd }); continue }
    }
    toMerge.push({ id, rec, from, arch: archEntry })
  }

  const mergeBytes = toMerge.reduce((a, m) => a + Buffer.byteLength(JSON.stringify(m.rec), 'utf8'), 0)
  const withTitle = toMerge.filter((m) => m.rec?.rows?.title?.val).length
  const withTurns = toMerge.filter((m) => (m.rec?.rows?.sessionStats?.val?.turns ?? 0) > 0).length
  const missingIds = [...archived.keys()].filter((id) => !nowRecords[id])
  const unrecoverable = missingIds.filter((id) => !cand.has(id))

  console.log('=== projcache 归档元数据回灌 预演 ===')
  console.log(`  现库          : ${unitFile}`)
  console.log(`  现库读口径    : 分片 ∪ 单文件 = ${Object.keys(nowRecords).length} 条（source=${read.source} · shardCount=${read.shardCount} · legacyCount=${read.legacyCount}）`)
  console.log(`  分片目录      : ${shardDir}${hasShard ? '' : '（不存在）'}`)
  console.log(`  旧单文件      : ${fs.existsSync(unitFile) ? `${(Buffer.byteLength(raw, 'utf8') / 1024).toFixed(0)} KB` : '（不存在）'}`)
  for (const s of srcStat) console.log(`  来源快照      : ${path.basename(s.file)} → ${s.records} 条（其中 ${s.better} 条被选为更全版本）`)
  console.log(`  归档会话总数  : ${archived.size}`)
  console.log(`  现库缺其记录  : ${missingIds.length}`)
  console.log('')
  console.log(`  【将合并】    : ${toMerge.length} 条（带标题 ${withTitle} / 带轮数 ${withTurns}）`)
  console.log(`  并集后新增体积: 约 ${(mergeBytes / 1024).toFixed(0)} KB`)
  console.log(`  跳过 · 非归档会话: ${skipped.notArchived} 条`)
  console.log(`  跳过 · 现库已有  : ${skipped.alreadyPresent} 条`)
  if (VERIFY) {
    console.log(`  跳过 · 日志头解不出: ${skipped.headerMissing.length} 条`)
    console.log(`  跳过 · identity 不一致: ${skipped.identityFailed.length} 条`)
  }
  console.log(`  无源可救（快照里也没有）: ${unrecoverable.length} 条`)

  if (toMerge.length === 0) { console.log('\n没有需要合并的记录，无需动作。'); return 0 }
  if (!APPLY) {
    console.log('\n[预演模式] 未写入任何文件。加 --apply 执行（须先停 DSH）。')
    return 0
  }

  // ── 运行中拒跑 ──
  if (!FORCE && await portInUse(3080, '127.0.0.1')) {
    console.error('\n✗ 检测到 127.0.0.1:3080 在监听（dsh 正在运行）。')
    console.error('  dsh-storage-json 的内存态会在下次整文件写回时覆盖本次改动 —— 先停 dsh 再跑。')
    console.error('  （确认 dsh 确实已停但端口误报时，可用 --force）')
    return 3
  }

  // ── 静默证明（B4 · 2026-10-10）──────────────────────────────────────────
  // 本工具会**整份读改写分片文档** ⇒ 若 projcache 正被并发写入，我们的旧副本会把
  // 并发方刚写进去的字段抹掉（dsh 的内存态更是会在下次整文件写回时覆盖本次改动）。
  // 判据：算记录的文档集合在「读完之后」不许出现**新键**。
  // ⚠️ 端口探测可能因 `--force` 或非常规监听被绕过，这条是**更硬**的后备闸门。
  {
    const docsNow = new Set()
    if (fs.existsSync(shardDir)) {
      for (const f of fs.readdirSync(shardDir)) {
        if (!f.endsWith('.json')) continue
        let d = null
        try { d = JSON.parse(fs.readFileSync(path.join(shardDir, f), 'utf8')) } catch { d = null }
        if (d && typeof d.record === 'object' && d.record && PROJCACHE_SHARD_KNOWN_VERSIONS.has(Number(d.version))) docsNow.add(f.slice(0, -5))
      }
    }
    const appeared = [...docsNow].filter((k) => !(k in nowRecords))
    if (appeared.length > 0) {
      console.error(`\n✗ 静默证明失败：读取之后分片目录里**新出现** ${appeared.length} 条记录（样例 ${appeared.slice(0, 3).join(', ')}）`)
      console.error('  ⇒ projcache 正在被并发写入（dsh 还在跑？）。整份读改写会抹掉并发写入 ⇒ **拒绝执行**。')
      console.error('  先停 dsh 再跑（或用 --force 明确承担覆盖风险）。**未写任何文件。**')
      return 3
    }
  }

  // ── 合并 + 写侧**同址** ──────────────────────────────────────────────────
  // 选址规则（与归档插件 `syncProjcacheCwd()` 同语义）：该 id 有分片 ⇒ 写分片；无分片 ⇒ 回落旧单文件。
  const toShard = []
  const toLegacy = []
  for (const m of toMerge) {
    const key = hasProjcacheShard(readHome, m.id)
    if (key) toShard.push({ ...m, shardKey: key })
    else toLegacy.push(m)
  }

  const merged = { ...(nowDoc?.tables?.sessions ?? {}) }
  for (const m of toLegacy) merged[m.id] = m.rec

  const shardWritten = []
  let outText = null
  if (toLegacy.length > 0) {
    const outDoc = {
      unit: { name: nowDoc?.unit?.name ?? PROJCACHE_UNIT, version: nowDoc?.unit?.version ?? 3 },
      global: nowDoc?.global ?? null,
      tables: { sessions: merged },
    }
    outText = `${JSON.stringify(outDoc, null, 2)}\n`
  }

  // ── 备份（行级锚定：分片逐份 + 单文件一份）───────────────────────────────
  const d = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  const backupRoot = argOf('--backup-root') ?? BACKUP_ROOT_DEFAULT
  const backupDir = path.join(backupRoot, `projcache-restore-archived-${stamp}`)
  fs.mkdirSync(backupDir, { recursive: true })
  const shardBackups = []
  for (const m of toShard) {
    const src = path.join(shardDir, `${m.shardKey}.json`)
    const dst = path.join(backupDir, `${m.shardKey}.json.before`)
    fs.copyFileSync(src, dst)
    const a = sha256(fs.readFileSync(src)), b = sha256(fs.readFileSync(dst))
    if (a !== b) { console.error(`备份 sha256 校验失败（分片 ${m.shardKey}），中止写入`); return 4 }
    shardBackups.push({ key: m.shardKey, src, backup: path.basename(dst), sha256: a })
  }
  let backupFile = null, beforeSha = null
  if (outText !== null) {
    backupFile = path.join(backupDir, `${PROJCACHE_UNIT}.json.before`)
    fs.copyFileSync(unitFile, backupFile)
    beforeSha = sha256(fs.readFileSync(unitFile))
    if (beforeSha !== sha256(fs.readFileSync(backupFile))) { console.error('备份 sha256 校验失败，中止写入'); return 4 }
  }
  const manifest = {
    ranAt: d.toISOString(), backupDir, unitFile, shardDir,
    shards: shardBackups,
    legacy: backupFile ? { src: unitFile, backup: path.basename(backupFile), sha256: beforeSha } : null,
    warning: '逐文件回滚（据 shards[].key/backup 与 legacy 一一对应，回写前核 sha256）；禁止整目录覆盖。',
  }
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // ── ① 写分片（逐条独立写：读→写 record → 保 version/其余字段 → 原子替换）──
  // ⚠️ 待写文档**可能没有 `record` 字段**（那正是回灌要补的东西）⇒ 校验只要求
  //    "能解析 + version 属已知世代"，**不要求** `record` 已在（与 `isValidShardDoc` 的读口径区分开）。
  for (const m of toShard) {
    const target = path.join(shardDir, `${m.shardKey}.json`)
    let doc
    try { doc = JSON.parse(fs.readFileSync(target, 'utf8')) } catch { doc = null }
    if (!doc || typeof doc !== 'object' || !PROJCACHE_SHARD_KNOWN_VERSIONS.has(Number(doc.version))) {
      console.error(`分片文档不可读或世代未知，中止（已写 ${shardWritten.length} 份；备份在 ${backupDir}）: ${target}`)
      return 4
    }
    const rec = doc.record
    doc.record = {
      ...(rec && typeof rec === 'object' ? rec : {}),
      ...m.rec,
      identity: { ...((rec && rec.identity) ?? {}), ...(m.rec?.identity ?? {}) },
      rows: { ...((rec && rec.rows) ?? {}), ...(m.rec?.rows ?? {}) },
    }
    const tmp = path.join(shardDir, `.projcache-restore-archived-${process.pid}-${shardWritten.length}.tmp`)
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    let verify
    try { verify = JSON.parse(fs.readFileSync(tmp, 'utf8')) } catch (e) {
      fs.rmSync(tmp, { force: true })
      console.error(`分片临时文件回读失败，已删除，未动原文件: ${e.message}`); return 4
    }
    if (!isValidShardDoc(verify) || Number(verify.version) !== Number(doc.version)) {
      fs.rmSync(tmp, { force: true })
      console.error(`分片临时文件校验失败（version/record 不符），未动原文件: ${target}`); return 4
    }
    fs.renameSync(tmp, target)
    shardWritten.push({ key: m.shardKey, sha256: sha256(fs.readFileSync(target)) })
  }

  // ── ② 写回落单文件（原子替换，与上游 writeAtomic 同协议）────────────────
  let afterSha = null
  if (outText !== null) {
    const tmp = path.join(storagesDir, `.projcache-restore-archived-${process.pid}.tmp`)
    fs.writeFileSync(tmp, outText, 'utf8')
    let verify
    try { verify = JSON.parse(fs.readFileSync(tmp, 'utf8')) } catch (e) {
      fs.rmSync(tmp, { force: true })
      console.error(`临时文件回读失败，已删除，未动原库: ${e.message}`)
      return 4
    }
    if (Object.keys(verify.tables.sessions).length !== Object.keys(merged).length) {
      fs.rmSync(tmp, { force: true })
      console.error('临时文件回读校验失败：记录数与预期不符，未动原库')
      return 4
    }
    fs.renameSync(tmp, unitFile)
    afterSha = sha256(fs.readFileSync(unitFile))
  }

  // ── ③ 写后复验：读口径必须真的看到新条目 ────────────────────────────────
  // ⚠️ 判据要按**实际落点的键形态**查：写分片时表里的键是 `shardKey`（可能是 `session-<uuid>`），
  //    按快照里的原始 id（裸 uuid）查会**误报"仍读不到"**（2026-10-10 夹具实测踩到）。
  const afterRead = readProjcacheSessionsTable(readHome)
  const missingAfter = []
  for (const m of toShard) if (!(m.shardKey in afterRead.table)) missingAfter.push(m.shardKey)
  for (const m of toLegacy) if (!(m.id in afterRead.table)) missingAfter.push(m.id)
  if (missingAfter.length > 0) {
    console.error(`[警告] 写后复验：${missingAfter.length} 条仍读不到（${missingAfter.slice(0, 5).join(', ')}…）`)
    console.error(`  备份在 ${backupDir}（逐文件回滚见 manifest.json）。`)
    return 4
  }

  // ── 报告 ──
  const rollbackLines = [
    ...shardBackups.map((s) => `Copy-Item -LiteralPath '${path.join(backupDir, s.backup)}' -Destination '${s.src}' -Force`),
    ...(backupFile ? [`Copy-Item -LiteralPath '${backupFile}' -Destination '${unitFile}' -Force`] : []),
  ]
  const report = {
    ranAt: d.toISOString(),
    unitFile,
    shardDir,
    shardWritten: shardWritten.map((s) => s.key),
    legacyWritten: toLegacy.map((m) => m.id),
    sources: fromFiles,
    before: { records: Object.keys(nowRecords).length, bytes: Buffer.byteLength(raw, 'utf8'), sha256: beforeSha, legacySha256: beforeSha },
    after: { records: Object.keys(readProjcacheSessionsTable(readHome).table).length, bytes: afterSha ? fs.statSync(unitFile).size : null, sha256: afterSha },
    mergedCount: toMerge.length,
    merged: toMerge.map((m) => ({ id: m.id, batch: m.arch?.batch ?? null, from: m.from, dest: toShard.some((s) => s.id === m.id) ? 'shard' : 'legacy', title: m.rec?.rows?.title?.val ?? null, turns: m.rec?.rows?.sessionStats?.val?.turns ?? 0 })),
    skipped,
    unrecoverable,
    rollback: rollbackLines.join('\n     '),
  }
  fs.writeFileSync(path.join(backupDir, 'restore-report.json'), JSON.stringify(report, null, 2), 'utf8')

  console.log('')
  console.log('✅ 回灌完成')
  console.log(`   合并记录  : ${toMerge.length} 条（写分片 ${toShard.length} · 写单文件 ${toLegacy.length}）`)
  console.log(`   读口径总数: ${report.after.records} 条（分片 ∪ 单文件）`)
  console.log(`   备份目录  : ${backupDir}`)
  console.log(`   报告      : ${path.join(backupDir, 'restore-report.json')}`)
  console.log('   回滚（逐文件锚定）：')
  for (const l of rollbackLines) console.log(`     ${l}`)
  console.log('   下一步    : 启动 dsh，在设置页「归档会话管理」核对标题是否回来')
  return 0
}

process.exitCode = await main()
