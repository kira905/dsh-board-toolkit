#!/usr/bin/env node
/**
 * board-dup-check.mjs —— 看板建卡前查重助手（只读，零依赖，node 内置 fetch）
 *
 * 为什么存在（方案：docs\看板归档与查重-方案-20260914.md §1 G2/G3）：
 *   - GUI 的状态视图与主线视图**都过滤归档卡**，只看板面会漏看历史；
 *   - `create` 动作**没有标题查重**，重复建卡零机制防护；
 *   - 账本 `/state` 返回**全量**（含归档卡）→ 本脚本即从此取数。
 *
 * ★K3（2026-09-24 · 看板瘦身/归档物理化 · 方案 §8 #6 · 判据 J10）：**必须扫到归档卡**。
 *   归档物理化之后归档卡住在 `task-board/archive/<batchId>/cards.json`（不再在主账本里），
 *   而 Host 的 `scope=all`（**默认**）是 `mergeBoardView(主账本, 全部归档批次)`（K2 已落地）
 *   ⇒ 本脚本**只要坚持不带 live 头**就仍然看得见归档卡。所以这里做两件事：
 *     ① **显式**发送 `x-dsh-board-scope: all` —— 把"我要整本（含归档卡）"写成协议的一部分，
 *        将来谁改默认口径都不会把本工具静默降级成"只看在板卡"；
 *     ② 探一次 `GET /api/task-board/archive` 自检：**该实例报告的归档张数 > 0，而 `/state`
 *        里一张归档卡都没有** ⇒ 说明合并视图没带归档卡（Host 版本旧或回归）⇒ 显式告警，
 *        绝不静默当作"没有历史卡"（J10 的防线）。
 *
 * 定位：输出「候选清单」，不是结论；**不阻断建卡**、不自动创建/合并、不写任何数据。
 * fail-closed：读不到 `/state` 一律非 0 退出，绝不静默当作"无命中"。
 *
 * 退出码：0 = 无命中 ／ 3 = 有命中 ／ 2 = 用法错 ／ 4 = 读不到看板 state
 *   （归档面探测失败 / 触发告警**不改退出码** —— 它是"提醒你看一眼"，不是"读不到看板"）
 * 收尾一律 `process.exitCode`（本机已知坑：发过 fetch 的脚本用 process.exit() 会触发 libuv 断言 0xC0000409）。
 *
 * 用法：
 *   node <workspace>\tools\board-dup-check.mjs --kw 生图数据恢复
 *   node <workspace>\tools\board-dup-check.mjs --kw 归档 --kw 查重 --any --deep --json
 */

// 默认生产实例；仅用于测试/多实例排查时才用环境变量覆盖（生产一律 localhost:3080）
const BASE = (process.env.DSH_BOARD_BASE || "http://localhost:3080").replace(/\/+$/, "");
const STATE_URL = `${BASE}/api/task-board/state`;
const ARCHIVE_URL = `${BASE}/api/task-board/archive`;
const HEADERS = {
  origin: BASE,
  "sec-fetch-site": "same-origin",
  accept: "application/json",
  // K3：**显式**要整本（含归档卡）。Host 对"非 live"一律按 all 处理，带头只是把意图写进协议。
  "x-dsh-board-scope": "all",
};
const SNIPPET_MAX = 200;
const TIMEOUT_MS = 20000;

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_HIT = 3;
const EXIT_ENV = 4;

// 与看板源码 src\core\tasks.ts 的 ARCHIVABLE_STATUSES 对齐（仅用于输出提示，不参与判定）
const ARCHIVE_READONLY_HINT = "归档卡只读：line/seq 归档后改不了（要改只能 restore → 改 → 再 archive）";

class UsageError extends Error {}
class EnvError extends Error {}

