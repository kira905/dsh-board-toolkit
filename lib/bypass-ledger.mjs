// tools\lib\bypass-ledger.mjs —— **绕过留痕台账**（R-067 门误报治理 · 2026-10-16 · 卡「V3·机器锁7」）
//
// 一句话：任何**门被强制绕过**时，留一行可查的痕迹（时间 / 门名 / 原因 / 调用方 / 目标），
//   并把"绕过"从"私下动作"变成**日报上能看见的数字**。**它是观察面，不是闸门。**
//
// ❗来由（R-067 病根 · 逐条可查）：
//   ① **R-053 超集体检门「形态学误报」** —— 每次 Depart 都要走强推口子、形成死循环，
//      首次生产真删只能 `--force-collect` 绕过 ⇒ 「绕过了多少次」没人说得清。
//   ② **P8 refcheck `docs` 规则**把「文档提及」当「引用」且 `blocking:true` ⇒ 339 条被拦里 300 条只被 docs 命中，
//      阈值判据**不可达** ⇒ 只能整体放宽（而不是知道"这个门误报率多少"）。
//   ③ **`guard-unhealthy` / `dsh-why.mjs` 误报"双 launcher"** —— 同坑复发（只修一处、没有双向测）。
//   ⇒ 门一误报，人（或本鱼）就学会绕过；绕过一旦不可见，**门就等于没有**。
//
// ───────────────── 四条硬口径（改本文件前先读） ─────────────────
//   ① 🔴 **fail-open（本件的第一性原理）**：台账写失败**绝不能**反过来拒跑 / 阻断 / 改返回值语义。
//      本项目近两月 7 起"演练打到生产"全是"守卫自己出问题把正常流程带下水"的同族形态 ⇒
//      本件**任何**路径都不 throw；写失败只打一行 stderr 提示 + 返回 `{ok:false,error}`。
//      **它不是闸门** —— 想拦住动作请去 `production-guard.mjs`（那边 fail-closed 是对的，因为它管真写）。
//   ② **不另造参数解析**（R-067 卡面红线）：本件不做 CLI 参数解析、不 import `deploy-guard` 的 parseArgs。
//      它只是被别的脚本 `import` 的一个函数库（+ 供夹具/日报直接调用的纯函数）。
//   ③ **不绕过就零写入**（卡面判据 B）：`recordBypass` 只由"放行真的被用上"的调用点触发；
//      没给放行开关的正常跑**一次都不会调它** ⇒ 台账零新增（防空跑污染计数）。
//   ④ **写哪里可注入**（测试隔离铁律）：`opts.file` > `$DSH_BYPASS_LEDGER_FILE` > 默认 `<home>\butler-bypass-ledger.jsonl`。
//      夹具/单测**必须**显式指到沙箱，绝不碰生产台账。
//
// ───────────────── 门名（gate）口径 ─────────────────
//   gate 是**稳定短名**（进日报聚合，改名等于另起一门 ⇒ 禁随手改）：
//     allow-production   · 生产写放行（`--allow-production`，走 production-guard 共享件的那些脚本）
//     allow-reparse      · junction 跟删放行（`--allow-reparse`）
//     scan-degrade       · 扫描失败降级（`--on-scan-error warn`）
//     env-destructive-guard · 环境变量总开关（`DSH_DESTRUCTIVE_GUARD=off`）
//     restart-force      · 重启强制档（`request-restart.mjs --force`）
//     force-collect      · 超集体检门绕过（`handoff.mjs --force-collect`）
//     file-lease-takeover· 文件租约接管（`file-lease.mjs --takeover`；R-064 已有自己的计数，只做统一留痕）
//
// 本文件零副作用之外的写：**只 append 自己那本台账**；不 exit（退出码由调用方落）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveDshHome } from './dsh-home.mjs';

/** 台账文件名（落在 <home> 根，与 `butler-falsepositives.jsonl` / `butler-barewatch-ledger.jsonl` 同族）。 */
export const LEDGER_BASENAME = 'butler-bypass-ledger.jsonl';
/** 覆盖台账路径的环境变量（夹具/单测用）。 */
export const LEDGER_ENV = 'DSH_BYPASS_LEDGER_FILE';
/** 已知门名 → 中文标签（日报渲染用；未知门名原样显示，不猜）。 */
export const GATE_LABELS = {
  'allow-production': '生产写放行 --allow-production',
  'allow-reparse': 'junction 跟删放行 --allow-reparse',
  'scan-degrade': '扫描失败降级 --on-scan-error warn',
  'env-destructive-guard': '总开关 DSH_DESTRUCTIVE_GUARD=off',
  'restart-force': '重启强制档 --force',
  'force-collect': '超集体检绕过 --force-collect',
  'file-lease-takeover': '文件租约接管 --takeover',
};

