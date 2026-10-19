#!/usr/bin/env node
/**
 * board-line-backfill.mjs —— 归档卡 `line` 回填器（精确 id 映射 · 默认 dry-run · 一键回滚）
 *
 * 来源：docs\看板主线自动归档-方案-20260914.md §5 P1（归档卡 line 回填）
 *       + docs\长期库大扫除-20260914\docs-pending-cards.md 看板线第 4 项
 *
 * 为什么需要 restore→update→archive 三步：
 *   归档卡（archivedAt 有值）**整卡只读**——`update`（含 line/seq）直接报 `archived task is read-only`。
 *   要改只能：`restore`（清标记、回原状态列）→ `update {line}` → `archive`（重新打标记）。
 *   ⚠️ `restore` **不恢复 schedule**（归档时已被关闭），故本脚本把 before 的 schedule 一并入账，
 *      回滚脚本会显式 `set-schedule` 还原。
 *
 * 用法：
 *   node <workspace>\tools\board-line-backfill.mjs --map <map.json>                 # dry-run（零写入）
 *   node <workspace>\tools\board-line-backfill.mjs --map <map.json> --apply --emit-restore
 *   node <workspace>\tools\board-line-backfill.mjs --map <map.json> --ids <id1>,<id2> --apply
 *   node <workspace>\tools\board-line-backfill.mjs --map <map.json> --json
 *
 * 映射文件格式（二选一）：
 *   { "items": [ { "id": "<uuid>", "title": "…（仅用于打印核对）", "line": "<主线名>" } ] }
 *   { "<uuid>": "<主线名>", … }
 *
 * 安全：
 *   · 默认 dry-run；`--apply` 才写账本（逐卡 Host API，**绝不手改 ledger-v2.json**）
 *   · apply 前把 before 快照写 `_archive\board-line-backfill-<ts>\before.json`（证据 + 回滚依据）
 *   · `--emit-restore` 生成 `restore-<ts>.mjs`（逐卡回滚：restore→update(line 回原值)→archive→schedule 还原）
 *     + 桌面 `DSH鲸落地\restore-board-line-backfill.cmd`（纯 ASCII，双击可跑）
 *   · 逐卡按**最新**状态判定（账本是活文件，不信任初始清单）；单次上限 `--limit`（默认 40）
 *   · 幂等：已达目标 line 的卡跳过；重复 apply 无副作用
 *
 * 退出码：0 = 成功（含"全部跳过"）/ 1 = 有失败 / 2 = 用法错 / 3 = 读不到看板（fail-closed）
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ARCHIVE_DIR, TOOLS_DIR } from './lib/workspace.mjs';

const BASE = process.env.DSH_BOARD_URL ?? "http://localhost:3080";
const STATE_URL = `${BASE}/api/task-board/state`;
const ACTION_URL = `${BASE}/api/task-board/action`;
const HEADERS_GET = { origin: BASE, "sec-fetch-site": "same-origin" };
const HEADERS_POST = { ...HEADERS_GET, "content-type": "application/json" };
const TIMEOUT_MS = 20_000;
const ARCHIVE_ROOT = ARCHIVE_DIR;
const DESKTOP_ENTRY = process.env.DSH_DESKTOP_ENTRY || path.join(TOOLS_DIR, 'dsh-butler', 'lib', 'desktop-entry.mjs');

class UsageError extends Error {}
class EnvError extends Error {}

// ─────────────────────────── 参数 ───────────────────────────

const USAGE = `用法：node board-line-backfill.mjs --map <map.json> [--ids a,b] [--apply] [--emit-restore] [--json] [--limit N]
  --map <file>      映射文件（{"items":[{id,title,line}]} 或 {"<id>":"<line>"}）
  --ids a,b         只处理映射中的这些 id（单卡演练用）
  --apply           真写账本（缺省 = dry-run）
  --emit-restore    生成逐卡回滚脚本 + 桌面入口（只能与 --apply 同用）
  --limit N         单次最多处理 N 张（默认 40，防一把梭）
  --json            机器可读输出`;

function parseArgs(argv) {
  const o = { map: null, ids: null, apply: false, emitRestore: false, json: false, limit: 40 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--map") o.map = argv[++i] ?? null;
    else if (a === "--ids") o.ids = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--apply") o.apply = true;
    else if (a === "--emit-restore") o.emitRestore = true;
    else if (a === "--json") o.json = true;
    else if (a === "--limit") o.limit = Number(argv[++i]);
    else if (a === "-h" || a === "--help") return { help: true };
    else throw new UsageError(`未知参数：${a}`);
  }
  if (!o.map) throw new UsageError("缺 --map <map.json>");
  if (!Number.isFinite(o.limit) || o.limit <= 0) throw new UsageError("--limit 必须是正数");
  if (o.emitRestore && !o.apply) throw new UsageError("--emit-restore 只能与 --apply 同用（dry-run 没有要回滚的东西）");
  return o;
}

function loadMap(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new UsageError(`映射文件不可读或非法 JSON：${file}（${e && e.message ? e.message : e}）`);
  }
  const out = [];
  if (Array.isArray(raw?.items)) {
    for (const it of raw.items) {
      if (!it || !it.id || !it.line) throw new UsageError(`映射项缺 id/line：${JSON.stringify(it).slice(0, 120)}`);
      out.push({ id: String(it.id), title: it.title ? String(it.title) : "", line: String(it.line) });
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [id, line] of Object.entries(raw)) {
      if (typeof line !== "string" || !line) throw new UsageError(`映射项非法：${id}`);
      out.push({ id, title: "", line });
    }
  } else {
    throw new UsageError("映射文件既不是 {items:[…]} 也不是 {id: line}");
  }
  if (out.length === 0) throw new UsageError("映射文件为空");
  return out;
}

// ─────────────────────────── HTTP ───────────────────────────

async function fetchState() {
  let res;
  try {
    res = await fetch(STATE_URL, { headers: HEADERS_GET, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new EnvError(`GET ${STATE_URL} 失败（${e?.message ?? e}）——DSH 没跑？端口不是 3080？`);
  }
  if (!res.ok) throw new EnvError(`GET ${STATE_URL} 返回 HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!body || !Array.isArray(body.tasks)) throw new EnvError("响应里没有 tasks[]——看板未就绪或接口已变更");
  return body;
}

async function postAction(action) {
  let res, text = "";
  try {
    res = await fetch(ACTION_URL, {
      method: "POST", headers: HEADERS_POST,
      body: JSON.stringify({ requestId: randomUUID(), action }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) {
    throw new EnvError(`POST ${ACTION_URL} 失败（${e?.message ?? e}）`);
  }
  let body = null;
  try { body = JSON.parse(text); } catch { /* 保留原文 */ }
  return { status: res.status, ok: res.ok, body, text };
}