const HELP = `看板建卡前查重助手（只读，扫全量含归档卡）

数据源与归档面（K3 · 2026-09-24）：
  · /state 一律带 \`x-dsh-board-scope: all\` ⇒ Host 端 = 主账本 + 全部归档批次的**合并视图**
    （归档物理化后卡住在 task-board/archive/<batchId>/cards.json，本工具靠这个头看得见它们）；
  · 另探一次 /archive 自检："有物理归档卡但合并视图里一张都没有"会显式告警（不静默少看卡）。

用法：
  node <workspace>\\tools\\board-dup-check.mjs --kw <关键词> [--kw <关键词>…] [选项]

选项：
  --kw <词>      关键词，可重复；默认多词 AND（同一张卡要都命中）
  --any          多关键词改为 OR（任一命中即算）
  --line <主线>  只在指定主线内查（与卡上 line 精确字符串匹配）
  --deep         追加匹配 prompt 全文（默认只匹配 title + description）
  --json         机读 JSON 输出（stdout 只有 JSON）
  -h, --help     显示本帮助

判据：对 title + description（--deep 时再加 prompt）做**子串**匹配，中文不切词、大小写不敏感。
输出：每条命中的 [在板/已归档] / status / archivedAt / line / seq / 执行数 / title / 命中文本（截 ${SNIPPET_MAX} 字符）。

退出码：0 无命中 ／ 3 有命中 ／ 2 用法错 ／ 4 读不到看板 state（fail-closed）

注意：本工具是「候选清单」不是结论——命中不等于重复（同题重开是合法需求），判断权在人。
${" ".repeat(6)}${ARCHIVE_READONLY_HINT}
${" ".repeat(6)}数据源默认 http://localhost:3080（仅测试/多实例排查时用环境变量 DSH_BOARD_BASE 覆盖）。`;

function parseArgs(argv) {
  const opts = { kws: [], any: false, line: null, deep: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--kw" || a === "--line") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`参数 ${a} 缺少值`);
      i++;
      if (v.trim() === "") throw new UsageError(`参数 ${a} 的值是空串`);
      if (a === "--kw") opts.kws.push(v);
      else opts.line = v;
    } else if (a === "--any") opts.any = true;
    else if (a === "--deep") opts.deep = true;
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new UsageError(`未知参数 ${a}`);
  }
  return opts;
}

