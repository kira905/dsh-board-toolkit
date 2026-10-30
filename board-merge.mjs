#!/usr/bin/env node
/**
 * board-merge.mjs —— 看板账本跨机并回器（对端侧执行 · 走 Host HTTP API，绝不手改 ledger）
 *
 * 输入：`board-snapshot-export.mjs` 在对端导出的快照 JSON（经仓3 同步过来）
 * 产出：把快照里"本机没有"的卡新建、"两边都有但内容/状态不同"的卡按保守规则合并，
 *       冲突全部列进报告等人工核，**不静默覆盖**。
 *
 * 铁律（照 task-board 技能）：
 *   · 绝不 edit ledger-v2.json —— 一律 POST /api/task-board/action（Host 校验 + 串行 + 原子写）
 *   · create 只能落 todo；backlog 要再补一次 move
 *   · 默认 dry-run：不带 --apply 只出报告，不写任何生产数据
 *   · apply 前自动备份账本 + scheduler 到 _archive\，并生成一键还原脚本（需停 DSH 执行）
 *
 * 用法：
 *   node <workspace>\tools\board-merge.mjs --snapshot <快照.json> --dry-run
 *   node <workspace>\tools\board-merge.mjs --snapshot <快照.json> --apply
 *   node <workspace>\tools\board-merge.mjs --self-test          # 纯逻辑自检，不联网不读生产
 *
 * 退出码：0 成功/无差异（**含"归档卡被跳过"与"归档批次卡被跳过"** —— 两类跳过都不计失败）· 1 用法或环境错 ·
 *         2 保守冲突（需人工核，与归档无关）· 3 apply 过程中有**真失败**
 *
 * ★归档卡纪律（2026-09-16 · 卡 AT18 修复）：
 *   Host 对 `archivedAt` 有值的卡**整卡只读**（update/move/confirm/reject 一律 HTTP 400
 *   `archived task is read-only`，见技能 task-board §0）。修复前并回对归档卡仍发起写入 ⇒
 *   每次并回恒报 N 条 400 并把 `--apply` 退出码打成 3（当成"并回失败"），真失败被淹没。
 *   现行为：**写入前按归档判定整卡跳过**（快照侧 / 本机侧任一归档即跳过），
 *   只计数（`plan.skippedArchived`）不写入、不计失败、不进冲突，报告单列一段。
 *   ⚠️ 快照侧判据依赖 `archivedAt` 字段——老快照（导出器 ≤ 2026-09-16）**不带该字段**，
 *   所以**本机侧判据（local.archivedAt）是主兜底**，两者都不满足才进正常并回流程。
 *
 * ★★ K3（2026-09-24 · 看板瘦身/归档物理化 · 方案 §8 #10 · `L3-2`）：**归档卡按 id 全量比对**。
 *   物理归档之后归档卡住在 `task-board/archive/<batchId>/cards.json`，**不在主账本**里。
 *   本机侧的"整本"来自 `GET /state`（**默认 scope=all** = Host 的
 *   `mergeBoardView(主账本, 全部批次)`，K2 已落地）⇒ 正常情况下归档卡照样出现在 `tasks` 里
 *   （带 `archivedAt`），走上面的 `archivedSkip` 就够。但**不能只靠它**：一旦合并视图失效
 *   （Host 版本旧 / 默认口径被改），归档卡就会"凭空消失" ⇒ 快照侧一张未归档的同 id 卡会被判成
 *   "本机没有"而**新建回在板**（把已归档的卡复活）。故本卡追加两道：
 *     · `hostState()` **显式**带 `x-dsh-board-scope: all`（把"我要整本"写进协议，防默认漂移）；
 *     · 另读一次归档批次 id 集合（`GET /archive` 的 `ids[]`；失败回退直读
 *       `archive-index.json` 与各批 `manifest.json`）⇒ 本机**在归档批次里**的 id **一律不新建**，
 *       单独计 `plan.skippedInArchiveBatch`（跳过**不计失败、不进冲突、不影响退出码**，与归档跳过同档）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readArchivedIdsSync } from './lib/board-archive-view.mjs';
import { DSH_WORKSPACE } from './lib/workspace.mjs';
import { cliGuard } from './lib/cli-args.mjs';

// 2026-09-14 环境边界：端口参数化。
// ⚠️ 宿主会注入 DSH_WEB_URL=http://127.0.0.1:3080（每个 DSH 会话都有）→ 显式 --port/$DSH_PORT
//    必须**优先于** DSH_WEB_URL，否则「在测试实例(3090)上跑」仍会打到生产 3080（实测过）。
const EXPLICIT_PORT = (() => {
  const i = process.argv.indexOf('--port');
  const raw = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : (process.env.DSH_PORT ?? null);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
})();
const BASE = EXPLICIT_PORT
  ? `http://127.0.0.1:${EXPLICIT_PORT}`
  : (process.env.DSH_WEB_URL || 'http://localhost:3080').replace(/\/+$/, '');   // 不设时与改造前逐字节一致
const DSH_ROOT = process.env.DSH_ROOT || DSH_WORKSPACE;
const H = { 'content-type': 'application/json', origin: BASE, 'sec-fetch-site': 'same-origin' };

// DSH 数据根：口径 BUTLER_DSH_HOME > DSH_HOME > ~/.dsh（2026-09-14 统一，与 tools/lib/dsh-home.mjs 同源）
function dshHome() { return process.env.BUTLER_DSH_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'); }
function ledgerPath() { return path.join(dshHome(), 'task-board', 'ledger-v2.json'); }

/**
 * 版本门（实测教训）：看板插件 1.0.0 不认 `line`/`seq`/`interrupted` 等新字段，
 * 一次写入就会把并回来的 line/seq 静默抹平，甚至丢卡（2026-09-11 主机 B 事故）。
 *
 * 判据双源（2026-09-13 实测补）：**别只信 package.json** —— 主机 A 生产实体的
 * package.json 停在 1.0.0（2026-09-09），而 lib 是 2026-09-11 的 1.1.0 代码
 * （含 `board.viewLine`/「主线视图」），只看声明值会误拦。故：
 *   声明 >= 1.1.0 → 放行；否则查 lib 代码特征串；特征在 → 放行（并标注来源）。
 */