// ─────────────────────────── 工具 ───────────────────────────

const isArchived = (t) => t.archivedAt !== undefined && t.archivedAt !== null;
const normLine = (t) => (t?.line === undefined || t?.line === null || String(t.line).trim() === "" ? null : String(t.line));
const fmtTime = (ms) => (typeof ms === "number" && Number.isFinite(ms)
  ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : "—");
const stamp = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
/** 快照字段（回滚依据）：只留回滚需要的字段，**不含 prompt/description**（体积与隐私）。 */
function snapOf(t, targetLine) {
  return {
    id: t.id,
    title: t.title ?? "",
    status: t.status ?? null,
    lineBefore: normLine(t),
    seqBefore: t.seq === undefined || t.seq === null ? null : String(t.seq),
    archivedBefore: isArchived(t),
    scheduleBefore: t.schedule ?? null,
    updatedAtBefore: t.updatedAt ?? null,
    lineAfter: targetLine,
  };
}

// ─────────────────────────── 回滚脚本生成 ───────────────────────────

/** 生成逐卡回滚脚本源码（零依赖、独立可跑；restore→update(line 回原值)→archive→schedule 还原）。 */
function renderRestoreScript(ts, beforeFileRel, cards) {
  const data = cards.map((c) => ({
    id: c.id, title: c.title, status: c.status,
    lineBefore: c.lineBefore, archivedBefore: c.archivedBefore,
    scheduleBefore: c.scheduleBefore,
  }));
  const L = [];
  L.push("#!/usr/bin/env node");
  L.push("// 逐卡回滚脚本（自动生成 · 请勿手改）：把 line 回填前的状态还原回去");
  L.push("// 来源：board-line-backfill.mjs --apply --emit-restore");
  L.push("//   对每张卡：① restore（若已归档）② update line = 原值（原值 null → 传空串清除）");
  L.push("//             ③ archive（若原本已归档）④ set-schedule（若原本带 schedule）");
  L.push("// 用法：node " + path.basename(beforeFileRel) + " 的 run.mjs [--apply]   缺省 = dry-run");
  L.push('import fs from "node:fs";');
  L.push('import path from "node:path";');
  L.push('import { randomUUID } from "node:crypto";');
  L.push('import { fileURLToPath } from "node:url";');
  L.push("");
  L.push('const BASE = process.env.DSH_BOARD_URL ?? "http://localhost:3080";');
  L.push('const H_GET = { origin: BASE, "sec-fetch-site": "same-origin" };');
  L.push('const H_POST = { ...H_GET, "content-type": "application/json" };');
  L.push('const APPLY = process.argv.includes("--apply");');
  L.push("const TS = " + JSON.stringify(ts) + ";");
  L.push("const CARDS = " + JSON.stringify(data, null, 2) + ";");
  L.push("");
  L.push('const isArchived = (t) => t.archivedAt !== undefined && t.archivedAt !== null;');
  L.push("");
  L.push("async function fetchState() {");
  L.push('  const res = await fetch(BASE + "/api/task-board/state", { headers: H_GET, signal: AbortSignal.timeout(20000) });');
  L.push('  if (!res.ok) throw new Error("GET state HTTP " + res.status);');
  L.push("  return await res.json();");
  L.push("}");
  L.push("");
  L.push("async function postAction(action) {");
  L.push('  const res = await fetch(BASE + "/api/task-board/action", {');
  L.push('    method: "POST", headers: H_POST,');
  L.push("    body: JSON.stringify({ requestId: randomUUID(), action }),");
  L.push("    signal: AbortSignal.timeout(20000),");
  L.push("  });");
  L.push("  const text = await res.text();");
  L.push("  let body = null; try { body = JSON.parse(text); } catch {}");
  L.push("  return { status: res.status, ok: res.ok, body, text };");
  L.push("}");
  L.push("");
  L.push("async function main() {");
  L.push('  console.log("=== board line backfill restore " + TS + " · " + (APPLY ? "APPLY" : "DRY-RUN") + " ===");');
  L.push("  const st = await fetchState();");
  L.push("  const byId = new Map((st.tasks ?? []).map((t) => [t.id, t]));");
  L.push("  console.log(\"revision \\u5f53\\u524d \" + st.revision + \" \\u00b7 \\u5f85\\u56de\\u6eda \" + CARDS.length + \" \\u5f20\");");
  L.push("  let okN = 0, skipN = 0, failN = 0;");
  L.push("  for (const c of CARDS) {");
  L.push("    const t = byId.get(c.id);");
  L.push("    if (!t) { console.log(\"  [missing] \" + c.id.slice(0, 8) + \" \" + (c.title || \"\")); failN++; continue; }");
  L.push("    const cur = t.line === undefined || t.line === null || String(t.line).trim() === \"\" ? null : String(t.line);");
  L.push("    if (cur === c.lineBefore && isArchived(t) === c.archivedBefore) { skipN++; console.log(\"  [already] \" + c.id.slice(0, 8) + \" \\u5df2\\u662f\\u56de\\u6eda\\u6001\"); continue; }");
  L.push("    const steps = [];");
  L.push("    if (isArchived(t)) steps.push('restore');");
  L.push("    steps.push('update');");
  L.push("    if (c.archivedBefore) steps.push('archive');");
  L.push("    if (!APPLY) { console.log(\"  [plan] \" + c.id.slice(0, 8) + \" \" + steps.join(\" -> \") + \"  line: \" + cur + \" -> \" + c.lineBefore); continue; }");
  L.push("    let bad = null;");
  L.push("    for (const s of steps) {");
  L.push("      let r;");
  L.push("      if (s === 'restore') r = await postAction({ kind: 'restore', taskId: c.id });");
  L.push("      else if (s === 'archive') r = await postAction({ kind: 'archive', taskId: c.id });");
  L.push("      else r = await postAction({ kind: 'update', taskId: c.id, patch: { line: c.lineBefore ?? '' } });");
  L.push("      if (!r.ok) { bad = s + \" HTTP \" + r.status + \" \" + String(r.text).slice(0, 160); break; }");
  L.push("    }");
  L.push("    if (!bad && c.scheduleBefore) {");
  L.push("      const r = await postAction({ kind: 'set-schedule', taskId: c.id, patch: { enabled: c.scheduleBefore.enabled === true, cron: c.scheduleBefore.cron } });");
  L.push("      if (!r.ok) bad = \"set-schedule HTTP \" + r.status + \" \" + String(r.text).slice(0, 160);");
  L.push("    }");
  L.push("    if (bad) { failN++; console.log(\"  [FAIL] \" + c.id.slice(0, 8) + \" \" + bad); }");
  L.push("    else { okN++; console.log(\"  [ok]   \" + c.id.slice(0, 8) + \" \\u56de\\u6eda -> line=\" + (c.lineBefore ?? \"(\\u7a7a)\") + \" archived=\" + c.archivedBefore); }");
  L.push("  }");
  L.push("  console.log(\"\\u6c47\\u603b\\uff1a\\u6210\\u529f \" + okN + \" / \\u8df3\\u8fc7 \" + skipN + \" / \\u5931\\u8d25 \" + failN + (APPLY ? \"\" : \"\\uff08dry-run\\uff09\"));");
  L.push("  if (failN > 0) process.exitCode = 1;");
  L.push("}");
  L.push("");
  L.push("main().catch((e) => { console.error(\"restore \\u5931\\u8d25\\uff1a\" + (e?.stack ?? e)); process.exitCode = 1; });");
  return L.join("\n") + "\n";
}