async function fetchState() {
  let res;
  try {
    res = await fetch(STATE_URL, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
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
  if (!body || !Array.isArray(body.tasks)) {
    throw new EnvError("响应里没有 tasks[] 数组——看板未就绪或接口已变更");
  }
  return body;
}

/**
 * K3 · 归档面探测（只读，一次小请求；**不改退出码**）。
 *
 * 目的：自检「本实例有物理归档批次，但 `/state` 没带回归档卡」这种静默少看卡的情形。
 * `GET /archive?limit=1` 的 `totals` 就够判定（只回 1 个批次的摘要，跟全量无关）。
 *
 * 三种结果（**诚实区分，别混**）：
 *   `{supported:true, batches, cards}`  —— 该实例有归档读路由（K1/K2 已部署）
 *   `{supported:false, reason:'route-missing'}` —— 404：该实例插件**还没有**归档读路由。
 *        此时"物理归档"根本不存在（归档卡都在主账本里、`/state` 必然带 `archivedAt`）
 *        ⇒ 无漏看风险，**不告警**（这是集成期的正常态）。
 *   `{supported:null, error}`          —— 其它失败（网络/5xx）：**只提示，不当结论**。
 */
async function probeArchive() {
  let res;
  try {
    res = await fetch(`${ARCHIVE_URL}?limit=1`, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return { supported: null, error: e && e.message ? e.message : String(e) };
  }
  // 404 = 该实例没有这条路由；401/403 = 未知路径落到主包 API 网关的兜底鉴权（实测生产旧插件就是 401）。
  // 三者同义：**该实例没有归档读路由** ⇒ 尚未物理归档 ⇒ 归档卡都在主账本里（无漏看风险，不告警）。
  if (res.status === 404 || res.status === 401 || res.status === 403) {
    return { supported: false, reason: "route-missing", httpStatus: res.status };
  }
  if (!res.ok) return { supported: null, error: `HTTP ${res.status}` };
  let j;
  try {
    j = await res.json();
  } catch (e) {
    return { supported: null, error: `响应不是合法 JSON（${e && e.message ? e.message : e}）` };
  }
  return {
    supported: true,
    batches: Number(j?.totals?.batches ?? 0) || 0,
    cards: Number(j?.totals?.cards ?? 0) || 0,
    revision: j?.revision ?? null,
  };
}

/**
 * 归档面可见性判据（纯函数，便于自检）：
 * @returns {null|string} 告警文案（null = 无需告警）
 */
function archiveVisibilityWarning(probe, archivedInState) {
  if (!probe || probe.supported !== true) return null;
  if (probe.cards > 0 && archivedInState === 0) {
    return `本实例报告有 ${probe.cards} 张物理归档卡（${probe.batches} 个批次），但 /state 的合并视图里一张归档卡都没有` +
      ` ⇒ Host 的 mergeBoardView 可能失效（版本旧/回归），本次查重**可能漏看归档卡**，建卡前请人工核一眼归档页`;
  }
  return null;
}

function haystackFields(task, deep) {
  const fields = [
    ["title", task.title ?? ""],
    ["description", task.description ?? ""],
  ];
  if (deep) fields.push(["prompt", task.prompt ?? ""]);
  return fields;
}

function findFirstMatch(fields, kws) {
  // 返回 { field, index }：取最早出现的关键词位置，用于截取命中片段
  let best = null;
  for (const [name, text] of fields) {
    const lower = text.toLowerCase();
    for (const kw of kws) {
      const idx = lower.indexOf(kw.toLowerCase());
      if (idx >= 0 && (best === null || idx < best.index)) best = { field: name, index: idx, text };
    }
  }
  return best;
}

function snippetOf(text, index) {
  const start = Math.max(0, index - 30);
  const raw = text.slice(start, start + SNIPPET_MAX).replace(/\s+/g, " ").trim();
  return {
    text: raw.length < text.length ? `${start > 0 ? "…" : ""}${raw}…` : raw,
    truncated: text.length > SNIPPET_MAX,
    length: text.length,
  };
}

function fmtTime(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function run(opts, state) {
  const kwLc = opts.kws.map((k) => k.toLowerCase());
  const isArchived = (t) => t.archivedAt !== undefined && t.archivedAt !== null;
  const inLine = (t) => (opts.line === null ? true : String(t.line ?? "") === opts.line);

  const hits = [];
  for (const t of state.tasks) {
    if (!inLine(t)) continue;
    const fields = haystackFields(t, opts.deep);
    const lowerAll = fields.map(([, text]) => text.toLowerCase()).join("\n");
    const matched = opts.kws.filter((k) => lowerAll.includes(k.toLowerCase()));
    const isHit = kwLc.length === 0 ? true : opts.any ? matched.length > 0 : matched.length === kwLc.length;
    if (!isHit) continue;

    const at = findFirstMatch(fields, opts.kws.length ? opts.kws : [""]);
    const snippet = at ? snippetOf(at.text, Math.max(0, at.index)) : null;
    hits.push({
      id: t.id,
      archived: isArchived(t),
      status: t.status,
      archivedAt: isArchived(t) ? t.archivedAt : null,
      archivedAtText: isArchived(t) ? fmtTime(t.archivedAt) : null,
      line: t.line === undefined || t.line === null || String(t.line).trim() === "" ? null : String(t.line),
      seq: t.seq === undefined || t.seq === null || String(t.seq).trim() === "" ? null : String(t.seq),
      executions: Array.isArray(t.executions) ? t.executions.length : 0,
      title: t.title ?? "",
      matchedKeywords: matched,
      matchedField: at ? at.field : null,
      snippet: snippet ? snippet.text : null,
      snippetFullLength: snippet ? snippet.length : null,
      updatedAt: t.updatedAt ?? 0,
    });
  }

  // 在板在前，各自按 updatedAt 倒序（新的先看）
  hits.sort((a, b) => (a.archived === b.archived ? (b.updatedAt ?? 0) - (a.updatedAt ?? 0) : a.archived ? 1 : -1));
  return hits;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`用法错误：${e.message}\n`);
    console.error(HELP);
    process.exitCode = EXIT_USAGE;
    return;
  }

  if (opts.help) {
    console.log(HELP);
    process.exitCode = EXIT_OK;
    return;
  }

  if (opts.kws.length === 0 && opts.line === null) {
    console.error("用法错误：至少要给一个 --kw 关键词（或用 --line 单独列一条主线的卡）\n");
    console.error(HELP);
    process.exitCode = EXIT_USAGE;
    return;
  }

  let state;
  try {
    state = await fetchState();
  } catch (e) {
    console.error(`[fail-closed] ${e.message}`);
    console.error("读不到看板 state，本次**没有**做过任何判断，请勿据此认为「无重复」。");
    process.exitCode = EXIT_ENV;
    return;
  }

  const hits = run(opts, state);
  const archivedCount = state.tasks.filter((t) => t.archivedAt !== undefined && t.archivedAt !== null).length;
  const scanned = {
    total: state.tasks.length,
    archived: archivedCount,
    inBoard: state.tasks.length - archivedCount,
  };

  // K3 · 归档面自检（**只提示不改退出码**；见 probeArchive / archiveVisibilityWarning）
  const archiveProbe = await probeArchive();
  const archiveWarning = archiveVisibilityWarning(archiveProbe, archivedCount);
  const archiveView = {
    source: archiveProbe.supported === true ? "host-merge" : archiveProbe.supported === false ? "route-missing" : "unavailable",
    route: ARCHIVE_URL,
    routeStatus: archiveProbe.httpStatus ?? null,
    batches: archiveProbe.batches ?? null,
    batchCards: archiveProbe.cards ?? null,
    archivedInState: archivedCount,
    warning: archiveWarning,
    ...(archiveProbe.error ? { error: archiveProbe.error } : {}),
  };
  if (archiveWarning) console.error(`⚠ 归档面自检：${archiveWarning}`);
  else if (archiveView.source === "unavailable") {
    console.error(`⚠ 归档面自检未完成（${archiveProbe.error || "未知原因"}）—— 主账本命中不受影响，但"归档卡是否可见"未验证`);
  }
  const query = {
    keywords: opts.kws,
    mode: opts.any ? "OR" : "AND",
    line: opts.line,
    scope: opts.deep ? "title + description + prompt" : "title + description",
  };

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          revision: state.revision ?? null,
          scanned,
          archiveView,
          query,
          hitCount: hits.length,
          hits,
          note: "候选清单，不代表重复；不阻断建卡；归档卡经 Host 的 scope=all 合并视图（mergeBoardView）纳入",
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `看板查重（只读）· revision ${state.revision ?? "?"} · 全量 ${scanned.total} 张` +
        `（在板 ${scanned.inBoard} / 已归档 ${scanned.archived}）`,
    );
    console.log(
      `关键词：${opts.kws.length ? opts.kws.join(" ， ") : "（无，仅按主线筛选）"}` +
        `（${query.mode}·子串·大小写不敏感）` +
        `${opts.line ? `  主线：${opts.line}` : ""}`,
    );
    console.log(`匹配范围：${query.scope}`);
    console.log(
      `归档面：${
        archiveView.source === "host-merge"
          ? `Host 合并视图（scope=all）· 物理归档 ${archiveView.batchCards ?? 0} 张 / ${archiveView.batches ?? 0} 批 · 本次扫描内含归档卡 ${archivedCount} 张`
          : archiveView.source === "route-missing"
            ? `该实例无归档读路由（HTTP ${archiveView.routeStatus ?? "?"}；K1/K2 未部署）⇒ 尚未物理归档，归档卡仍在主账本内（不构成漏看）`
            : `不可用（${archiveProbe.error || "未知原因"}）—— 归档卡可见性未验证`
      }`,
    );

    console.log(`命中 ${hits.length} 张${hits.length ? " —— 候选清单，不代表重复，请自行判断" : ""}：`);
    console.log("");
    hits.forEach((h, i) => {
      const flag = h.archived ? "已归档" : "在板";
      console.log(
        `${i + 1}. [${flag}] status=${h.status}  archivedAt=${h.archivedAtText ?? "—"}  ` +
          `line=${h.line ?? "(未归线)"}  seq=${h.seq ?? "—"}  执行数=${h.executions}`,
      );
      console.log(`   title: ${h.title}`);
      if (h.snippet) console.log(`   命中(${h.matchedField}，原文 ${h.snippetFullLength} 字符): ${h.snippet}`);
      console.log(`   id: ${h.id}`);
    });
    if (hits.length === 0) {
      console.log("（无命中）——注意：本工具是子串匹配，同义改写的表述会漏报；必要时 --any / --deep / 换同义词再跑一次。");
    }
    if (hits.some((h) => h.archived)) console.log(`\n提示：${ARCHIVE_READONLY_HINT}`);
    console.log("\n（本工具只读，未写入任何数据；命中不等于重复，同题重开属合法需求。）");
  }

  process.exitCode = hits.length > 0 ? EXIT_HIT : EXIT_OK;
}

main().catch((e) => {
  console.error(`[fail-closed] 未预期错误：${e && e.stack ? e.stack : e}`);
  process.exitCode = EXIT_ENV;
});