/** 台账绝对路径：`opts.file` > `$DSH_BYPASS_LEDGER_FILE` > `<home>\butler-bypass-ledger.jsonl`。 */
export function bypassLedgerFile(opts = {}) {
  if (opts.file) return path.resolve(String(opts.file));
  const env = process.env[LEDGER_ENV];
  if (env && String(env).trim()) return path.resolve(String(env).trim());
  return path.join(resolveDshHome(opts.home), LEDGER_BASENAME);
}

/** 本进程 stdout 是不是机读模式（`--json`）—— 是则提示行改走 stderr（铁律：--json 时日志不上 stdout）。 */
function jsonMode(argv = process.argv) {
  return Array.isArray(argv) && argv.includes('--json');
}

/** 清单一行的显式提示文本（stdout / stderr 由调用处决定）。 */
export function bypassNoticeLine(ev) {
  const gate = String(ev?.gate ?? '(未标门)');
  const reason = String(ev?.reason ?? '').trim() || '(未填原因)';
  const target = String(ev?.target ?? '').trim();
  const actor = String(ev?.actor ?? '').trim();
  return `⚠️ [bypass] 门「${gate}」已被强制绕过（已留痕）：原因=${reason}`
    + (actor ? ` · 调用方=${actor}` : '') + (target ? ` · 目标=${target}` : '');
}

/**
 * 这一行是不是"测试 / 夹具进程"写的（**只影响如何归类，不影响记不记**）。
 * 判据（宁宽勿窄，且按**子串**口径 —— junction 下逻辑路径与 realpath 两侧形态不同，路径前缀判据会静默失效）：
 *   ① argv 里出现 `\_test\` / `/_test/`（生态测试目录）；② 环境变量 `DSH_BYPASS_LEDGER_TAG=fixture` 显式标注。
 * ❗为什么需要它：接入后**任何**跑测试的进程都会走到放行分支（`test-production-guard.mjs` 实测踩到 ——
 *   它往生产台账写了 2 条）。治本是"测试隔离 env"，但那是**每个测试文件自觉**，迟早漏一个
 *   ⇒ 留一条兜底标注，让日报能把"测试写的"和"真绕过"分开显示（**不猜、不隐藏、如实分列**）。
 */
export function looksLikeTestProcess(argv = process.argv) {
  const s = Array.isArray(argv) ? argv.join(' ') : '';
  if (String(process.env.DSH_BYPASS_LEDGER_TAG ?? '').trim().toLowerCase() === 'fixture') return true;
  return s.includes('\\_test\\') || s.includes('/_test/');
}

/**
 * 记一条绕过。**fail-open**：任何失败都只提示、不抛、不阻断。
 * @param {{gate:string, reason?:string, actor?:string, session?:string, target?:string, detail?:object}} ev
 * @param {{file?:string, home?:string, silent?:boolean, argv?:string[], now?:number}} [opts]
 * @returns {{ok:boolean, file:string, at:string|null, bytes?:number, error?:string}}
 */
export function recordBypass(ev, opts = {}) {
  const file = bypassLedgerFile(opts);
  const at = new Date(Number.isFinite(opts.now) ? opts.now : Date.now()).toISOString();
  let out = { ok: false, file, at: null };
  try {
    const row = {
      at,
      gate: String(ev?.gate ?? 'unknown'),
      reason: String(ev?.reason ?? '').trim() || null,
      actor: ev?.actor ? String(ev.actor) : null,
      session: ev?.session ? String(ev.session) : (process.env.DSH_SESSION_ID ?? null),
      pid: process.pid,
      host: os.hostname(),
      target: ev?.target ? String(ev.target).slice(0, 400) : null,
      detail: ev?.detail && typeof ev.detail === 'object' ? ev.detail : null,
      ...(looksLikeTestProcess(opts.argv) ? { viaTest: true } : {}),
    };
    const line = JSON.stringify(row) + '\n';
    const dir = path.dirname(file);
    // ⚠️ 全程 try 包住：目录建不了 / 盘满 / 权限 / 路径是目录 …… 一律 fail-open。
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 目录可能已存在或不可建，append 会给出真因 */ }
    fs.appendFileSync(file, line, 'utf8');
    out = { ok: true, file, at, bytes: Buffer.byteLength(line, 'utf8') };
  } catch (e) {
    out = { ok: false, file, at: null, error: String(e?.code ?? e?.message ?? e) };
  }
  // 提示行：能出就出（提示本身也 fail-open —— 它写失败不影响主流程）。
  if (opts.silent !== true) {
    try {
      const msg = bypassNoticeLine(ev) + (out.ok
        ? `\n   留痕：${file}`
        : `\n   ⚠️ 留痕**失败**（fail-open，本次动作不受影响）：${out.error}`);
      const line = msg + '\n';
      if (jsonMode(opts.argv)) process.stderr.write(line);
      else process.stdout.write(line);
    } catch { /* 连提示都写不出就算了，绝不因此抛 */ }
  }
  return out;
}