function boardPluginInfo() {
  const dirs = [
    path.join(dshHome(), 'profiles', 'web', 'node_modules', 'dsh-task-board-local'),
    path.join(DSH_ROOT, 'tools', 'dsh-task-board-local'),
  ];
  for (const d of dirs) {
    let decl = null, libMtime = null, feature = false;
    try { decl = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).version ?? null; } catch { /* 无声明 */ }
    const lib = path.join(d, 'lib', 'client.js');
    try {
      libMtime = fs.statSync(lib).mtime;
      const text = fs.readFileSync(lib, 'utf8');
      feature = text.includes('board.viewLine') || text.includes('主线视图');
    } catch { /* 无 lib */ }
    if (decl || feature) return { dir: d, decl, libMtime, feature, gateOk: (decl ? versionAtLeast(decl) : false) || feature };
  }
  return null;
}
export function versionAtLeast(v, min = [1, 1, 0]) {
  const a = String(v).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) > min[i]) return true; if ((a[i] ?? 0) < min[i]) return false; }
  return true;
}
function snapshotDefault() {
  // 默认取 board-snapshots 目录里最新的快照（按 mtime），省得手抄文件名
  // 注：刻意不用 `tools/dsh-butler/snapshots/`（仓3 .gitignore 忽略 `snapshots/` → 同步不过来）
  const dir = path.join(DSH_ROOT, 'tools', 'board-snapshots');
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (files.length) return path.join(dir, files[0].f);
  } catch { /* 目录不存在则由调用方报错 */ }
  return path.join(dir, 'board-snapshot.json');
}

// ---------------------------------------------------------------- 纯逻辑（可单测）

/** 状态推进序：数字大 = 更靠后。running/review 是本机运行时态，另判。 */
const RANK = { backlog: 0, todo: 1, running: 2, review: 3, failed: 4, done: 5 };
const LOCAL_RUNTIME = new Set(['running', 'review']); // 本机运行态：并回不碰

/** 归档判定：`archivedAt` 有值即归档（真实形态两种：毫秒时间戳 1789542591405 / ISO 字符串） */
export function isArchived(t) {
  if (!t || typeof t !== 'object') return false;
  const a = t.archivedAt;
  return a !== undefined && a !== null && a !== '';
}
const fmtArchived = (a) => (typeof a === 'number' ? new Date(a).toISOString() : String(a ?? ''));

/**
 * 并回前的「归档卡」跳过判据（2026-09-16 · 卡 AT18）。
 * 归档卡在 Host 侧只读 ⇒ 任何写入都必定 400；这里在**写入前**整卡跳过。
 * @returns {null | {side:'snapshot'|'local'|'both', reason:string}}
 */
export function archivedSkip(spec, local) {
  const sArch = isArchived(spec), lArch = isArchived(local);
  if (!sArch && !lArch) return null;
  if (sArch && lArch) {
    return { side: 'both', reason: `两侧均已归档（本机 archivedAt=${fmtArchived(local.archivedAt)}）→ 归档卡只读，不写入` };
  }
  if (sArch) {
    return { side: 'snapshot', reason: `快照卡已归档（${fmtArchived(spec.archivedAt)}）${local ? '、本机卡未归档' : '、本机无此卡'} → 不新建/不更新（不复活归档卡；本机若要跟进请手工 archive）` };
  }
  return { side: 'local', reason: `本机卡已归档（archivedAt=${fmtArchived(local.archivedAt)}）、快照卡未归档 → Host 必拒写（archived task is read-only），跳过` };
}

/**
 * 决定一张"两边都有"的卡怎么处理。
 * @returns {{action:'unchanged'|'update'|'skip', fields?:object, reasons:string[], conflicts:string[]}}
 */
export function planExisting(spec, local) {
  const fields = {};
  const reasons = [];
  const conflicts = [];
  const executed = Array.isArray(local.executions) && local.executions.length > 0;

  // 先判"整卡是否有差异"：全等走快路径，避免给 100% 相同的卡刷冲突噪音
  const touched = ['title', 'prompt', 'description', 'line', 'seq']
    .some((f) => norm(spec[f]) !== norm(local[f])) || spec.status !== local.status;
  if (!touched) return { action: 'unchanged', reasons, conflicts };

  // ① 状态：本机已在跑/待验收 → 一律不碰；否则按推进序，只前进不后退
  if (LOCAL_RUNTIME.has(local.status)) {
    if (spec.status !== local.status) conflicts.push(`状态：本机=${local.status}（运行时态，保留） vs 快照=${spec.status}`);
  } else if (RANK[spec.status] > RANK[local.status]) {
    fields.status = spec.status; reasons.push(`状态推进 ${local.status}→${spec.status}`);
  } else if (RANK[spec.status] < RANK[local.status]) {
    conflicts.push(`状态：本机=${local.status} 比快照=${spec.status} 靠后 → 保留本机`);
  }

  // ② 只读字段（执行过的卡在 Host 侧也改不动）
  for (const f of ['title', 'prompt']) {
    const a = norm(spec[f]), b = norm(local[f]);
    if (a === b) continue;
    if (executed) conflicts.push(`${f}：本机已执行（Host 只读），快照版不同 → 保留本机`);
    else { fields[f] = spec[f]; reasons.push(`${f} 更新（本机未执行）`); }
  }

  // ③ 归属与说明：只补空 + 更长者胜，绝不丢本机文字
  for (const f of ['line', 'seq']) {
    const a = norm(spec[f]), b = norm(local[f]);
    if (!a || a === b) continue;
    if (!b) { fields[f] = spec[f]; reasons.push(`${f} 补空 "${spec[f]}"`); }
    else conflicts.push(`${f}：本机="${local[f]}" vs 快照="${spec[f]}" → 保留本机`);
  }
  const sd = norm(spec.description), ld = norm(local.description);
  if (sd && sd !== ld) {
    if (sd.includes(ld) || sd.length > ld.length) {
      fields.description = spec.description; reasons.push(`description 采用更长/包含版（${ld.length}→${sd.length}）`);
    } else conflicts.push(`description：本机版更长（${ld.length} vs ${sd.length}）→ 保留本机`);
  }

  if (!Object.keys(fields).length && !reasons.length) return { action: 'unchanged', reasons, conflicts };
  return { action: Object.keys(fields).length ? 'update' : 'skip', fields, reasons, conflicts };
}

