#!/usr/bin/env node
/**
 * board-archive-line.mjs —— 看板「按主线批量归档」+ 逐卡回滚脚本生成（零依赖，node 内置 fetch）
 *
 * 方案：docs\看板归档与查重-方案-20260914.md §4 交付物 D3、§8 决策 3、§9 轮二/轮三阻断意见
 *   · §8 拍板：**只允许精确 `--line` / `--ids`，不提供 `--all`**（全库 100 张可归档、跨 17 条主线，
 *     一把梭误伤面不可控）。本脚本**故意不实现 --all**。
 *   · §9 轮二阻断：账本是活文件（revision 每分钟在动）→ **apply 时逐卡按最新状态判定**，
 *     不信任 dry-run 时那份清单；遇 `400 task cannot be archived` 归入「已处理/不可归档」并继续。
 *   · §9 轮三阻断：**还原禁止文件覆盖** → `--emit-restore` 只生成 `restore-<ts>.mjs`（逐卡发
 *     `{kind:"restore", taskId}`）；`ledger-before.json` **仅作 before 证据**，脚本绝不拿它写回。
 *
 * 铁律遵守：
 *   · 只走 Host HTTP API（`POST /api/task-board/action`），**绝不手改 ledger-v2.json**；
 *   · 默认 dry-run（只列目标卡、零写入）；`--apply` 才逐卡发 archive；
 *   · 收尾一律 `process.exitCode`（本机已知坑：发过 fetch 的脚本用 process.exit() 会触发 libuv
 *     断言 0xC0000409）；fail-closed（读不到 /state 一律非 0 退出，绝不静默"0 张归档成功"）。
 *
 * 退出码：
 *   0 成功 ／ 1 执行失败（有卡归档失败）／ 2 用法或前置错误（含 line 不存在、status 非法）
 *   3 环境不可用（读不到 /state、Host 不可达）／ 5 命中 0 张（dry-run 与 apply 通用）
 *   4 有卡被跳过（非目标状态／已归档）——留给调用方判断，不影响已成功的卡
 *
 * 用法（本文件必须已存在；改它不影响 DSH，无需重启）：
 *   node <workspace>\tools\board-archive-line.mjs --line "受控升级 · 主包 0.1.5"
 *   node <workspace>\tools\board-archive-line.mjs --line "受控升级 · 主包 0.1.5" --apply --emit-restore
 *   node <workspace>\tools\board-archive-line.mjs --ids <id1>,<id2> --apply --emit-restore
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { readArchivedIdsSync } from "./lib/board-archive-view.mjs";
import { ARCHIVE_DIR } from './lib/workspace.mjs';

// ─────────────────────────── 常量 ───────────────────────────

// 默认生产实例；仅测试/多实例排查用环境变量覆盖（生产一律 localhost:3080，主机 A 实测 127.0.0.1 连不上）
const BASE = (process.env.DSH_BOARD_BASE || "http://localhost:3080").replace(/\/+$/, "");
const STATE_URL = `${BASE}/api/task-board/state`;
const ACTION_URL = `${BASE}/api/task-board/action`;
const HEADERS_GET = {
  origin: BASE,
  "sec-fetch-site": "same-origin",
  accept: "application/json",
  // K3（2026-09-24）：**显式**要整本（含归档卡）。归档物理化之后归档卡不在主账本里，
  // 由 Host 的 `mergeBoardView`（scope=all，K2 落地）带回来 ⇒ 本脚本的
  // 「已归档 X 张」「账本中已不存在」这类判定才仍然成立。**绝不能**改成 live。
  "x-dsh-board-scope": "all",
};
const HEADERS_POST = {
  origin: BASE,
  "sec-fetch-site": "same-origin",
  accept: "application/json",
  "content-type": "application/json",
};
const TIMEOUT_MS = 30000;

// 与看板源码 tools\dsh-task-board-local\src\core\tasks.ts 的 ARCHIVABLE_STATUSES 对齐
const ARCHIVABLE = ["done", "failed"];
const DEFAULT_STATUS = ARCHIVABLE.join(",");

const ARCHIVE_HOME = ARCHIVE_DIR;
const DESKTOP_DIR = path.join(os.homedir(), "Desktop", "DSH鲸落地");

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_ENV = 3;
const EXIT_SKIPPED = 4;
const EXIT_ZERO = 5;

class UsageError extends Error {}
class EnvError extends Error {}

const HELP = `看板按主线批量归档（默认 dry-run，只列目标卡、零写入）

用法：
  node <workspace>\\tools\\board-archive-line.mjs --line "<主线名>" [选项]
  node <workspace>\\tools\\board-archive-line.mjs --ids <id1>,<id2> [选项]

目标选择（二选一，**必须**给一个；本脚本不提供 --all）：
  --line <主线名>   精确匹配账本里现有 line 值（先 GET /state 校验存在，不存在则列相近候选并 exit 2）
  --ids <a,b>       显式卡 id 列表（逗号分隔；逐个校验存在）

选项：
  --status <s>      可归档状态集合，默认 "${DEFAULT_STATUS}"（与看板 ARCHIVABLE_STATUSES 一致）
                    含其它值 → exit 2（不静默跳过）
  --apply           真归档（逐卡 POST {kind:"archive", taskId}）；缺省 = dry-run
  --emit-restore    生成 restore-<ts>.mjs（逐卡 POST {kind:"restore", taskId}）+ 纯 ASCII .cmd
                    → 桌面\\DSH鲸落地\\。仅 --apply 时可用（dry-run 没有要还原的东西）
  --json            机读 JSON 输出（stdout 只有 JSON）
  -h, --help        显示本帮助

行为要点：
  · 默认 dry-run：只打印目标卡，零写入（revision 不变）。
  · 命中 0 张 → 退出码 ${EXIT_ZERO}（区分于"有命中但 dry-run"）。
  · --apply 时**逐卡按最新状态判定**（账本是活文件，dry-run 的清单会过期）；
    遇 400 task cannot be archived（卡不存在与卡已归档返回**同一条**错误消息，无法区分）
    → 归入「已处理/不可归档」汇总并**继续**，不中断。
  · --apply 前把账本副本导出到 ${ARCHIVE_HOME}\\board-archive-<ts>\\ledger-before.json，
    **仅作 before 证据**，还原一律走 restore 脚本逐卡 API，**禁止整文件覆盖写回**。

退出码：${EXIT_OK} 成功 ／ ${EXIT_FAIL} 有卡归档失败 ／ ${EXIT_USAGE} 用法或前置错（含 line 不存在 / status 非法）
        ${EXIT_ENV} 环境不可用（读不到 state）／ ${EXIT_SKIPPED} 有卡被跳过（不影响已成功者）
        ${EXIT_ZERO} 命中 0 张

数据源默认 http://localhost:3080（仅测试/多实例排查用环境变量 DSH_BOARD_BASE 覆盖）。`;

// ─────────────────────────── 参数 ───────────────────────────

function parseArgs(argv) {
  const o = {
    line: null,
    idsRaw: null,
    statusRaw: null,
    apply: false,
    emitRestore: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--line" || a === "--ids" || a === "--status") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`参数 ${a} 缺少值`);
      i++;
      if (v.trim() === "") throw new UsageError(`参数 ${a} 的值是空串`);
      if (a === "--line") o.line = v;
      else if (a === "--ids") o.idsRaw = v;
      else o.statusRaw = v;
    } else if (a === "--apply") o.apply = true;
    else if (a === "--emit-restore") o.emitRestore = true;
    else if (a === "--json") o.json = true;
    else if (a === "-h" || a === "--help") o.help = true;
    // 显式拒绝全量口径（§8 决策 3）
    else if (a === "--all") throw new UsageError("本脚本不提供 --all（§8 拍板：只允许精确 --line / --ids）");
    else throw new UsageError(`未知参数 ${a}`);
  }
  return o;
}

function normalizeOptions(o) {
  if (o.line !== null && o.idsRaw !== null) throw new UsageError("--line 与 --ids 互斥，只能给一个");
  if (o.line === null && o.idsRaw === null) throw new UsageError("必须给 --line 或 --ids 之一（本脚本不提供 --all）");
  if (o.emitRestore && !o.apply) throw new UsageError("--emit-restore 只能与 --apply 同用（dry-run 没有要还原的东西）");

  let statuses;
  if (o.statusRaw === null) statuses = [...ARCHIVABLE];
  else {
    const parts = o.statusRaw.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (parts.length === 0) throw new UsageError("--status 解析后为空");
    const bad = parts.filter((s) => !ARCHIVABLE.includes(s));
    if (bad.length > 0) {
      throw new UsageError(
        `--status 含不支持的值：${bad.join(", ")}（本版只允许 ${ARCHIVABLE.join("/")}）` +
          `——拒绝执行而不是静默跳过，避免「以为归档了其实没动」`,
      );
    }
    statuses = [...new Set(parts)];
  }

  let ids = null;
  if (o.idsRaw !== null) {
    ids = [...new Set(o.idsRaw.split(",").map((s) => s.trim()).filter((s) => s !== ""))];
    if (ids.length === 0) throw new UsageError("--ids 解析后为空");
  }

  return { line: o.line, ids, statuses, apply: o.apply, emitRestore: o.emitRestore, json: o.json };
}

// ─────────────────────────── HTTP ───────────────────────────

async function fetchState() {
  let res;
  try {
    res = await fetch(STATE_URL, { headers: HEADERS_GET, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new EnvError(`GET ${STATE_URL} 失败（${e && e.message ? e.message : e}）——DSH 没跑？端口不是 3080？`);
  }
  if (!res.ok) throw new EnvError(`GET ${STATE_URL} 返回 HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch (e) {
    throw new EnvError(`GET ${STATE_URL} 响应不是合法 JSON（${e && e.message ? e.message : e}）`);
  }
  if (!body || !Array.isArray(body.tasks)) throw new EnvError("响应里没有 tasks[] 数组——看板未就绪或接口已变更");
  return body;
}

async function postAction(action) {
  let res;
  let text = "";
  try {
    res = await fetch(ACTION_URL, {
      method: "POST",
      headers: HEADERS_POST,
      body: JSON.stringify({ requestId: randomUUID(), action }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) {
    throw new EnvError(`POST ${ACTION_URL} 失败（${e && e.message ? e.message : e}）`);
  }
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 非 JSON 响应，保留原文 */
  }
  return { status: res.status, ok: res.ok, body, text };
}