/** 纯 ASCII + CRLF 的桌面 .cmd（铁律：.cmd 禁中文）。 */
function renderCmd(restoreRel, ts) {
  const lines = [
    "@echo off",
    "setlocal",
    "REM  restore-board-line-backfill.cmd   (ASCII only, CRLF)",
    "REM  One-click rollback for the archived-card line backfill batch.",
    "REM  Mode: per-card Host API restore/update/archive. NEVER overwrites ledger-v2.json.",
    "set \"SCRIPT=" + path.join(ARCHIVE_ROOT, "board-line-backfill-" + ts, restoreRel) + "\"",
    "echo === board line backfill rollback (" + ts + ") ===",
    "if not exist \"%SCRIPT%\" (",
    "  echo [ERROR] restore script not found:",
    "  echo   %SCRIPT%",
    "  pause",
    "  exit /b 2",
    ")",
    "echo [1/2] Dry-run preview:",
    "node \"%SCRIPT%\"",
    "echo.",
    "set /p \"ANS=Type YES to apply the rollback: \"",
    "if /i not \"%ANS%\"==\"YES\" (echo [CANCEL] nothing changed. & pause & exit /b 0)",
    "echo [2/2] Applying per-card rollback:",
    "node \"%SCRIPT%\" --apply",
    "echo [DONE] exit code above: 0 = all restored, 1 = some failed.",
    "pause",
  ];
  return lines.join("\r\n") + "\r\n";
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE + "\n"); return 0; }
  const mapAll = loadMap(args.map);
  const items = args.ids ? mapAll.filter((m) => args.ids.includes(m.id)) : mapAll;
  if (items.length === 0) throw new UsageError("--ids 过滤后没有剩余项");
  const overLimit = items.length > args.limit;
  const plan = overLimit ? items.slice(0, args.limit) : items;

  const state = await fetchState();
  const revBefore = state.revision ?? null;
  const byId = new Map((state.tasks ?? []).map((t) => [t.id, t]));

  // ── 计划（逐卡按当前状态判定）──
  const willDo = [], skipped = [];
  for (const it of plan) {
    const t = byId.get(it.id);
    if (!t) { skipped.push({ ...it, reason: "missing" }); continue; }
    if (normLine(t) === it.line) { skipped.push({ ...it, title: t.title ?? "", reason: "already", status: t.status, archived: isArchived(t) }); continue; }
    const steps = [];
    if (isArchived(t)) steps.push("restore");
    steps.push("update");
    if (isArchived(t)) steps.push("archive");
    willDo.push({ ...it, title: t.title ?? "", status: t.status, archived: isArchived(t), steps, snap: snapOf(t, it.line) });
  }

  if (args.json && !args.apply) {
    process.stdout.write(JSON.stringify({
      ok: true, dryRun: true, revision: revBefore, mode: "dry-run",
      items: plan.length, willDo: willDo.map((w) => ({ id: w.id, line: w.line, steps: w.steps, status: w.status })),
      skipped, truncatedByLimit: overLimit ? plan.length - willDo.length : 0,
    }, null, 2) + "\n");
    return 0;
  }

  if (!args.apply) {
    process.stdout.write(`看板归档卡 line 回填 · DRY-RUN（零写入）· revision ${revBefore ?? "?"}\n`);
    process.stdout.write(`映射 ${mapAll.length} 项 · 本次计划 ${plan.length} 张${overLimit ? `（--limit ${args.limit} 截断，映射里还有 ${items.length - plan.length} 张）` : ""}\n`);
    for (const w of willDo) {
      process.stdout.write(`  [${isArchived({ archivedAt: w.archived ? 1 : undefined }) ? "已归档" : "在板"}] ${w.id.slice(0, 8)} [${w.status}] ${w.steps.join(" → ")} · line → 「${w.line}」· ${w.title}\n`);
    }
    for (const s of skipped) {
      const why = s.reason === "missing" ? "卡不存在" : "已是目标 line";
      process.stdout.write(`  [skip] ${s.id.slice(0, 8)} ${why}${s.title ? " · " + s.title : ""}\n`);
    }
    process.stdout.write(`汇总：将改 ${willDo.length} 张 · 跳过 ${skipped.length} 张 · 退出码 0\n`);
    process.stdout.write("（加 --apply 执行；--apply --emit-restore 同时生成回滚脚本）\n");
    return 0;
  }

  // ── apply ──
  const ts = stamp();
  const pointDir = path.join(ARCHIVE_ROOT, `board-line-backfill-${ts}`);
  fs.mkdirSync(pointDir, { recursive: true });
  const beforeFile = path.join(pointDir, "before.json");
  fs.writeFileSync(beforeFile, JSON.stringify({
    ts, mode: "board-line-backfill apply", revisionBefore: revBefore,
    mapFile: path.resolve(args.map), cards: willDo.map((w) => w.snap), skipped: skipped.map((s) => ({ id: s.id, reason: s.reason })),
  }, null, 2) + "\n", "utf8");

  let restoreInfo = null;
  if (args.emitRestore) {
    const mjsName = `restore-${ts}.mjs`;
    fs.writeFileSync(path.join(pointDir, mjsName), renderRestoreScript(ts, mjsName, willDo.map((w) => w.snap)), "utf8");
    let cmdPath = null;
    try {
      const de = await import(pathToFileURL(DESKTOP_ENTRY).href);
      const dir = de.desktopEntryDir();
      if (dir) {
        cmdPath = path.join(dir, "restore-board-line-backfill.cmd");
        fs.writeFileSync(cmdPath, renderCmd(mjsName, ts), "utf8");
      }
    } catch { cmdPath = null; }
    restoreInfo = { mjs: path.join(pointDir, mjsName), cmd: cmdPath };
  }
  process.stdout.write(`📍 回滚点：${pointDir}（before.json 已写）\n`);

  // 逐卡执行：每次动作后用返回快照刷新本地视图（不信任初始清单）
  let snapshot = state.tasks;
  const results = [];
  for (const w of willDo) {
    const t = (snapshot ?? []).find((x) => x.id === w.id) ?? byId.get(w.id);
    if (!t) { results.push({ id: w.id, ok: false, error: "missing" }); process.stdout.write(`  ✘ ${w.id.slice(0, 8)} 卡不存在\n`); continue; }
    if (normLine(t) === w.line) { results.push({ id: w.id, ok: true, skipped: true }); process.stdout.write(`  · ${w.id.slice(0, 8)} 已是目标 line（跳过）\n`); continue; }

    const wasArchived = isArchived(t);
    const steps = [];
    if (wasArchived) steps.push("restore");
    steps.push("update");
    if (wasArchived) steps.push("archive");

    let bad = null;
    for (const s of steps) {
      const action = s === "restore" ? { kind: "restore", taskId: w.id }
        : s === "archive" ? { kind: "archive", taskId: w.id }
        : { kind: "update", taskId: w.id, patch: { line: w.line } };
      const r = await postAction(action);
      if (!r.ok) { bad = `${s} HTTP ${r.status} ${String(r.text).slice(0, 160)}`; break; }
      const next = r.body?.tasks ?? r.body?.snapshot?.tasks;
      if (Array.isArray(next)) snapshot = next;
    }
    if (bad) { results.push({ id: w.id, ok: false, error: bad }); process.stdout.write(`  ✘ ${w.id.slice(0, 8)} ${bad}\n`); continue; }

    // 复核（回读最新态）
    let final = null;
    try {
      const s2 = await fetchState();
      snapshot = s2.tasks;
      final = (s2.tasks ?? []).find((x) => x.id === w.id) ?? null;
    } catch { /* 复核失败不判失败，用本地视图 */ final = (snapshot ?? []).find((x) => x.id === w.id) ?? null; }
    const okLine = final && normLine(final) === w.line;
    const okArch = final && isArchived(final) === wasArchived;
    if (okLine && okArch) {
      results.push({ id: w.id, ok: true, line: w.line, archived: wasArchived });
      process.stdout.write(`  ✔ ${w.id.slice(0, 8)} line → 「${w.line}」（${wasArchived ? "已复位归档" : "在板"}）\n`);
    } else {
      const why = `复核不符（line=${normLine(final)} archived=${final ? isArchived(final) : "?"}）`;
      results.push({ id: w.id, ok: false, error: why });
      process.stdout.write(`  ✘ ${w.id.slice(0, 8)} ${why}\n`);
    }
  }

  const okN = results.filter((r) => r.ok && !r.skipped).length;
  const skipN = results.filter((r) => r.skipped).length;
  const failN = results.filter((r) => !r.ok).length;

  let revAfter = null;
  try { revAfter = (await fetchState()).revision ?? null; } catch { /* ignore */ }

  const summary = {
    ok: failN === 0, ts, revisionBefore: revBefore, revisionAfter: revAfter,
    revisionDelta: revBefore !== null && revAfter !== null ? revAfter - revBefore : null,
    mapFile: path.resolve(args.map), planned: plan.length, changed: okN, skippedInLoop: skipN, failed: failN,
    skippedPre: skipped.length, results, restore: restoreInfo, pointDir,
  };
  if (args.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    process.stdout.write(`\n汇总：改 ${okN} 张 · 循环内跳过 ${skipN} · 失败 ${failN} · 预筛跳过 ${skipped.length}\n`);
    process.stdout.write(`revision：${revBefore ?? "?"} → ${revAfter ?? "?"}（增量 ${summary.revisionDelta ?? "?"}）\n`);
    if (restoreInfo) {
      process.stdout.write(`还原脚本：${restoreInfo.mjs}\n`);
      process.stdout.write(`桌面入口：${restoreInfo.cmd ?? "（桌面入口未生成——desktop-entry helper 不可用）"}\n`);
      process.stdout.write(`还原命令：node "${restoreInfo.mjs}"          # dry-run\n`);
      process.stdout.write(`          node "${restoreInfo.mjs}" --apply  # 真回滚\n`);
    }
  }
  return failN === 0 ? 0 : 1;
}

// 入口守卫：junction 下 import.meta.url（物理）与 argv[1]（逻辑）必须 realpath 后比较
function isMainEntry() {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1] ?? ""));
  } catch { return false; }
}

if (isMainEntry()) {
  main()
    .then((code) => { process.exitCode = typeof code === "number" ? code : 0; })
    .catch((e) => {
      if (e instanceof UsageError) { process.stderr.write(`${e.message}\n${USAGE}\n`); process.exitCode = 2; return; }
      if (e instanceof EnvError) { process.stderr.write(`✘ ${e.message}\n`); process.exitCode = 3; return; }
      process.stderr.write(`✘ board-line-backfill 异常：${e?.stack ?? e}\n`);
      process.exitCode = 1;
    });
}