const norm = (s) => String(s ?? '').replace(/\s+/g, '');
const shortTitle = (t, n = 56) => { const s = String(t ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };

/**
 * K3 · 「本机归档批次」跳过判据（纯函数，可单测）。
 *
 * 触发条件：**本机主账本里没有这张卡**（`local === undefined`）**而它在本机的归档批次里**
 * （物理搬出已发生）。此时快照侧若有一张**未带 `archivedAt`** 的同 id 卡（对端旧版 / 对端把它
 * restore 过 / 老快照不带该字段），正常流程会把它判成"本机没有 ⇒ 新建" ⇒ **把归档卡复活回在板**。
 *
 * @param {object} spec 快照侧的卡
 * @param {object|undefined} local 本机主账本里的同 id 卡（`undefined` = 本机没有）
 * @param {Set<string>|null} archivedIds 本机归档批次的 id 集合（`null` = 归档面不可得）
 * @returns {null | {side:'archive-batch', reason:string}}
 */
export function archiveBatchSkip(spec, local, archivedIds) {
  if (local !== undefined) return null;                       // 主账本里有 ⇒ 交给 archivedSkip / planExisting
  if (!archivedIds || archivedIds.size === 0) return null;     // 归档面不可得 ⇒ 保持既有行为（不假装跳过）
  if (!spec || typeof spec.id !== 'string' || !archivedIds.has(spec.id)) return null;
  return {
    side: 'archive-batch',
    reason: '本机已把该卡物理归档（在归档批次里、不在主账本）→ 不新建（Host 侧归档卡只读；要跟进请先 restore 该批次）',
  };
}

/**
 * K3 · 读"本机归档批次 id 集合"（两源并集，**保守优先**）。
 *
 *   ① `GET /archive?limit=<n>`（Host 权威、与 baseUrl 同实例；批次摘要带 `ids[]`，K2 交付）
 *   ② 直读 `$DSH_HOME/task-board/archive*`（新模块 `lib/board-archive-view.mjs`；零 Host 负载）
 *
 * 为什么取并集而不是"取到就用"：并集只会让我们"多跳过几处"，而跳过是**可见且可人工接手**的
 * （报告单列一段）；反过来漏跳过会**静默复活归档卡**。两源不一致的代价（例如 baseUrl 指向
 * 测试实例、而 DSH_HOME 指生产）在这里可以接受，报告里会把来源与张数如实写出来。
 */
async function archiveBatchIdSet() {
  const out = { ids: new Set(), sources: [], errors: [] };

  // ① Host 归档读路由
  try {
    let offset = 0;
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 50) { out.errors.push('归档批次分页超过 50 页（异常）→ 停止翻页'); break; }
      const res = await fetch(`${BASE}/api/task-board/archive?limit=100&offset=${offset}`, { headers: H });
      if (res.status === 404) { out.errors.push('GET /archive → 404（该实例无归档读路由）'); break; }
      if (!res.ok) { out.errors.push(`GET /archive → HTTP ${res.status}`); break; }
      let j = null;
      try { j = await res.json(); } catch { out.errors.push('GET /archive → 响应非 JSON'); break; }
      const batches = Array.isArray(j?.batches) ? j.batches : [];
      for (const b of batches) for (const id of b?.ids ?? []) out.ids.add(String(id));
      out.sources.push(`http(/archive · ${batches.length} 批)`);
      if (j?.hasMore !== true || batches.length === 0) break;
      offset += batches.length;
    }
  } catch (e) {
    out.errors.push(`GET /archive 失败：${e?.message ?? e}`);
  }

  // ② 直读文件（失败不影响主流程，只记错误）
  try {
    const local = readArchivedIdsSync();
    if (local.source === 'file' && local.count > 0) {
      for (const id of local.ids) out.ids.add(id);
      out.sources.push(`file(${local.home} · ${local.batches} 批 / ${local.count} id)`);
    } else if (local.source === 'unavailable') {
      out.errors.push(`本地归档面不可判定：${local.reason}（home=${local.home}）`);
    } else if (local.source === 'file') {
      out.sources.push(`file(${local.home} · 0 批)`);
    }
    for (const e of local.errors ?? []) out.errors.push(`本地归档面：${e}`);
  } catch (e) {
    out.errors.push(`本地归档面读取失败：${e?.message ?? e}`);
  }

  return out;
}

// ---------------------------------------------------------------- Host API

async function hostState() {
  // K3：**显式**要整本（Host 的 all = mergeBoardView(主账本, 全部归档批次)）。
  const res = await fetch(`${BASE}/api/task-board/state`, { headers: { ...H, 'x-dsh-board-scope': 'all' } });
  if (!res.ok) throw new Error(`GET /state 失败 HTTP ${res.status}`);
  return res.json();
}

