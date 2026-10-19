#!/usr/bin/env node
/**
 * board-archive-bulk.mjs —— 看板「按卡龄批量归档」（一次请求归档一批，可一键回滚）
 *
 * 为什么需要它（2026-09-24 整夜批误杀治理）：
 *   生产账本长到 609 张 / 6 MB，`GET /api/task-board/state` 每次把全本序列化后吐给
 *   每一个拉取方；大管家 tickd 的 queue job 每分钟拉一次，正是把 dsh 主线程压住、
 *   被守护鱼判成"卡死"强杀的负载来源。现有的 `board-archive-line.mjs` 只能**逐卡**
 *   POST `{kind:"archive"}`——每张卡都会让 Host 把整本账本重写 + fsync 一次，收几百张
 *   的开销本身就是一次自我加压。本脚本走插件新增的 `{kind:"archive-many"}`：
 *   整批一次 commit（单测 `_test/archive-many.test.mjs` 已固定该语义）。
 *
 * 与既有工具的分工：
 *   · board-cleanup（大管家 P0）  = 判定「哪条主线可以收工」，只提示不动作；
 *   · board-archive-line.mjs      = 按主线 / 显式 id 清单归档（逐卡，适合几十张）；
 *   · 本脚本                      = 按**卡龄**收（保留最近 N 天，其余一次批归档），
 *                                   适合账本膨胀后的例行瘦身。
 *
 * 铁律遵守：只走 Host HTTP API（绝不手改 ledger-v2.json）；默认 dry-run；
 *           收尾用 process.exitCode（发过 fetch 的脚本用 process.exit 会崩 libuv）；
 *           fail-closed（读不到 /state 一律非 0 退出，绝不静默"0 张"）。
 *
 * ★K3（2026-09-24 · 看板瘦身/归档物理化 · 方案 §8 #7）：**适配「归档 = 物理搬出」**。
 *   归档已不再只是"给卡打 `archivedAt` 标记"——卡会**离开主账本**、搬进
 *   `task-board/archive/<batchId>/cards.json`。本脚本因此有三处口径对齐：
 *     · `/state` **显式**带 `x-dsh-board-scope: all`（Host 的 all = 主账本 + 全部归档批次的合并视图，
 *       K2 落地）⇒「全量/在板/归档」三个计数与"命中老 done 卡"的判据都仍然成立；
 *     · "在板卡"的定义仍是 `archivedAt === undefined`（物理搬出的卡带 `archivedAt` 出现在合并视图里，
 *       所以它们在两个世界里都算"已归档"）⇒ 迁移前后行为一致；
 *     · 归档完成后追加一次**物理搬出确认**（卡是否真在归档批次里；见 `physicalArchiveIds`）——
 *       `archivedAt` 只能证明"打了标记"，分不出"打标记"与"真搬出"两种世界。
 *   ⚠️ 迁移之后主账本里已无老 done 卡 ⇒ 本脚本'按卡龄收'通常会命中 0 张（**这是正常的**：
 *   例行瘦身改由「主线清账」链条（`board-archive-line.mjs`）承担，见方案 §8 #21 / K5）。
 *
 * 用法：
 *   node <workspace>\tools\board-archive-bulk.mjs                     # dry-run：列出会被收走的卡
 *   node <workspace>\tools\board-archive-bulk.mjs --keep-days 3       # 保留最近 3 天完成的不动
 *   node <workspace>\tools\board-archive-bulk.mjs --apply --emit-restore   # 真归档 + 生成回滚脚本
 *   node <workspace>\tools\board-archive-bulk.mjs --status done,failed     # 指定可归档状态（默认 done）
 *   --only <id1,id2>   只处理显式列出的卡（与卡龄条件取交集）
 *   --json             机读输出
 *
 * 退出码：0 成功 ／ 1 有卡归档失败 ／ 2 用法错 ／ 3 读不到 Host ／ 5 命中 0 张
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { readArchivedIdsSync } from './lib/board-archive-view.mjs'
import { ARCHIVE_DIR } from './lib/workspace.mjs'

const BASE = (process.env.DSH_BOARD_BASE || 'http://localhost:3080').replace(/\/+$/, '')
const STATE_URL = `${BASE}/api/task-board/state`
const ARCHIVE_URL = `${BASE}/api/task-board/archive`
const ACTION_URL = `${BASE}/api/task-board/action`
const HEADERS_GET = {
  origin: BASE,
  'sec-fetch-site': 'same-origin',
  accept: 'application/json',
  // K3：**显式**要整本（含归档卡）—— 迁移后归档卡不在主账本里，靠 Host 的合并视图带回来。
  'x-dsh-board-scope': 'all',
}
const HEADERS_POST = { ...HEADERS_GET, 'content-type': 'application/json' }
const TIMEOUT_MS = 60_000
const BATCH_LIMIT = 500 // 与插件 protocol.ts 的 archive-many 上限一致
const ARCHIVE_HOME = ARCHIVE_DIR

const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2
const EXIT_ENV = 3
const EXIT_ZERO = 5

function parseArgs(argv) {
  const o = { apply: false, emitRestore: false, json: false, keepDays: 3, statuses: ['done'], only: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') o.apply = true
    else if (a === '--emit-restore') o.emitRestore = true
    else if (a === '--json') o.json = true
    else if (a === '--keep-days') o.keepDays = Number(argv[++i])
    else if (a === '--status') o.statuses = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--only') o.only = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '-h' || a === '--help') return { help: true }
    else return { error: `未知参数：${a}` }
  }
  if (!Number.isFinite(o.keepDays) || o.keepDays < 0) return { error: '--keep-days 需要 >= 0 的数字' }
  const allowed = ['done', 'failed']
  const bad = o.statuses.filter((s) => !allowed.includes(s))
  if (bad.length) return { error: `--status 只支持 ${allowed.join('/')}（实得 ${bad.join(',')}）` }
  return o
}

async function fetchState() {
  const res = await fetch(STATE_URL, { headers: HEADERS_GET, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`state HTTP ${res.status}`)
  return await res.json()
}

async function postAction(action) {
  const res = await fetch(ACTION_URL, {
    method: 'POST',
    headers: HEADERS_POST,
    body: JSON.stringify({ requestId: randomUUID(), action }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 200) } }
  if (!res.ok) throw new Error(`action HTTP ${res.status}: ${body?.error ?? ''}`)
  return body
}

/** 卡的"完成时刻"：末条执行的 endedAt，退到 updatedAt / createdAt。 */
function finishedAt(task) {
  const last = Array.isArray(task.executions) && task.executions.length > 0
    ? task.executions[task.executions.length - 1]
    : undefined
  const v = last?.endedAt ?? task.updatedAt ?? task.createdAt
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * K3 · 物理搬出确认：读归档面拿到"真的在归档批次里"的 id 集合。
 * 两源：HTTP `GET /archive`（同实例、权威）→ 失败回退直读 `$DSH_HOME/task-board/archive*`。
 * `ok:false` = 未判定（该实例还没有归档读路由）—— **不改退出码**，只打印提示。
 */
async function physicalArchiveIds() {
  const out = { ok: false, ids: new Set(), sources: [], errors: [] }
  try {
    let offset = 0
    for (let page = 0; page < 50; page++) {
      const res = await fetch(`${ARCHIVE_URL}?limit=100&offset=${offset}`, {
        headers: HEADERS_GET,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (res.status === 404) { out.errors.push('GET /archive → 404（该实例无归档读路由）'); break }
      if (!res.ok) { out.errors.push(`GET /archive → HTTP ${res.status}`); break }
      let j = null
      try { j = await res.json() } catch { out.errors.push('GET /archive → 响应非 JSON'); break }
      const batches = Array.isArray(j?.batches) ? j.batches : []
      for (const b of batches) for (const id of b?.ids ?? []) out.ids.add(String(id))
      out.sources.push(`http(${batches.length} 批)`)
      if (j?.hasMore !== true || batches.length === 0) { out.ok = true; break }
      offset += batches.length
    }
  } catch (e) {
    out.errors.push(`GET /archive 失败：${e?.message ?? e}`)
  }
  if (!out.ok) {
    try {
      const local = readArchivedIdsSync()
      if (local.source === 'file' && local.count > 0) {
        for (const id of local.ids) out.ids.add(id)
        out.sources.push(`file(${local.batches} 批 / ${local.count} id)`)
        out.ok = true
      } else if (local.source === 'none') {
        out.sources.push('file(0 批)')
        out.ok = true
      } else {
        out.errors.push(`本地归档面不可判定：${local.reason}（home=${local.home}）`)
      }
    } catch (e) {
      out.errors.push(`本地归档面读取失败：${e?.message ?? e}`)
    }
  }
  return out
}

function writeRestoreScript(ids, stamp, meta) {
  const dir = path.join(ARCHIVE_HOME, `board-bulk-archive-${stamp}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'restore-bulk-archive.mjs')
  const body = `#!/usr/bin/env node
/**
 * 回滚 ${ids.length} 张卡的批量归档（${meta}）。
 * 由 board-archive-bulk.mjs 于 ${new Date().toLocaleString('zh-CN')} 生成。
 *   node restore-bulk-archive.mjs            # dry-run：列出将被恢复的卡
 *   node restore-bulk-archive.mjs --apply    # 真恢复（逐卡 restore，幂等）
 */
import { randomUUID } from 'node:crypto'
const BASE = '${BASE}'
const H = { origin: BASE, 'sec-fetch-site': 'same-origin', accept: 'application/json', 'content-type': 'application/json' }
const IDS = ${JSON.stringify(ids, null, 2)}
const apply = process.argv.includes('--apply')
let ok = 0, fail = 0
for (const id of IDS) {
  if (!apply) { console.log('would restore', id); continue }
  try {
    const res = await fetch(\`\${BASE}/api/task-board/action\`, { method: 'POST', headers: H,
      body: JSON.stringify({ requestId: randomUUID(), action: { kind: 'restore', taskId: id } }) })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    ok += 1
  } catch (e) { fail += 1; console.log('FAIL', id, e?.message ?? e) }
}
console.log(\`\${apply ? 'restore done' : 'dry-run'} · ok=\${apply ? ok : IDS.length} fail=\${fail}\`)
process.exitCode = fail === 0 ? 0 : 1
`
  fs.writeFileSync(file, body, 'utf8')
  return file
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 40).join('\n'))
  process.exitCode = EXIT_OK
} else if (args.error) {
  console.error(args.error)
  process.exitCode = EXIT_USAGE
} else {
  try {
    const state = await fetchState()
    const tasks = Array.isArray(state.tasks) ? state.tasks : []
    const now = Date.now()
    const cutoff = now - args.keepDays * 86_400_000
    const onlySet = args.only === null ? null : new Set(args.only)

    const live = tasks.filter((t) => t.archivedAt === undefined)
    const targets = live.filter((t) => {
      if (onlySet !== null && !onlySet.has(t.id)) return false
      if (!args.statuses.includes(String(t.status))) return false
      const at = finishedAt(t)
      if (at === null) return true // 时间戳缺失 → fail-closed 当"够老"，收走前会在输出里标出来
      return at < cutoff
    })
    const missingStamp = targets.filter((t) => finishedAt(t) === null).length

    const before = {
      revision: state.revision,
      totalCards: tasks.length,
      liveCards: live.length,
      archivedCards: tasks.length - live.length,
      stateBytes: Buffer.byteLength(JSON.stringify(state), 'utf8'),
    }

    if (args.json) {
      console.log(JSON.stringify({ mode: args.apply ? 'apply' : 'dry-run', keepDays: args.keepDays, before, targetCount: targets.length, missingStamp, targets: targets.map((t) => ({ id: t.id, title: t.title, status: t.status, finishedAt: finishedAt(t) })) }, null, 2))
    } else {
      console.log(`看板批量归档（${args.apply ? 'APPLY' : 'DRY-RUN'}）· 保留最近 ${args.keepDays} 天完成的卡 · 状态 ${args.statuses.join('/')}`)
      console.log(`  当前：全量 ${before.totalCards} 张（在板 ${before.liveCards} / 归档 ${before.archivedCards}）· state 响应 ${(before.stateBytes / 1024 / 1024).toFixed(2)} MB · revision ${before.revision}`)
      console.log(`  本批目标：${targets.length} 张${missingStamp ? `（其中 ${missingStamp} 张无完成时间戳，按"够老"处理）` : ''}`)
      for (const t of targets.slice(0, 8)) {
        const at = finishedAt(t)
        console.log(`    · [${t.status}] ${at === null ? '时间未知' : new Date(at).toLocaleDateString('zh-CN')} ${String(t.title).slice(0, 56)}`)
      }
      if (targets.length > 8) console.log(`    … 其余 ${targets.length - 8} 张`)
    }

    if (targets.length === 0) {
      console.log('（没有符合条件的卡；未写入任何数据）')
      process.exitCode = EXIT_ZERO
    } else if (!args.apply) {
      console.log('（dry-run 未写入任何数据；确认无误后加 --apply）')
      process.exitCode = EXIT_OK
    } else {
      const ids = targets.map((t) => t.id)
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      let archived = 0
      let failed = 0
      const doneIds = []
      for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
        const batch = ids.slice(i, i + BATCH_LIMIT)
        try {
          const r = await postAction({ kind: 'archive-many', taskIds: batch })
          archived += batch.length
          doneIds.push(...batch)
          console.log(`  批 ${Math.floor(i / BATCH_LIMIT) + 1}：${batch.length} 张已归档 → revision ${r?.revision ?? '?'}`)
        } catch (e) {
          failed += batch.length
          console.error(`  批 ${Math.floor(i / BATCH_LIMIT) + 1} 失败：${e?.message ?? e}`)
          if (batch.length === 1) continue
          // 整批失败 → 逐卡兜底，定位坏卡
          for (const id of batch) {
            try { await postAction({ kind: 'archive', taskId: id }); archived += 1; failed -= 1; doneIds.push(id) } catch { /* 已计入失败 */ }
          }
        }
      }
      let restoreFile = null
      if (args.emitRestore && doneIds.length > 0) restoreFile = writeRestoreScript(doneIds, stamp, `keep-days=${args.keepDays}`)
      const after = await fetchState()
      const afterBytes = Buffer.byteLength(JSON.stringify(after), 'utf8')
      const afterLive = (after.tasks ?? []).filter((t) => t.archivedAt === undefined).length
      console.log('')
      console.log(`归档完成：成功 ${archived} / 失败 ${failed}`)
      console.log(`  在板卡 ${before.liveCards} → ${afterLive}（-${before.liveCards - afterLive}）`)
      console.log(`  账本 revision ${before.revision} → ${after.revision}（+${after.revision - before.revision}，一次请求 = 一批 = 一次 commit）`)
      // K3 · 物理搬出确认（真判据 = 卡真的在归档批次里，而不是"打了归档标记"）
      if (doneIds.length > 0) {
        const ids = await physicalArchiveIds()
        const hit = doneIds.filter((id) => ids.ids.has(id)).length
        if (ids.ok && hit === doneIds.length) {
          console.log(`  物理搬出确认：${hit}/${doneIds.length} 张已在归档批次 ✅（来源 ${ids.sources.join(' + ') || '(无)'}）`)
        } else if (ids.ok) {
          console.log(`  物理搬出确认：${hit}/${doneIds.length} 张在归档批次 · ⚠ ${doneIds.length - hit} 张不在批次里（Host 可能仍是「打标记」旧语义，或批次文件未落）—— 请复核`)
        } else {
          console.log(`  物理搬出确认：未判定（${ids.errors.join('；') || '无归档面'}）—— 归档动作本身已成功；该实例部署 K1/K2 后此处会给出确切读数`)
        }
      }
      if (restoreFile !== null) console.log(`  逐卡回滚脚本：${restoreFile}`)
      process.exitCode = failed === 0 ? EXIT_OK : EXIT_FAIL
    }
  } catch (e) {
    console.error(`读取 Host 失败（fail-closed，未写入任何数据）：${e?.message ?? e}`)
    process.exitCode = EXIT_ENV
  }
}