/** 读台账（只读，容错：坏行跳过并在 `badLines` 里报数）。 */
export function readBypassLedger(opts = {}) {
  const file = bypassLedgerFile(opts);
  const res = { file, exists: false, rows: [], badLines: 0, error: null };
  try {
    const text = fs.readFileSync(file, 'utf8');
    res.exists = true;
    for (const ln of text.split(/\r?\n/)) {
      if (!ln.trim()) continue;
      try { res.rows.push(JSON.parse(ln)); } catch { res.badLines += 1; }
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') res.error = String(e?.code ?? e?.message ?? e);
  }
  return res;
}

/** 时间窗过滤（`days` 天前至今；`sinceMs` 显式覆盖）。坏 `at` 一律算"窗口内/外"由 `onBadAt` 决定（缺省丢）。 */
export function filterBypass(rows, { days = 7, now = Date.now(), gate = null, sinceMs = null } = {}) {
  const from = sinceMs ?? (now - days * 24 * 3600 * 1000);
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    if (gate && r?.gate !== gate) return false;
    const t = Date.parse(String(r?.at ?? ''));
    if (!Number.isFinite(t)) return false;
    return t >= from && t <= now;
  });
}

/** 聚合：总条数 + 各门条数 + 每门原因分布（降序）。 */
export function summarizeBypass(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byGate = new Map();
  const byReason = new Map();
  for (const r of list) {
    const g = String(r?.gate ?? 'unknown');
    if (!byGate.has(g)) byGate.set(g, { gate: g, count: 0, reasons: new Map(), lastAt: null });
    const e = byGate.get(g);
    e.count += 1;
    const rs = String(r?.reason ?? '').trim() || '(未填原因)';
    e.reasons.set(rs, (e.reasons.get(rs) ?? 0) + 1);
    const at = String(r?.at ?? '');
    if (!e.lastAt || at > e.lastAt) e.lastAt = at;
    byReason.set(rs, (byReason.get(rs) ?? 0) + 1);
  }
  const gates = [...byGate.values()]
    .map((e) => ({ gate: e.gate, count: e.count, lastAt: e.lastAt, reasons: [...e.reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count) }))
    .sort((a, b) => b.count - a.count);
  return {
    total: list.length,
    viaTest: list.filter((r) => r?.viaTest === true).length,
    gates,
    reasons: [...byReason.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  };
}

/**
 * 该门对应的**拦截数**来源（审计流水事件类型）。**没登记的门一律 null** —— 宁可不显示，不编数字。
 * ⚠️ 这是"拦了多少"的唯一真源映射；新增门要显示拦截数**必须**在这里加一行。
 *   🔴 加之前**先核实审计里真有该事件类型**（2026-10-16 实测 `~/.dsh/butler-audit/2026-10.jsonl`：
 *     `restart-request-rejected` = 2 条 ✓；`lock-takeover` = 14 条但它是**升级锁被接管**、不是"文件租约被拒改"
 *     ⇒ 本鱼初版把 file-lease 错映射到它，已改回 null —— 这就是本节"宁可不显示，不编数字"的由来）。
 */
export const GATE_DENY_AUDIT_TYPE = {
  'restart-force': 'restart-request-rejected',   // 重启请求被交接窗口/裸跑期闸门拒掉（审计流水真有该类型）
  'force-collect': null,                         // 强推审计在 handoff 自己的告警里，无独立事件类型 ⇒ 如实 null
  'file-lease-takeover': null,                   // 拒改数在 file-lease 自家 counters.rejected，不在审计流水
  'allow-production': null,                      // 共享件不产生"拦截"事件（它本身就是放行记录）
  'allow-reparse': null,
  'scan-degrade': null,
  'env-destructive-guard': null,
};

/**
 * "拦了多少"的取数：按**审计流水事件类型**数（近 `days` 天）。**只读**，容错（读不到当 0）。
 * 为什么走审计：门"拦住"的动作原本就落审计（如 `restart-request-rejected`），不必另建计数器
 *   （另建 = 又一个"只增不减的控制项"，正是 R-067 要治的病）。
 * ⚠️ 只数 `GATE_DENY_AUDIT_TYPE` 里**非 null** 的类型；没登记的门一律不计（宁缺勿编）。
 * @returns {{[type:string]: number}}
 */
export function auditTypeCounts({ home, days = 7, now = Date.now(), types = null } = {}) {
  const want = new Set(
    (Array.isArray(types) ? types : Object.values(GATE_DENY_AUDIT_TYPE).filter(Boolean)),
  );
  const counts = {};
  for (const t of want) counts[t] = 0;
  if (!want.size) return counts;
  const dir = path.join(resolveDshHome(home), 'butler-audit');
  const from = now - days * 24 * 3600 * 1000;
  const monthFile = (ms) => {
    const d = new Date(ms);
    return path.join(dir, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`);
  };
  // 近 N 天可能跨月 ⇒ 本月 + 上个月两份都读（再多读一份纯属浪费，窗口只有 7 天）。
  for (const f of [monthFile(now), monthFile(now - 32 * 24 * 3600 * 1000)]) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const ln of text.split(/\r?\n/)) {
      if (!ln.trim()) continue;
      let hit = false;
      for (const t of want) if (ln.includes(`"${t}"`)) { hit = true; break; }
      if (!hit) continue;                       // 先做廉价子串过滤：6 MB 流水逐行 JSON.parse 太慢
      let r = null;
      try { r = JSON.parse(ln); } catch { continue; }
      const t = r?.type;
      if (!want.has(t)) continue;
      const at = Date.parse(String(r?.at ?? ''));
      if (!Number.isFinite(at) || at < from || at > now) continue;
      counts[t] += 1;
    }
  }
  return counts;
}

/**
 * 日报段渲染（**只读**，纯函数 + 一次 readFileSync）。
 * 返回 Markdown 行数组；调用方（`report.mjs`）只 push 它给的行，**不复制任何统计**。
 * @param {{days?:number, now?:number, file?:string, home?:string, auditRows?:Array, audit?:boolean}} [opts]
 *   `auditRows`（形如 `[{type}]`）或 `audit:true`（缺省，自己读审计流水）⇒ "拦截次数"列有值；
 *   两者都不给（`audit:false`）⇒ 该列显示 `—`（不编数字）。
 */
export function bypassSectionLines(opts = {}) {
  const days = Number.isFinite(opts.days) ? opts.days : 7;
  const nowMs = opts.now ?? Date.now();
  const L = [];
  const read = readBypassLedger(opts);
  if (read.error) return [`_（绕过台账读不了：${read.error} —— fail-open，不影响日报其余段）_`];
  const rows = filterBypass(read.rows, { days, now: nowMs });
  const sum = summarizeBypass(rows);
  L.push(`> 口径：**绕过 = 门判定为"拦"但被显式放行开关强制通过**。台账文件 \`${read.file}\`（append-only · fail-open · 本段只读）。`);
  if (!read.exists) {
    L.push('');
    L.push(`- 台账尚未建立（**没有任何门被绕过**，或本卡落地后台账还没写过一行）—— 这里显示 0 不是"数据缺失"。`);
    return L;
  }
  // "拦了多少"：缺省自己读审计流水按事件类型数（只读、容错）；失败就退回 `—`（不编数字）。
  let denyCounts = null;
  if (opts.audit !== false) {
    try {
      if (Array.isArray(opts.auditRows)) {
        denyCounts = {};
        for (const r of opts.auditRows) if (r?.type) denyCounts[r.type] = (denyCounts[r.type] ?? 0) + 1;
      } else {
        denyCounts = auditTypeCounts({ home: opts.home, days, now: nowMs });
      }
    } catch { denyCounts = null; }
  }
  L.push('');
  L.push(`- 近 ${days} 天绕过合计：**${sum.total}** 次 · 涉及门 **${sum.gates.length}** 个`
    + (sum.viaTest ? ` · 其中 **${sum.viaTest}** 条来自测试/夹具进程（\`_test\` 路径或 \`DSH_BYPASS_LEDGER_TAG=fixture\`）—— 归类标注，不是隐藏` : ''));
  if (sum.total === 0) {
    L.push(`- 各门：近 ${days} 天**零绕过** ✓`);
  } else {
    const denyOf = (gate) => {
      const t = GATE_DENY_AUDIT_TYPE[gate];
      if (!t || !denyCounts) return '—';
      return String(denyCounts[t] ?? 0);
    };
    L.push('');
    L.push('| 门 | 绕过次数 | 拦截次数 | 最近一次 | 原因分布 |');
    L.push('|---|---:|---:|---|---|');
    for (const g of sum.gates) {
      const label = GATE_LABELS[g.gate] ?? g.gate;
      const reasons = g.reasons.map((r) => `${r.reason}×${r.count}`).join('；');
      L.push(`| \`${g.gate}\` ${label} | ${g.count} | ${denyOf(g.gate)} | ${g.lastAt ?? '—'} | ${reasons || '—'} |`);
    }
    if (!denyCounts) {
      L.push('');
      L.push(`_（"拦截次数"列显示 \`—\`：本段**没拿到审计流水**。门被拦次数目前只有审计流水一个来源，**没登记的门一律不显示** —— 宁可不显示，不编数字。）_`);
    }
  }
  return L;
}