async function post(action) {
  const res = await fetch(`${BASE}/api/task-board/action`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ requestId: randomUUID(), action }),
  });
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON 响应 */ }
  if (!res.ok || body?.ok === false) {
    throw new Error(`action ${action.kind} 失败 HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

// ---------------------------------------------------------------- 备份 / 还原

function makeBackup(reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(DSH_ROOT, '_archive', `board-merge-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const lp = ledgerPath();
  const sp = path.join(dshHome(), 'task-board', 'scheduler-v2.json');
  const entries = [];
  for (const [label, src] of [['ledger-v2.json', lp], ['scheduler-v2.json', sp]]) {
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dir, label);
    fs.copyFileSync(src, dst);
    entries.push({ label, src, dst, bytes: fs.statSync(dst).size });
  }
  const meta = { reason, createdAt: new Date().toISOString(), host: os.hostname(), entries };
  fs.writeFileSync(path.join(dir, 'backup.json'), JSON.stringify(meta, null, 2), 'utf8');

  const restore = `#!/usr/bin/env node
// 一键还原看板账本（board-merge 备份回滚）—— 必须在 DSH 停止状态下执行
// 用法： node restore.mjs [--yes]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const meta = JSON.parse(fs.readFileSync(path.join(HERE, 'backup.json'), 'utf8'));
if (!process.argv.includes('--yes')) {
  console.log('将把下列文件还原成备份版本（需 DSH 已停止，否则运行中的 Host 会把内存态再写回去）：');
  for (const e of meta.entries) console.log('  ' + e.src + '   ←  备份 ' + e.label);
  console.log('备份时间：' + meta.createdAt + '（原因：' + meta.reason + '）');
  console.log('确认无误请重跑： node ' + fileURLToPath(import.meta.url) + ' --yes');
  process.exitCode = 0;
} else {
  for (const e of meta.entries) { fs.copyFileSync(path.join(HERE, e.label), e.src); console.log('✔ 已还原 ' + e.src); }
  console.log('请重新启动 DSH： ' + path.join(DSH_ROOT, 'dsh-start.cmd'));
  process.exitCode = 0;
}
`;
  fs.writeFileSync(path.join(dir, 'restore.mjs'), restore, 'utf8');
  return { dir, entries };
}