/**
 * K3 · 归档面核验：物理搬出之后，**"归档成功"的真判据是"卡真的在归档批次里"**
 * ——`archivedAt` 有值只证明"打了标记"，分不出"打标记"与"真搬出"两种世界。
 * 两源：HTTP `GET /archive`（同实例、权威）→ 失败回退直读 `$DSH_HOME/task-board/archive*`。
 * @returns {Promise<{ok:boolean, ids:Set<string>, sources:string[], errors:string[]}>}
 *   `ok:false` 只表示"未判定"（该实例还没有归档读路由 / 归档面读不到）—— **不改退出码**。
 */
async function physicalArchiveIds() {
  const out = { ok: false, ids: new Set(), sources: [], errors: [] };
  try {
    let offset = 0;
    for (let page = 0; page < 50; page++) {
      const res = await fetch(`${BASE}/api/task-board/archive?limit=100&offset=${offset}`, {
        headers: HEADERS_GET,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 404) { out.errors.push("GET /archive → 404（该实例无归档读路由）"); break; }
      if (!res.ok) { out.errors.push(`GET /archive → HTTP ${res.status}`); break; }
      let j = null;
      try { j = await res.json(); } catch { out.errors.push("GET /archive → 响应非 JSON"); break; }
      const batches = Array.isArray(j?.batches) ? j.batches : [];
      for (const b of batches) for (const id of b?.ids ?? []) out.ids.add(String(id));
      out.sources.push(`http(${batches.length} 批)`);
      if (j?.hasMore !== true || batches.length === 0) { out.ok = true; break; }
      offset += batches.length;
    }
  } catch (e) {
    out.errors.push(`GET /archive 失败：${e.message}`);
  }
  if (!out.ok) {
    try {
      const local = readArchivedIdsSync();
      if (local.source === "file" && local.count > 0) {
        for (const id of local.ids) out.ids.add(id);
        out.sources.push(`file(${local.batches} 批 / ${local.count} id)`);
        out.ok = true;
      } else if (local.source === "none") {
        out.sources.push("file(0 批)");
        out.ok = true;
      } else {
        out.errors.push(`本地归档面不可判定：${local.reason}（home=${local.home}）`);
      }
    } catch (e) {
      out.errors.push(`本地归档面读取失败：${e.message}`);
    }
  }
  return out;
}

// ─────────────────────────── 判定 ───────────────────────────

const isArchived = (t) => t.archivedAt !== undefined && t.archivedAt !== null;
const normLine = (t) => (t.line === undefined || t.line === null || String(t.line).trim() === "" ? null : String(t.line));
const normSeq = (t) => (t.seq === undefined || t.seq === null || String(t.seq).trim() === "" ? null : String(t.seq));

function fmtTime(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function classify(task, statuses) {
  if (!task) return "missing";
  if (isArchived(task)) return "archived";
  if (!statuses.includes(task.status)) return "status";
  return "target";
}

/** 按目标选择口径筛出候选（含跳过原因），并算相近 line 候选 */
function selectTargets(opts, state) {
  const byId = new Map(state.tasks.map((t) => [t.id, t]));

  if (opts.line !== null) {
    const exact = state.tasks.filter((t) => normLine(t) === opts.line);
    if (exact.length === 0) {
      const allLines = [...new Set(state.tasks.map(normLine).filter((l) => l !== null))].sort();
      const near = rankSimilar(opts.line, allLines);
      return { error: "line-not-found", line: opts.line, candidates: near, allLines };
    }
    return { pool: exact, byId };
  }

  const missing = opts.ids.filter((id) => !byId.has(id));
  return { pool: opts.ids.filter((id) => byId.has(id)).map((id) => byId.get(id)), byId, missing };
}

/** 粗相似：共有字符数 + 前缀匹配加权，只用于"是不是手打错了"的提示 */
function rankSimilar(needle, lines) {
  const chars = new Set([...needle.replace(/\s/g, "")]);
  return lines
    .map((l) => {
      const ls = l.replace(/\s/g, "");
      let common = 0;
      for (const c of chars) if (ls.includes(c)) common++;
      const prefix = needle.slice(0, 4) === l.slice(0, 4) ? 3 : 0;
      const sub = l.includes(needle) || needle.includes(l) ? 5 : 0;
      return { line: l, score: common + prefix + sub };
    })
    .sort((a, b) => b.score - a.score || a.line.localeCompare(b.line));
}

function targetsOf(pool, statuses) {
  const targets = [];
  const skipped = [];
  for (const t of pool) {
    const kind = classify(t, statuses);
    if (kind === "target") targets.push(t);
    else skipped.push({ task: t, reason: kind });
  }
  return { targets, skipped };
}

// ─────────────────────────── 输出 ───────────────────────────

function renderList(targets, skipped, statuses) {
  const out = [];
  out.push(`状态集合：${statuses.join(",")}（与看板 ARCHIVABLE_STATUSES 一致）`);
  out.push(`目标卡 ${targets.length} 张：`);
  if (targets.length === 0) out.push("  （无）");
  targets.forEach((t, i) => {
    out.push(`  ${String(i + 1).padStart(2)}. [${t.status}] seq=${normSeq(t) ?? "—"} 执行数=${Array.isArray(t.executions) ? t.executions.length : 0}`);
    out.push(`      ${t.title}`);
    out.push(`      id=${t.id}  line=${normLine(t) ?? "(未归线)"}`);
  });
  if (skipped.length > 0) {
    out.push(`跳过 ${skipped.length} 张（不在可归档集合或已归档，不参与本次）：`);
    for (const s of skipped) {
      const why = s.reason === "archived" ? "已归档" : `status=${s.task.status}`;
      out.push(`  · [${why}] ${s.task.title}`);
      out.push(`      id=${s.task.id}`);
    }
  }
  return out;
}

// ─────────────────────────── 恢复脚本生成 ───────────────────────────

function buildRestoreMjs(ctx) {
  const idsJson = JSON.stringify(ctx.ids, null, 2);
  return `#!/usr/bin/env node
/**
 * restore-${ctx.ts}.mjs —— 逐卡还原 ${ctx.ids.length} 张归档卡（自动生成，零依赖）
 *
 * 来源：board-archive-line.mjs --apply --emit-restore
 *   · 目标主线：${ctx.lineLabel}
 *   · apply 前 revision：${ctx.revBefore}
 *   · 本脚本归档的卡 id 全表见下方 IDS（= apply 时实际归档成功的卡）
 *
 * 机制（铁律：**禁止整文件覆盖写回 ledger-v2.json**）：
 *   逐张 POST {kind:"restore", taskId}，由 Host 权威写账本。
 *   绝不使用同目录的 ledger-before.json 写回——apply 之后可能已有新卡/新执行，
 *   覆盖会丢数据。ledger-before.json 仅作 before 证据。
 *
 * 用法：
 *   node restore-${ctx.ts}.mjs              # dry-run：只查现状，零写入
 *   node restore-${ctx.ts}.mjs --apply      # 真还原（逐卡）
 *
 * 退出码：0 全部已回到未归档 ／ 1 有卡还原失败 ／ 2 用法错 ／ 3 环境不可用
 *        4 有 id 在本账本中找不到（不阻断其它卡，需人工核对）
 *
 * 注意（看板语义）：restore 只清 archivedAt、回原状态列；**schedule 不自动恢复**，
 * 定时卡要重新 set-schedule。
 */
import { randomUUID } from "node:crypto";

// K3 修复（2026-09-24）：BASE **烧进生成时用的那个实例**（原来硬编码 localhost:3080 ⇒
// 在测试实例（3090）上生成的回滚脚本会去打**生产**：找不到卡是常态，但一旦 id 撞上就会误动生产）。
// 仍然允许用环境变量 DSH_BOARD_BASE 覆盖，便于事后改指向。
const BASE = (process.env.DSH_BOARD_BASE || "${ctx.baseUrl}").replace(/\\/+$/, "");
const HEADERS_GET = { origin: BASE, "sec-fetch-site": "same-origin", accept: "application/json", "x-dsh-board-scope": "all" };
const HEADERS_POST = { ...HEADERS_GET, "content-type": "application/json" };
const TIMEOUT_MS = 30000;

const IDS = ${idsJson};
const EXPECT_REV = ${ctx.revBefore};

async function getState() {
  const res = await fetch(BASE + "/api/task-board/state", { headers: HEADERS_GET, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error("GET /state HTTP " + res.status);
  const body = await res.json();
  if (!body || !Array.isArray(body.tasks)) throw new Error("响应里没有 tasks[]");
  return body;
}

async function postRestore(taskId) {
  const res = await fetch(BASE + "/api/task-board/action", {
    method: "POST",
    headers: HEADERS_POST,
    body: JSON.stringify({ requestId: randomUUID(), action: { kind: "restore", taskId } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  return { status: res.status, text };
}

const archived = (t) => t.archivedAt !== undefined && t.archivedAt !== null;

async function main() {
  const apply = process.argv.includes("--apply");
  const bad = process.argv.slice(2).filter((a) => a !== "--apply" && a !== "--json");
  if (bad.length) {
    console.error("未知参数：" + bad.join(" "));
    console.error("用法：node restore-${ctx.ts}.mjs [--apply]");
    process.exitCode = 2;
    return;
  }

  let state;
  try {
    state = await getState();
  } catch (e) {
    console.error("[fail-closed] " + e.message + " —— 未做任何写入");
    process.exitCode = 3;
    return;
  }

  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  const revBefore = state.revision;
  const missing = IDS.filter((id) => !byId.has(id));
  const alreadyOk = IDS.filter((id) => byId.has(id) && !archived(byId.get(id)));
  const toRestore = IDS.filter((id) => byId.has(id) && archived(byId.get(id)));

  console.log("=== restore-${ctx.ts} · " + (apply ? "APPLY" : "DRY-RUN") + " ===");
  console.log("目标主机   : " + BASE);
  console.log("revision   : 当前 " + (revBefore ?? "?") + "（归档时 " + EXPECT_REV + "）");
  console.log("卡片总数   : " + IDS.length + " 张 · 已归档待还原 " + toRestore.length + " · 已还原 " + alreadyOk.length + " · 账本中找不到 " + missing.length);
  if (missing.length) {
    console.log("找不到的 id（需人工核对，不阻断其它卡）：");
    for (const id of missing) console.log("  · " + id);
  }

  if (!apply) {
    console.log("");
    console.log("（dry-run：以上为现状，未写入任何数据；加 --apply 才真还原）");
    process.exitCode = missing.length ? 4 : 0;
    return;
  }

  if (toRestore.length === 0) {
    console.log("");
    console.log("无需还原：这些卡当前都不处于归档态。");
    process.exitCode = missing.length ? 4 : 0;
    return;
  }

  let okCount = 0;
  const failed = [];
  for (const id of toRestore) {
    const t = byId.get(id);
    let r;
    try {
      r = await postRestore(id);
    } catch (e) {
      failed.push({ id, title: t.title, error: e.message });
      console.log("  ✗ " + id + " " + t.title + " —— 请求失败：" + e.message);
      continue;
    }
    if (r.status >= 200 && r.status < 300) {
      okCount++;
      console.log("  ✓ " + id + " " + t.title);
    } else {
      failed.push({ id, title: t.title, error: "HTTP " + r.status + " " + r.text.slice(0, 200) });
      console.log("  ✗ " + id + " " + t.title + " —— HTTP " + r.status + " " + r.text.slice(0, 200));
    }
  }

  let revAfter = null;
  let stillArchived = [];
  try {
    const s2 = await getState();
    revAfter = s2.revision;
    const map2 = new Map(s2.tasks.map((t) => [t.id, t]));
    stillArchived = toRestore.filter((id) => map2.has(id) && archived(map2.get(id)));
  } catch (e) {
    console.log("⚠ 回读 state 失败：" + e.message);
  }

  console.log("");
  console.log("还原成功 " + okCount + " / 目标 " + toRestore.length + " 张");
  if (failed.length) {
    console.log("失败 " + failed.length + " 张：");
    for (const f of failed) console.log("  · " + f.id + " " + f.title + " :: " + f.error);
  }
  if (revAfter !== null) {
    console.log("revision   : " + revBefore + " → " + revAfter + "（增量 " + (revAfter - revBefore) + "）");
    if (stillArchived.length) console.log("回读复核：仍有 " + stillArchived.length + " 张处于归档态（见上）");
    else if (failed.length === 0) console.log("回读复核：目标卡已全部回到未归档态 ✅");
  }
  console.log("");
  console.log("提示（K3 · 归档已物理化）：restore 由 Host 负责把卡**从归档批次搬回主账本**（清 archivedAt）；");
  console.log("      **定时卡的 schedule 不会自动恢复**，需要重新 set-schedule。");
  console.log("      若该实例还是「打标记」旧语义（未部署 K1），restore 行为与以前一致（只清标记）。");

  process.exitCode = failed.length || stillArchived.length ? 1 : missing.length ? 4 : 0;
}

main().catch((e) => {
  console.error("[fail-closed] 未预期错误：" + (e && e.stack ? e.stack : e));
  process.exitCode = 3;
});
`;
}

function buildRestoreCmd(ctx) {
  // 纯 ASCII、CRLF（本机铁律：.cmd/.bat 禁中文，否则 cmd.exe 按 GBK 解析拆坏命令）
  return [
    "@echo off",
    "REM ===========================================================",
    `REM  restore-${ctx.ts}.cmd   (ASCII only, CRLF)`,
    "REM  One-click restore for board-archive-line batch archive.",
    `REM  Cards  : ${ctx.ids.length} (line: board archive batch, ts ${ctx.ts})`,
    `REM  Script : ${path.join(ARCHIVE_HOME, 'board-archive-' + ctx.ts, 'restore-' + ctx.ts + '.mjs')}`,
    "REM  Mode   : per-card API restore. NEVER overwrites ledger-v2.json.",
    "REM  Usage  : double-click, then type YES to confirm.",
    "REM ===========================================================",
    "setlocal enableextensions",
    `set "SCRIPT=${path.join(ARCHIVE_HOME, 'board-archive-' + ctx.ts, 'restore-' + ctx.ts + '.mjs')}"`,
    "",
    "echo === board archive batch restore ===",
    "if not exist \"%SCRIPT%\" (",
    "  echo [ERROR] restore script not found:",
    "  echo         %SCRIPT%",
    "  pause",
    "  exit /b 3",
    ")",
    "echo Script : %SCRIPT%",
    "echo.",
    "echo [1/2] Dry-run preview:",
    "node \"%SCRIPT%\"",
    "if errorlevel 4 echo [WARN] some ids missing in ledger - review above.",
    "echo.",
    "set \"ANS=\"",
    "set /p \"ANS=Type YES to restore these cards: \"",
    "if /i not \"%ANS%\"==\"YES\" (",
    "  echo Aborted. Nothing was changed.",
    "  pause",
    "  exit /b 1",
    ")",
    "echo [2/2] Applying per-card restore:",
    "node \"%SCRIPT%\" --apply",
    "echo.",
    "echo [DONE] exit code above: 0 = all restored, 1 = some failed.",
    "echo Note: schedule of recurring cards is NOT restored automatically.",
    "echo.",
    "pause",
    "endlocal",
    "exit /b 0",
    "",
  ].join("\r\n");
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  let opts;
  try {
    const raw = parseArgs(process.argv.slice(2));
    if (raw.help) {
      console.log(HELP);
      process.exitCode = EXIT_OK;
      return;
    }
    opts = normalizeOptions(raw);
  } catch (e) {
    console.error(`用法错误：${e.message}\n`);
    console.error(HELP);
    process.exitCode = EXIT_USAGE;
    return;
  }

  // ① 拉一次 state（dry-run 的全部事实来源；apply 的初始清单 + 校验依据）
  let state;
  try {
    state = await fetchState();
  } catch (e) {
    console.error(`[fail-closed] ${e.message}`);
    console.error("读不到看板 state，本次**没有**做任何判断，也未写入任何数据。");
    process.exitCode = EXIT_ENV;
    return;
  }
  const revBefore = state.revision;
  const archivedTotalBefore = state.tasks.filter(isArchived).length;

  // ② 目标选择 + --line 精确校验
  const sel = selectTargets(opts, state);
  if (sel.error === "line-not-found") {
    console.error(`[exit 2] --line 值在账本里不存在：${JSON.stringify(opts.line)}`);
    console.error("先校验是为了防手打同义新名 → 归档 0 张却报成功。相近候选：");
    console.error("");
    for (const c of sel.candidates.slice(0, 8)) console.error(`  · ${c.line}`);
    if (sel.candidates.length === 0) console.error("  （账本里没有任何 line 值）");
    console.error("");
    console.error(`账本现有主线共 ${sel.allLines.length} 条，全部如下：`);
    for (const l of sel.allLines) console.error(`  - ${l}`);
    process.exitCode = EXIT_USAGE;
    return;
  }
  if (sel.missing && sel.missing.length > 0) {
    console.error(`[exit 2] --ids 里这些 id 在账本中不存在：${sel.missing.join(", ")}`);
    console.error("（请核对 id；本脚本不猜、不跳过，避免「以为归档了其实没动」）");
    process.exitCode = EXIT_USAGE;
    return;
  }

  const { targets, skipped } = targetsOf(sel.pool, opts.statuses);
  const lineLabel = opts.line !== null ? `--line ${JSON.stringify(opts.line)}` : `--ids（${opts.ids.length} 个）`;

  // ③ dry-run 或 apply
  const result = {
    ok: true,
    mode: opts.apply ? "apply" : "dry-run",
    source: opts.line !== null ? { kind: "line", value: opts.line } : { kind: "ids", value: opts.ids },
    statuses: opts.statuses,
    revisionBefore: revBefore ?? null,
    scanned: { total: state.tasks.length, archivedBefore: archivedTotalBefore, pool: sel.pool.length },
    targetCount: targets.length,
    skippedCount: skipped.length,
    targets: targets.map((t) => ({ id: t.id, title: t.title, status: t.status, seq: normSeq(t), line: normLine(t) })),
    skipped: skipped.map((s) => ({ id: s.task.id, title: s.task.title, status: s.task.status, reason: s.reason })),
  };

  if (!opts.apply) {
    if (!opts.json) {
      console.log(`看板按主线批量归档 · DRY-RUN（零写入）· revision ${revBefore ?? "?"}`);
      console.log(`目标口径：${lineLabel}`);
      console.log(`账本全量 ${state.tasks.length} 张（已归档 ${archivedTotalBefore}），本口径命中 ${sel.pool.length} 张`);
      console.log("");
      for (const l of renderList(targets, skipped, opts.statuses)) console.log(l);
      // dry-run 输出必须逐字节稳定 → 这里绝不能打印时间
      console.log("");
    }
    const jsonOut = { ...result, note: "dry-run：未写入任何数据" };
    if (opts.json) console.log(JSON.stringify(jsonOut, null, 2));
    else if (targets.length === 0) console.log("（目标 0 张）——若不是你预期，请核对 --line 值与 --status。");
    else console.log("（dry-run 未写入任何数据；确认无误后加 --apply）");

    process.exitCode = targets.length === 0 ? EXIT_ZERO : EXIT_OK;
    return;
  }

  // ── apply 分支 ──
  const ts = stamp();
  const pointDir = path.join(ARCHIVE_HOME, `board-archive-${ts}`);

  // ⓪ 校验「目标卡当前是否仍可归档」——逐卡实时判定的第一道：以刚拉的 state 为准
  if (targets.length === 0) {
    console.error(`[exit ${EXIT_ZERO}] 可归档目标 0 张（口径 ${lineLabel}），未执行任何写入。`);
    if (skipped.length) console.error(`（本口径命中 ${sel.pool.length} 张但全部被跳过：已归档或不在 ${opts.statuses.join("/")}）`);
    process.exitCode = EXIT_ZERO;
    return;
  }

  // ① before 证据：账本快照（**仅作证据**，还原绝不走它）
  fs.mkdirSync(pointDir, { recursive: true });
  const ledgerBeforePath = path.join(pointDir, "ledger-before.json");
  fs.writeFileSync(ledgerBeforePath, JSON.stringify(state, null, 2), "utf8");

  console.log(`看板按主线批量归档 · APPLY · 目标口径 ${lineLabel}`);
  console.log(`回滚点：${pointDir}`);
  console.log(`账本副本（仅证据，不用于写回）：${ledgerBeforePath}`);
  console.log(`apply 前 revision ${revBefore ?? "?"} · 已归档 ${archivedTotalBefore} 张`);
  console.log(`本次目标 ${targets.length} 张：`);
  console.log("");
  for (const l of renderList(targets, skipped, opts.statuses)) console.log(l);
  console.log("");

  // ② 逐卡归档（**逐卡按最新状态判定**，不信任初始清单）
  const live = new Map(state.tasks.map((t) => [t.id, t]));
  const succeeded = [];
  const already = []; // 已被处理/不可归档（400）
  const failed = [];

  for (const t0 of targets) {
    const id = t0.id;
    const cur = live.get(id);
    const kind = classify(cur, opts.statuses);
    if (kind !== "target") {
      const why = kind === "missing" ? "账本中已不存在（本地判定）" : kind === "archived" ? "已是归档态（本地判定）" : `status=${cur.status} 不在可归档集合（本地判定）`;
      already.push({ id, title: cur ? cur.title : t0.title, reason: why });
      console.log(`  ⏭ ${id} ${cur ? cur.title : t0.title} —— ${why}`);
      continue;
    }

    let r;
    try {
      r = await postAction({ kind: "archive", taskId: id });
    } catch (e) {
      failed.push({ id, title: cur.title, error: e.message });
      console.log(`  ✗ ${id} ${cur.title} —— 请求失败：${e.message}（**已停止**，后续卡未处理）`);
      break;
    }

    if (r.status >= 200 && r.status < 300) {
      succeeded.push({ id, title: cur.title, seq: normSeq(cur), status: cur.status });
      cur.archivedAt = Date.now();
      console.log(`  ✓ ${id} ${cur.title}`);
      continue;
    }

    // 400 task cannot be archived：卡不存在与卡已归档返回**同一条**消息 → 只能靠本地判定区分
    const msg = (r.body && r.body.error) || r.text.slice(0, 200);
    if (r.status === 400 && /cannot be archived/i.test(String(msg))) {
      let liveKind = "unknown";
      try {
        const s2 = await fetchState();
        const map2 = new Map(s2.tasks.map((t) => [t.id, t]));
        const cur2 = map2.get(id);
        if (cur2) live.set(id, cur2);
        liveKind = classify(cur2, opts.statuses);
      } catch {
        /* 回读失败：保持 unknown，仍归入「已处理/不可归档」 */
      }
      const why =
        liveKind === "archived"
          ? "回读判定：已是归档态"
          : liveKind === "missing"
            ? "回读判定：账本中已不存在"
            : liveKind === "status"
              ? "回读判定：status 已不在可归档集合"
              : "400 task cannot be archived（卡不存在与已归档同一条消息，无法区分）";
      already.push({ id, title: cur.title, reason: why });
      console.log(`  ⏭ ${id} ${cur.title} —— ${why}（继续）`);
      continue;
    }

    failed.push({ id, title: cur.title, error: `HTTP ${r.status} ${String(msg).slice(0, 200)}` });
    console.log(`  ✗ ${id} ${cur.title} —— HTTP ${r.status} ${String(msg).slice(0, 200)}（**已停止**，后续卡未处理）`);
    break;
  }

  // ③ 收尾读数
  let revAfter = null;
  let archivedTotalAfter = null;
  try {
    const s3 = await fetchState();
    revAfter = s3.revision;
    archivedTotalAfter = s3.tasks.filter(isArchived).length;
    live.clear();
    for (const t of s3.tasks) live.set(t.id, t);
  } catch (e) {
    console.log(`⚠ 收尾回读 state 失败：${e.message}`);
  }

  const revDelta = revAfter !== null && revBefore !== null ? revAfter - revBefore : null;
  const archivedDelta = archivedTotalAfter !== null ? archivedTotalAfter - archivedTotalBefore : null;

  console.log("");
  console.log("── 汇总 ──");
  console.log(`成功归档 ${succeeded.length} 张 ／ 已处理·不可归档 ${already.length} 张 ／ 失败 ${failed.length} 张`);
  if (already.length) {
    console.log("已处理/不可归档明细：");
    for (const a of already) console.log(`  · ${a.id} ${a.title} :: ${a.reason}`);
  }
  if (failed.length) {
    console.log("失败明细：");
    for (const f of failed) console.log(`  · ${f.id} ${f.title} :: ${f.error}`);
  }
  console.log(`revision：${revBefore} → ${revAfter ?? "?"}（增量 ${revDelta ?? "?"}）`);
  console.log(`归档计数：${archivedTotalBefore} → ${archivedTotalAfter ?? "?"}（增量 ${archivedDelta ?? "?"}）`);
  console.log(`账本副本（before 证据）：${ledgerBeforePath}`);

  // ③b K3 · 物理搬出确认（真判据 = 卡真的在归档批次里，而不是"打了归档标记"）
  if (succeeded.length) {
    const ids = await physicalArchiveIds();
    const hit = succeeded.filter((s) => ids.ids.has(s.id)).length;
    if (ids.ok && hit === succeeded.length) {
      console.log(`物理搬出确认：${hit}/${succeeded.length} 张已在归档批次 ✅（来源 ${ids.sources.join(" + ") || "(无)"}）`);
    } else if (ids.ok) {
      console.log(`物理搬出确认：${hit}/${succeeded.length} 张在归档批次 · ⚠ ${succeeded.length - hit} 张不在批次里（Host 可能仍是"打标记"旧语义，或批次文件未落）—— 请复核`);
    } else {
      console.log(`物理搬出确认：未判定（${ids.errors.join("；") || "无归档面"}）—— 归档动作本身已成功；该实例部署 K1/K2 后此处会给出确切读数`);
    }
  }

  // ④ 还原脚本（逐卡 API，禁止文件覆盖）
  let restorePaths = null;
  if (opts.emitRestore && succeeded.length > 0) {
    const ctx = {
      ts,
      // K3：把"生成这台工具的实例"烧进回滚脚本（原来回滚脚本硬编码生产 3080）
      baseUrl: BASE,
      ids: succeeded.map((s) => s.id),
      revBefore: revBefore ?? null,
      lineLabel: opts.line !== null ? `--line "${opts.line}"` : `--ids（${succeeded.length} 个）`,
      line: opts.line,
    };
    const mjsPath = path.join(pointDir, `restore-${ts}.mjs`);
    fs.writeFileSync(mjsPath, buildRestoreMjs(ctx), "utf8");
    const cmdName = `restore-board-archive-${ts}.cmd`;
    const cmdPath = path.join(DESKTOP_DIR, cmdName);
    let cmdWritten = null;
    try {
      fs.mkdirSync(DESKTOP_DIR, { recursive: true });
      fs.writeFileSync(cmdPath, buildRestoreCmd(ctx), "utf8");
      cmdWritten = cmdPath;
    } catch (e) {
      console.log(`⚠ 桌面 .cmd 写入失败：${e.message}`);
    }
    restorePaths = { mjs: mjsPath, cmd: cmdWritten };
    console.log("");
    console.log(`还原脚本（逐卡 restore action，禁止文件覆盖）：${mjsPath}`);
    console.log(`  用法：node "${mjsPath}"            # dry-run 预览`);
    console.log(`        node "${mjsPath}" --apply    # 真还原`);
    if (cmdWritten) console.log(`一键入口（纯 ASCII）：${cmdWritten}`);
    console.log(`  可复跑：node "${mjsPath}" && node "${mjsPath}" --apply`);
  } else if (opts.emitRestore && succeeded.length === 0) {
    console.log("");
    console.log("⚠ --emit-restore：本次成功归档 0 张，未生成还原脚本。");
  }

  const jsonOut = {
    ...result,
    ok: failed.length === 0,
    rollbackPoint: pointDir,
    ledgerBefore: ledgerBeforePath,
    succeeded,
    already,
    failed,
    revisionAfter: revAfter,
    revisionDelta: revDelta,
    archivedBefore: archivedTotalBefore,
    archivedAfter: archivedTotalAfter,
    archivedDelta,
    restore: restorePaths,
    restoreCommand: restorePaths ? `node "${restorePaths.mjs}" --apply` : null,
  };
  if (opts.json) console.log(JSON.stringify(jsonOut, null, 2));
  else {
    console.log("");
    console.log(failed.length === 0 ? "（apply 完成；用上面的还原脚本可逐卡撤回）" : "（有失败项，见上；部分卡可能已归档，用还原脚本逐卡撤回）");
  }

  process.exitCode = failed.length > 0 ? EXIT_FAIL : already.length > 0 ? EXIT_SKIPPED : EXIT_OK;
}

main().catch((e) => {
  console.error(`[fail-closed] 未预期错误：${e && e.stack ? e.stack : e}`);
  process.exitCode = EXIT_ENV;
});