function recordChangelog(text) {
  const cli = path.join(DSH_ROOT, 'tools', 'dsh-butler', 'changelog-add.mjs');
  if (!fs.existsSync(cli)) return 'skip(no cli)';
  try {
    const r = spawnSync(process.execPath, [cli, '--text', text], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return r.status === 0 ? 'ok' : `fail(${r.status})`;
  } catch (e) { return `err(${String(e?.message ?? e).slice(0, 60)})`; }
}

// ---------------------------------------------------------------- 主流程

async function run(opts) {
  const snapPath = opts.snapshot;
  if (!fs.existsSync(snapPath)) { console.error(`✖ 快照不存在：${snapPath}`); process.exitCode = 1; return; }
  const spec = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  if (spec.kind !== 'task-board-merge-snapshot' || !Array.isArray(spec.tasks)) {
    console.error('✖ 不是有效的并回快照（kind/tasks 不匹配）'); process.exitCode = 1; return;
  }

  let state;
  try { state = await hostState(); }
  catch (e) { console.error(`✖ 读不到本机看板（DSH 没起？）：${e.message}`); process.exitCode = 1; return; }

  // 版本门：旧看板会静默抹平 line/seq 甚至丢卡
  const bpv = boardPluginInfo();
  const verOk = bpv ? bpv.gateOk : null;
  console.log(`── 并回 ${opts.apply ? '【APPLY】' : '【DRY-RUN】'} ──────────────────────────`);
  if (bpv) {
    const how = bpv.decl && versionAtLeast(bpv.decl) ? `声明 ${bpv.decl}` : (bpv.feature ? `声明 ${bpv.decl ?? '无'}（陈旧）但实测代码含 1.1.0 特性` : `声明 ${bpv.decl ?? '无'} 且代码无 1.1.0 特性`);
    console.log(`看板插件：${how}${verOk ? ' ✅' : '  ⛔ 低于 1.1.0'}  ← ${bpv.dir}`);
  } else console.log('看板插件：读不到版本（按未知处理）');
  if (verOk === false) {
    const msg = '当前看板插件不认 line/seq/enum 新值，并回会被静默抹平（2026-09-11 事故）→ 先升级看板插件：node <workspace>/tools/dsh-task-board-local/deploy.mjs（源码见 dsh-task-board-local 仓；升级前确认 line/seq 收尾卡已完成）';
    console.error(`⛔ ${msg}`);
    if (opts.apply) { console.error('已拒绝 apply。'); process.exitCode = 1; return; }
    console.warn('（dry-run 继续，但你看到的只是"如果版本够新"的规划）');
  }

  const localTasks = state.tasks ?? [];
  const localById = new Map(localTasks.map(t => [t.id, t]));
  const localByTitle = new Map(localTasks.map(t => [norm(t.title), t]));
  // workspaceId：用本机现有卡（避免造出孤儿卡）
  const ws = localTasks[0]?.workspaceId ?? null;

  // K3 · 本机归档批次的 id 集合（防"归档卡复活"；两源并集，失败只记错误不阻断）
  const archiveIds = await archiveBatchIdSet();
  if (archiveIds.ids.size || archiveIds.errors.length) {
    console.log(`归档面：本机归档批次 ${archiveIds.ids.size} 个 id · 来源 ${archiveIds.sources.join(' + ') || '(无)'}${archiveIds.errors.length ? ` · ⚠ ${archiveIds.errors.join('；')}` : ''}`);
  } else {
    console.log('归档面：本机无归档批次（或该实例尚无归档读路由）—— 只按 archivedAt 判据跳过');
  }

  const toCreate = [], toUpdate = [], unchanged = [], skipped = [], skippedArchived = [], skippedInArchiveBatch = [], conflicts = [];
  for (const s of spec.tasks) {
    const local = localById.get(s.id);
    // ⓪ 归档卡：写入前整卡跳过（Host 对 archivedAt 有值的卡一律 400，见文件头「归档卡纪律」）
    const arch = archivedSkip(s, local);
    if (arch) { skippedArchived.push({ spec: s, side: arch.side, reason: arch.reason }); continue; }
    // ⓪b K3：本机已物理归档（卡在批次里、主账本里没有）⇒ 同样不新建（防归档卡复活）
    const inBatch = archiveBatchSkip(s, local, archiveIds.ids);
    if (inBatch) { skippedInArchiveBatch.push({ spec: s, side: inBatch.side, reason: inBatch.reason }); continue; }
    if (!local) {
      const twin = localByTitle.get(norm(s.title));
      if (twin) conflicts.push(`[新建前拦下] 快照卡「${shortTitle(s.title)}」与本机卡 ${twin.id.slice(0, 8)} 同标题（可能已被本机重建）→ 未新建，人工核对`);
      else toCreate.push(s);
      continue;
    }
    const p = planExisting(s, local);
    for (const c of p.conflicts) conflicts.push(`[${shortTitle(s.title)}] ${c}`);
    if (p.action === 'unchanged') unchanged.push(s);
    else if (p.action === 'update') toUpdate.push({ spec: s, local, fields: p.fields, reasons: p.reasons });
    else skipped.push({ spec: s, reasons: p.reasons });
  }

  const report = {
    host: os.hostname(), snapshot: { file: snapPath, fromHost: spec.fromHost, exportedAt: spec.exportedAt, revision: spec.sourceRevision, taskCount: spec.taskCount },
    local: { revision: state.revision, taskCount: localTasks.length, workspaceId: ws },
    mode: opts.apply ? 'apply' : 'dry-run',
    boardPlugin: { dir: bpv?.dir ?? null, declared: bpv?.decl ?? null, codeFeature11: bpv?.feature ?? null, gateOk: verOk },
    plan: { create: toCreate.length, update: toUpdate.length, unchanged: unchanged.length, skipped: skipped.length, skippedArchived: skippedArchived.length, skippedInArchiveBatch: skippedInArchiveBatch.length, conflicts: conflicts.length },
    details: {
      create: toCreate.map(t => `[${t.status}] ${t.line ?? '(未归线)'} ${t.seq ?? ''} :: ${t.title}`),
      update: toUpdate.map(u => `${shortTitle(u.spec.title)} ← ${u.reasons.join('；')}`),
      skipped: skipped.map(s => `${shortTitle(s.spec.title)} ← ${s.reasons.join('；') || '无变化'}`),
      skippedArchived: skippedArchived.map(s => `[归档·${s.side === 'snapshot' ? '快照侧' : s.side === 'local' ? '本机侧' : '两侧'}] ${shortTitle(s.spec.title)} ← ${s.reason}`),
      skippedInArchiveBatch: skippedInArchiveBatch.map(s => `[归档批次] ${shortTitle(s.spec.title)} ← ${s.reason}`),
      conflicts,
    },
    // 结构化归档跳过清单（机器可读：供对账脚本判断"这次并回跳过了哪些归档卡"）
    archivedSkipped: skippedArchived.map(s => ({ id: s.spec.id, title: s.spec.title, side: s.side, status: s.spec.status ?? null, reason: s.reason })),
    // K3：本机在**归档批次**里的卡（物理搬出）被跳过的清单（机器可读）
    archiveBatchSkipped: skippedInArchiveBatch.map(s => ({ id: s.spec.id, title: s.spec.title, side: s.side, status: s.spec.status ?? null, reason: s.reason })),
    archiveView: { ids: archiveIds.ids.size, sources: archiveIds.sources, errors: archiveIds.errors },
    applied: [], failures: [],
  };

  console.log(`快照：${path.basename(snapPath)} 来自 ${spec.fromHost} @ ${spec.exportedAt}（rev ${spec.sourceRevision} · ${spec.taskCount} 卡）`);
  console.log(`本机：${report.host} rev ${state.revision} · ${localTasks.length} 卡 · workspace=${ws ?? '(无)'}`);
  console.log(`计划：新建 ${toCreate.length} / 更新 ${toUpdate.length} / 无变化 ${unchanged.length} / 归档跳过 ${skippedArchived.length} / 归档批次跳过 ${skippedInArchiveBatch.length} / 仅冲突跳过 ${skipped.length} / 冲突 ${conflicts.length}`);
  if (toCreate.length) { console.log('\n【将新建】'); for (const l of report.details.create) console.log('  + ' + l); }
  if (toUpdate.length) { console.log('\n【将更新】'); for (const l of report.details.update) console.log('  ~ ' + l); }
  if (skippedArchived.length) { console.log('\n【归档跳过（只读，不写入·不计失败）】'); for (const l of report.details.skippedArchived) console.log('  ⊘ ' + l); }
  if (skippedInArchiveBatch.length) { console.log('\n【归档批次跳过（本机已物理归档，不写入·不计失败）】'); for (const l of report.details.skippedInArchiveBatch) console.log('  ⊘ ' + l); }
  if (conflicts.length) { console.log('\n【冲突（不动，人工核）】'); for (const c of report.details.conflicts) console.log('  ! ' + c); }

  if (!opts.apply) {
    console.log('\n（dry-run 未改动任何数据。确认无误后加 --apply）');
    report.exit = exitInfo(report);
    writeReport(report, snapPath, opts);
    console.log(`退出码：${report.exit.code} —— ${report.exit.meaning}`);
    process.exitCode = report.exit.code;
    return;
  }

  if (!ws) { console.error('✖ 本机看板没有任何卡，拿不到 workspaceId → 拒绝 apply（先手工建一张卡或用 --workspace 指定）'); process.exitCode = 1; return; }

  // 账本活跃度护栏：Host 上一刻刚写过 → 提醒
  try {
    const ageMs = Date.now() - fs.statSync(ledgerPath()).mtimeMs;
    if (ageMs < 5000) console.warn(`⚠ 账本 ${Math.round(ageMs / 1000)}s 前刚被写过（可能有卡在跑）→ 并回本身幂等安全，但执行中的卡不保证不含并发变更`);
  } catch { /* 文件不可读则忽略 */ }

  const backup = makeBackup(`board-merge from ${spec.fromHost} @ ${spec.exportedAt}`);
  report.backup = backup;
  console.log(`\n✔ 已备份账本 → ${backup.dir}（含 restore.mjs）`);

  for (const s of toCreate) {
    try {
      const input = {
        title: s.title, description: s.description ?? '', prompt: s.prompt ?? '',
        workspaceId: ws, permission: s.permission ?? 'danger-full-access', kind: s.kind ?? 'once',
      };
      if (s.line) input.line = s.line;
      if (s.seq) input.seq = s.seq;
      await post({ kind: 'create', id: s.id, input });
      if (s.status === 'backlog') { await post({ kind: 'move', taskId: s.id, status: 'backlog' }); }
      else if (s.status === 'done') { await post({ kind: 'move', taskId: s.id, status: 'done' }); }
      report.applied.push(`create:${s.id} [${s.status}] ${shortTitle(s.title)}`);
      console.log(`  ✔ 新建 [${s.status}] ${shortTitle(s.title)}`);
    } catch (e) {
      report.failures.push(`create:${s.id} ${e.message}`);
      console.error(`  ✖ 新建失败 ${shortTitle(s.title)} → ${e.message}`);
    }
  }

  for (const u of toUpdate) {
    const patch = { ...u.fields };
    const { status, ...rest } = patch;
    try {
      if (Object.keys(rest).length) await post({ kind: 'update', taskId: u.spec.id, patch: rest });
      if (status && status !== u.local.status) {
        if (LOCAL_RUNTIME.has(u.local.status)) throw new Error(`本机处于 ${u.local.status}，拒绝 move`);
        if (status === 'done' || status === 'backlog' || status === 'todo') {
          await post({ kind: 'move', taskId: u.spec.id, status });
        } else {
          report.failures.push(`status:${u.spec.id} 目标态 ${status} 不可用 move 直达（需 runner/人工）`);
          console.error(`  ~ 跳过状态推进 ${shortTitle(u.spec.title)} → ${status}（move 不支持）`);
        }
      }
      report.applied.push(`update:${u.spec.id} ${shortTitle(u.spec.title)} ← ${u.reasons.join('；')}`);
      console.log(`  ~ 更新 ${shortTitle(u.spec.title)}`);
    } catch (e) {
      report.failures.push(`update:${u.spec.id} ${e.message}`);
      console.error(`  ✖ 更新失败 ${shortTitle(u.spec.title)} → ${e.message}`);
    }
  }

  // 结账复核
  try {
    const after = await hostState();
    report.after = { revision: after.revision, taskCount: (after.tasks ?? []).length };
    const expect = localTasks.length + report.applied.filter(a => a.startsWith('create:')).length;
    console.log(`\n结账：本机 ${localTasks.length} → ${report.after.taskCount} 卡（预期 ${expect}） rev ${state.revision} → ${report.after.revision}`);
    if (report.after.taskCount !== expect) console.warn('⚠ 卡数与预期不符 → 请看报告 failures 段');
  } catch (e) { console.warn(`⚠ 结账复核失败：${e.message}`); }

  report.exit = exitInfo(report);
  report.changelog = recordChangelog(`看板账本跨机并回（来自 ${spec.fromHost}）：新建 ${report.applied.filter(a => a.startsWith('create:')).length} / 更新 ${report.applied.filter(a => a.startsWith('update:')).length} / 归档跳过 ${report.plan.skippedArchived} / 冲突 ${conflicts.length}｜备份 ${backup.dir}`);
  const reportFile = writeReport(report, snapPath, opts);
  console.log(`\n报告：${reportFile}`);
  console.log(`回滚：停 DSH 后跑 node ${path.join(backup.dir, 'restore.mjs')} --yes`);
  console.log(`退出码：${report.exit.code} —— ${report.exit.meaning}`);
  process.exitCode = report.exit.code;
}

/**
 * 退出码三态 + 含义（同时写进报告 JSON 的 `exit` 字段并打印）。
 * 为什么要显式打印：2026-09-16 主机 B 侧把"归档卡 400 导致的 failures"读成"并回失败"，
 * 也把非 0 一律当失败 —— 归档跳过**不**参与退出码判定，冲突/真失败才参与。
 */
export function exitInfo(report) {
  const failures = report.failures?.length ?? 0;
  const conflicts = report.details?.conflicts?.length ?? 0;
  const skippedArchived = report.plan?.skippedArchived ?? 0;
  const skippedInArchiveBatch = report.plan?.skippedInArchiveBatch ?? 0;
  const code = failures ? 3 : (conflicts ? 2 : 0);
  const meaning = failures
    ? `有 ${failures} 条真失败（见报告「失败项」段）`
    : conflicts
      ? `并回本身无失败，但有 ${conflicts} 条保守冲突待人工核（与归档无关）`
      : `并回成功、无真失败（归档卡只读跳过 ${skippedArchived} 张、本机已物理归档批次跳过 ${skippedInArchiveBatch} 张，两类都不计失败、不影响退出码）`;
  return { code, meaning, hasFailures: failures > 0, failures, conflicts, skippedArchived, skippedInArchiveBatch };
}

function writeReport(report, snapPath, opts) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = opts.apply && report.backup ? report.backup.dir : path.join(DSH_ROOT, '_archive', `board-merge-dryrun-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'merge-report.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  const md = path.join(dir, 'merge-report.md');
  fs.writeFileSync(md, renderMarkdown(report, snapPath), 'utf8');
  return md;
}

export function renderMarkdown(report, snapPath) {
  const L = [];
  L.push(`# 看板账本并回报告（${report.mode}）`, '');
  L.push(`- 本机：**${report.host}**（rev ${report.local.revision} · ${report.local.taskCount} 卡）`);
  L.push(`- 快照：\`${path.basename(snapPath)}\` 来自 **${report.snapshot.fromHost}** @ ${report.snapshot.exportedAt}（rev ${report.snapshot.revision} · ${report.snapshot.taskCount} 卡）`);
  L.push(`- 计划：新建 ${report.plan.create} / 更新 ${report.plan.update} / 无变化 ${report.plan.unchanged} / 归档跳过 ${report.plan.skippedArchived ?? 0} / 归档批次跳过 ${report.plan.skippedInArchiveBatch ?? 0} / 冲突跳过 ${report.plan.skipped} / 冲突 ${report.plan.conflicts}`);
  if (report.archiveView) L.push(`- 本机归档面：${report.archiveView.ids ?? 0} 个 id · 来源 ${(report.archiveView.sources ?? []).join(' + ') || '(无)'}${(report.archiveView.errors ?? []).length ? ` · ⚠ ${report.archiveView.errors.join('；')}` : ''}`);
  if (report.backup) L.push(`- 备份：\`${report.backup.dir}\`（含 restore.mjs，停 DSH 后执行）`);
  if (report.after) L.push(`- 结账：${report.local.taskCount} → ${report.after.taskCount} 卡，rev ${report.local.revision} → ${report.after.revision}`);
  if (report.exit) L.push(`- 退出码：**${report.exit.code}** —— ${report.exit.meaning}`);
  const sec = (title, arr) => { if (!arr?.length) return; L.push('', `## ${title}`, ''); for (const x of arr) L.push(`- ${x}`); };
  sec('将新建', report.details.create);
  sec('将更新', report.details.update);
  sec('归档跳过（只读，未写入、不计失败）', report.details.skippedArchived);
  sec('归档批次跳过（本机已物理归档，未写入、不计失败）', report.details.skippedInArchiveBatch);
  sec('仅冲突跳过', report.details.skipped);
  sec('冲突（不动，需人工核）', report.details.conflicts);
  sec('已应用', report.applied);
  sec('失败项', report.failures);
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- 自检

function selfTest() {
  let pass = 0; const fail = [];
  const ok = (c, m) => { if (c) pass++; else fail.push(m); };
  const base = { id: 'a', title: 'T', description: 'd', prompt: 'p', status: 'todo', permission: 'danger-full-access', kind: 'once', line: 'L', seq: 'S' };

  // 状态推进
  let p = planExisting({ ...base, status: 'done' }, { ...base, executions: [] });
  ok(p.action === 'update' && p.fields.status === 'done', 'todo→done 应推进状态');
  p = planExisting({ ...base, status: 'backlog' }, base);
  ok(p.action !== 'update' || p.fields.status === undefined, '不允许状态回退');
  // 本机运行态保护
  p = planExisting({ ...base, status: 'done' }, { ...base, status: 'running', executions: [{}] });
  ok(p.fields?.status === undefined && p.conflicts.some(c => c.includes('运行时态')), '本机 running 不得被覆盖');
  p = planExisting({ ...base, status: 'done' }, { ...base, status: 'review', executions: [{}] });
  ok(p.fields?.status === undefined, '本机 review 不得被覆盖');
  // 已执行卡的只读字段
  p = planExisting({ ...base, title: 'NEW' }, { ...base, executions: [{}] });
  ok(p.fields?.title === undefined && p.conflicts.some(c => c.includes('title')), '已执行卡 title 不得改');
  p = planExisting({ ...base, title: 'NEW' }, { ...base, executions: [] });
  ok(p.fields?.title === 'NEW', '未执行卡 title 可更新');
  // line/seq 补空
  p = planExisting({ ...base, line: 'X', seq: '' }, { ...base, line: '', seq: '' });
  ok(p.fields?.line === 'X', 'line 应补空');
  p = planExisting({ ...base, line: 'X' }, base);
  ok(p.fields?.line === undefined && p.conflicts.some(c => c.includes('line')), 'line 冲突应保留本机');
  // description 更长者胜
  p = planExisting({ ...base, description: 'longer text here' }, { ...base, description: 'short' });
  ok(typeof p.fields?.description === 'string', 'description 应采用更长版');
  p = planExisting({ ...base, description: 'x' }, { ...base, description: 'much longer local text' });
  ok(p.fields?.description === undefined, 'description 本机更长时应保留本机');
  // 全等
  p = planExisting(base, base);
  ok(p.action === 'unchanged' && !p.conflicts.length, '全等应判 unchanged 且无冲突');
  // —— 归档卡跳过判据（2026-09-16 · 卡 AT18 修复的回归锚）——
  ok(!isArchived({}) && !isArchived({ archivedAt: '' }) && !isArchived({ archivedAt: null }) && !isArchived({ archivedAt: undefined }),
    'archivedAt 缺失/空串/null → 非归档');
  ok(isArchived({ archivedAt: 1789542591405 }), '毫秒时间戳 archivedAt → 归档（生产真实形态）');
  ok(isArchived({ archivedAt: '2026-09-14T23:28:25.000Z' }), 'ISO 字符串 archivedAt → 归档');
  ok(archivedSkip(base, base) === null, '两侧均未归档 → 不跳过（正常并回）');
  ok(archivedSkip({ ...base, archivedAt: 1 }, base)?.side === 'snapshot', '快照侧已归档 → 跳过（side=snapshot）');
  ok(archivedSkip(base, { ...base, archivedAt: 1 })?.side === 'local',
    '本机侧已归档 → 跳过（side=local，老快照无 archivedAt 时的主兜底路径）');
  ok(archivedSkip({ ...base, archivedAt: 1 }, { ...base, archivedAt: 1 })?.side === 'both', '两侧均归档 → 跳过（side=both）');
  ok(archivedSkip({ ...base, archivedAt: 1 }, null)?.side === 'snapshot', '本机无此卡且快照已归档 → 跳过（不复活归档卡）');
  // —— K3：本机已物理归档（卡在批次里、主账本没有）时不得新建 ——
  const archIds = new Set(['a', 'z']);
  ok(archiveBatchSkip(base, undefined, archIds)?.side === 'archive-batch',
    '本机无此卡但在归档批次里 + 快照侧未归档 → 跳过（防归档卡复活；这是物理搬出后的主判据）');
  ok(archiveBatchSkip(base, undefined, archIds) === null || archiveBatchSkip({ ...base, id: 'nope' }, undefined, archIds) === null,
    '不在归档批次里的新卡 → 照常新建（不误拦）');
  ok(archiveBatchSkip(base, base, archIds) === null, '本机主账本里有该卡 → 交给 planExisting（本判据不介入）');
  ok(archiveBatchSkip(base, undefined, null) === null && archiveBatchSkip(base, undefined, new Set()) === null,
    '归档面不可得（null/空集）→ 退回既有行为（不假装跳过）');
  // —— 退出码语义（归档跳过不计失败；真失败仍非零）——
  const mkRep = (f, c, a) => ({ plan: { skippedArchived: a }, details: { conflicts: Array(c).fill('x') }, failures: Array(f).fill('y') });
  ok(exitInfo(mkRep(0, 0, 5)).code === 0, '归档跳过 5 张 + 无失败无冲突 → 退出码 0（回归锚：修复前恒为 3）');
  ok(exitInfo(mkRep(0, 3, 5)).code === 2 && exitInfo(mkRep(0, 3, 5)).hasFailures === false, '无失败有冲突 → 2，且 hasFailures=false');
  ok(exitInfo(mkRep(2, 0, 5)).code === 3 && exitInfo(mkRep(2, 0, 5)).hasFailures === true, '真失败 → 3（反向锚：不许被归档跳过吃掉）');
  // K3：归档**批次**跳过与归档跳过同档 —— 不计失败、不影响退出码
  const mkRep2 = (f, c, a, b) => ({ plan: { skippedArchived: a, skippedInArchiveBatch: b }, details: { conflicts: Array(c).fill('x') }, failures: Array(f).fill('y') });
  ok(exitInfo(mkRep2(0, 0, 0, 7)).code === 0 && exitInfo(mkRep2(0, 0, 0, 7)).skippedInArchiveBatch === 7,
    '归档批次跳过 7 张 + 无失败无冲突 → 退出码 0 且计数可读（K3）');
  ok(exitInfo(mkRep2(1, 0, 0, 7)).code === 3, '真失败仍优先 → 3（归档批次跳过不得掩盖真失败）');
  ok(exitInfo(mkRep2(0, 2, 0, 7)).code === 2, '保守冲突 → 2（归档批次跳过不参与）');
  // 渲染
  const md = renderMarkdown({ host: 'h', mode: 'dry-run', local: { revision: 1, taskCount: 1 }, snapshot: { fromHost: 'x', exportedAt: 't', revision: 2, taskCount: 3 }, plan: { create: 1, update: 0, unchanged: 0, skipped: 0, skippedArchived: 2, conflicts: 0 }, details: { create: ['c1'], update: [], skipped: [], skippedArchived: ['[归档·本机侧] T ← 跳过'], conflicts: [] }, applied: [], failures: [] }, 'snap.json');
  ok(md.includes('# 看板账本并回报告') && md.includes('c1'), '报告渲染应含标题与明细');
  ok(md.includes('归档跳过') && md.includes('归档·本机侧'), '报告渲染应含归档跳过段（计数 + 明细）');
  // 版本门
  ok(versionAtLeast('1.1.0') && versionAtLeast('1.2.3'), '版本门应放行 >=1.1.0');
  ok(!versionAtLeast('1.0.0') && !versionAtLeast('0.9.9'), '版本门应拦下 <1.1.0');
  ok(versionAtLeast('2.0.0') && versionAtLeast('1.1.0-rc.2'), '版本门应认 2.x 与 rc 后缀');

  console.log(`[self-test] ${pass} 项通过${fail.length ? '，' + fail.length + ' 项失败: ' + fail.join(' | ') : ''}`);
  return fail.length === 0;
}

// ---------------------------------------------------------------- 入口

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

const SPEC = {
  cmd: 'board-merge',
  summary: '把对端导出的看板快照并回本机看板。走宿主 HTTP 接口，冲突全部列进报告等人工核，绝不静默覆盖。',
  usage: 'board-merge [--snapshot <快照.json>] [--apply] [--port N]',
  flags: [
    { name: '--snapshot', arg: '文件', desc: '对端导出的快照 JSON（缺省自动找最新一份）' },
    { name: '--apply', desc: '真并回（不带就是干跑）' },
    { name: '--dry-run', desc: '显式干跑（与不带 --apply 等价，保留以兼容既有用法）' },
    { name: '--port', arg: '端口', desc: '宿主端口，优先于 DSH_WEB_URL' },
    { name: '--self-test', desc: '跑内置自测，不碰任何数据' },
    { name: '--attach', desc: '只做纯逻辑挂载（供测试驱动用），不执行并回' },
  ],
  env: [
    { name: 'DSH_WEB_URL', desc: '宿主地址，默认 http://localhost:3080' },
    { name: 'DSH_PORT', desc: '宿主端口（--port 优先）' },
  ],
  writes: '不带 --apply 什么都不写（只出报告）。带 --apply 会经宿主接口新建 / 更新卡，并把本机账本备份到归档目录（附 restore 脚本）。',
  dryRun: '默认就是干跑；加 --apply 才真写。',
  exits: '0 成功 · 1 并回失败 · 2 参数错误',
  examples: ['board-merge --snapshot snapshot.json', 'board-merge --snapshot snapshot.json --apply'],
};

if (isMain) {
  const args = cliGuard(SPEC);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  if (args.includes('--self-test')) { process.exitCode = selfTest() ? 0 : 1; }
  else if (args.includes('--attach')) {
    // 由 _test/test-board-merge.mjs 驱动纯逻辑（避免测试里重复实现）
    process.exitCode = 0;
  } else {
    const snapshot = opt('--snapshot', snapshotDefault());
    const apply = args.includes('--apply');
    run({ snapshot, apply }).catch((e) => { console.error(`✖ 并回失败：${e?.stack ?? e}`); process.exitCode = 1; });
  }
}
