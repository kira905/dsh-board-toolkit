// dsh-butler / lib/watch-events.mjs —— P2「会盯人」事件判定层（纯函数，fixture 可驱动）
//
// 方案：docs\大管家v2方案-从只读到真管家-20260909.md §4 P2（行 477-554）
// 职责边界（重要）：
//   本模块只做「当前状态 → 事件」的判定，**不碰时间窗口 / 冷却 / 上限 / 免打扰**（那是
//   watch-policy.mjs 的状态机），也不碰 IO（那是 watch-collect.mjs）。
//   判定函数签名 judge(snapshot, opts) → null | { value, detail, evidence, level?, deliverable? }
//     - 返回 null = 当前不在异常态
//     - value = 可比较的稳定状态串（policy 用它做「只报状态变化」与冷却去重）
//     - level/deliverable 可被判定覆盖（如会话损坏：无 corrupt → 🟡，有 corrupt → 🔴）
//
// 17 类事件（主表 6 + 扩面 4 + 学习项 6 + 自愈 1）+ 1 类信息项（开工预检 ⬜，只进日报不进告警）。
//   ⚠️ 变更记录：2026-09-21 新增第 17 类 `repair-linger`（修复分身僵留），来源 = 方案
//   `docs\自愈-分身收尾与僵留治理-方案-2026-09-21.md` §3.1 B1 案（主人 17:14 拍板 D-2 放行、D-12 定 T=15 分钟）。
// 反面教材（2026-09-09 实测）：ledger.scheduler.error 常驻旧错
// （"corrupt ledger was quarantined"），报错必须看时间戳新旧 —— 见 judgeSchedulerError。

export const WATCH_EVENTS_VERSION = '0.1.1';

export const LEVEL = { RED: 'red', YELLOW: 'yellow' };
export const DELIVER = { IMMEDIATE: 'immediate', DEFERRABLE: 'deferrable' };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const ts = (v) => (num(v) === null ? '?' : new Date(num(v)).toISOString().replace('T', ' ').slice(0, 19));
const setValue = (arr) => [...new Set(arr.map(String))].sort().join('|');
const cap = (arr, n) => arr.slice(0, n);

// ------------------------------------------------------------------ 计划任务结果码语义
//
// schtasks 的 Last Result 是 **HRESULT**，不是普通退出码：0x4130x 段全是 SCHED_S_* 成功/信息码。
// 2026-09-10 实测误报（来源卡 836a94a8）：主机 A 新注册 4 个 Butler 计划任务后，首 tick 把
// 267011（SCHED_S_TASK_HAS_NOT_RUN ＝从未运行）当「结果码非 0」→ 推了一条 🔴（跑过一次即自愈）。
// 换机 / 新注册任务 / 恢复脚本重建任务后必然复现，污染裸跑期误报率样本。
// 码表（taskschd.h）：
//   0      ─        S_OK / SCHED_S_TASK_SUCCESS      运行成功        → 放行
//   267008 0x41300  SCHED_S_TASK_READY               已就绪待跑      → 放行
//   267009 0x41301  SCHED_S_TASK_RUNNING             正在运行        → 放行
//   267010 0x41302  SCHED_S_TASK_DISABLED            任务被禁用      → 报（真异常，别一起放行）
//   267011 0x41303  SCHED_S_TASK_HAS_NOT_RUN         从未运行过      → 放行（新注册常态）
//   267012 0x41304  NO_MORE_RUNS / 267013 0x41305 NOT_SCHEDULED /
//   267014 0x41306  TERMINATED（上次被强制终止）/ 267015 0x41307 NO_VALID_TRIGGERS
//                                                    → 一律**保留会报**（可疑/异常，静默不划算）
export const TASK_RESULT_BENIGN = Object.freeze(new Set([0, 267008, 267009, 267011]));

/** 结果码是否算失败（非 0 且不在放行表内）；null/空 = 不可知，不报。 */
export function isTaskResultFailure(v) {
  const n = num(v);
  if (n === null) return false;
  return !TASK_RESULT_BENIGN.has(n);
}

/** 任务是否被禁用（schtasks Status 字段；中文控制台下为「已禁用」）。 */
export function isTaskDisabled(status) {
  const s = String(status ?? '').trim();
  if (!s) return false;
  return /^disabled$/i.test(s) || /禁用|停用/.test(s);
}

/** 时间戳是否「新鲜」（相对给定周期；旧错残留不报）。 */
export function isFresh(at, intervalMs, now = Date.now(), floorMs = 6 * HOUR_MS) {
  const t = num(at);
  if (t === null) return false;
  const window = Math.max(num(intervalMs) ?? 0, 0) * 2 || floorMs;
  return now - t <= Math.max(window, floorMs);
}

/** 免打扰时段判定（跨午夜安全）。 */
export function inQuietHours(now, quiet = { startHour: 23, endHour: 7 }) {
  const h = new Date(now).getHours();
  const { startHour: s, endHour: e } = quiet;
  if (s === e) return false;
  return s < e ? (h >= s && h < e) : (h >= s || h < e);
}

// ---------------------------------------------------------- 修复分身僵留（B1 · 第 17 类）
//
// 来源：`docs\自愈-分身收尾与僵留治理-方案-2026-09-21.md` §3.1（B1 案 · 只报警不动手）；
//   主人 2026-09-21 17:14 拍板 D-2「放行」+ D-12「判据 = 报告落盘后 T 分钟仍未收尾，T=15 分钟」。
//
// ⚠️ 判据为什么不是"分身活过 N 分钟"（v1 口径已被审核判不合格，2026-09-21）：
//   `repair.mjs:522` 的设计意图**就是"跑完挂起等验收"** ⇒ 分身挂着是**常态**；按"活过 N 分钟"
//   每次真故障（主人不在场时）都必然报一次 ⇒ 报警失去"异常"含义、把真异常淹没。
//   ⇒ 只有「**报告已落盘** + 过了 T 仍没人收」才是异常：报告没落盘＝分身还在干活（活干到一半就报＝误报）。
//
// ⚠️ 时间比较**只用 epoch**（报告 `mtimeMs` / `Date.parse(ISO)` vs `Date.now()`）：
//   报告**文件名是本地时间**（`repair.mjs:71-74` `tsFile()`）、而 ready/wake/guard 状态字段是 UTC ⇒
//   **禁止解析文件名里的时间戳**（差 8 小时 ⇒ 判据恒假，第 1 轮审核 E11 已证伪该做法）。

/** 静默期/僵留阈值 T（D-12 决议值 15 分钟；覆盖只走 CLI —— `dsh-butler-watch.mjs --repair-linger-min N`）。 */
export const REPAIR_LINGER_DEFAULT_MS = 15 * 60_000;
/** 事件 id（日报段 / 单测 / 面板共用）。 */
export const REPAIR_LINGER_EVENT_ID = 'repair-linger';

const maxEpoch = (...vals) => {
  const xs = vals.map(num).filter((v) => v !== null);
  return xs.length ? Math.max(...xs) : null;
};

/**
 * 挂起锁是否「生效中」（方案 §2.1 判据 4 / E-9）。
 * ⚠️ 缺 `expiresAt`（老 schema / 解析失败）一律**按有效锁**处理：B1 只报警，保守方向 = 不打扰
 *    （方案定稿要求锁必须带 TTL，否则"忘删锁 = 永久不收官"；此处的保守只是"宁可不报"）。
 * @param {{exists?:boolean, expiresAtMs?:number|null}|null} hold
 */
export function isRepairHoldActive(hold, now = Date.now()) {
  if (!hold || hold.exists !== true) return false;
  const exp = num(hold.expiresAtMs);
  if (exp === null) return true;
  return exp > now;
}

/**
 * 「修复分身僵留」状态求值 —— **唯一判据处**（纯函数；B1 报警、将来 B2 自动收尾、日报段渲染**都调它**，
 *   防两处判定打架 R-B1-3 / 日报不许复制判定）。
 *
 * 输入 `s.repair`（形状由采集层 `dsh-butler-watch.mjs#collectRepairState` 产出）：
 *   `{ ok, count, pids[], reportFile, reportMtimeMs, readyAtMs, wakeAtMs, hold:{exists,expiresAtMs}, stateDir, reportDir, error }`
 *
 * `state` 取值即结论（只有 `fired` / `undetectable` 会变成事件）：
 *   `not-wired`    快照里没有 repair 字段（老 fixture / 非本机事件源）⇒ 不报
 *   `undetectable` 扫描不可用（`ok !== true`）⇒ **报「不可探测」**（不许静默当 0：判据建立在"有没有分身"上）
 *   `no-agent`     `count === 0` ⇒ 不报（没有分身 = 常态）
 *   `no-report`    本轮报告未落盘 ⇒ 不报（分身还在干活；v1 的"活过 N 分钟"口径已被审核判不合格）
 *   `stale-report` 最新报告早于本轮基线 `max(readyAt, wakeAt)` ⇒ 不报（上一轮的陈旧报告，审核重要-3 的反例）
 *   `quiet`        报告落盘未满 T（默认 15 分钟）⇒ 不报（留给主人的验收窗口 = 预期行为）
 *   `hold`         未过期挂起锁生效中 ⇒ 不报（"主人在等/在处理"，E-9；该状态由日报段显式可见）
 *   `fired`        以上都不命中 ⇒ 报（🟡 ⇒ 按 P2 策略只进日报；日报段才是本事件的可用性保证 R-B1-4）
 *
 * @param {object} s 快照（`now` 缺省取 `Date.now()`）
 * @param {{now?:number, repairLingerMs?:number}} [opts]
 * @returns {{state:string, reason:string, fired:boolean, now:number, thresholdMs:number, count:number,
 *            pids:string[], reportFile:?string, reportMtimeMs:?number, baselineMs:?number, ageMs:?number,
 *            holdActive:boolean, hold:object|null, error:?string, repair:object|null}}
 */
export function evaluateRepairLinger(s, opts = {}) {
  const now = num(opts.now) ?? num(s?.now) ?? Date.now();
  const r = s?.repair;
  const thresholdMs = num(opts.repairLingerMs) ?? REPAIR_LINGER_DEFAULT_MS;
  const base = {
    state: 'not-wired', reason: '快照未接线（没有 repair 采集字段）', fired: false,
    now, thresholdMs, count: 0, pids: [], reportFile: null, reportMtimeMs: null,
    baselineMs: null, ageMs: null, holdActive: false, hold: null, error: null, repair: r ?? null,
  };
  if (!r || typeof r !== 'object') return base;                      // ① 未接线

  const count = num(r.count) ?? 0;
  const pids = (r.pids ?? []).map(String);
  const reportMtimeMs = num(r.reportMtimeMs);
  const baselineMs = maxEpoch(r.readyAtMs, r.wakeAtMs);              // 本轮基线（审核重要-3 的反例修正）
  const holdActive = isRepairHoldActive(r.hold, now);
  const v = {
    ...base, count, pids, reportFile: r.reportFile ?? null, reportMtimeMs,
    baselineMs, holdActive, hold: r.hold ?? null,
  };

  if (r.ok !== true) {                                               // ② 不可探测（显式报，不许当 0）
    return { ...v, state: 'undetectable', fired: true, error: r.error ?? null, reason: `分身进程扫描不可用（不可探测）：${r.error ?? '未知原因'}` };
  }
  if (count === 0) return { ...v, state: 'no-agent', reason: '无分身进程（常态）' };
  if (reportMtimeMs === null) return { ...v, state: 'no-report', reason: '本轮报告尚未落盘（分身还在干活，不报）' };
  if (baselineMs !== null && reportMtimeMs <= baselineMs) {
    return { ...v, state: 'stale-report', reason: '最新报告早于本轮基线（是上一轮的陈旧报告，不报）' };
  }
  const ageMs = now - reportMtimeMs;
  const v2 = { ...v, ageMs };
  if (ageMs <= thresholdMs) {
    return { ...v2, state: 'quiet', reason: `报告落盘 ${Math.round(ageMs / 60_000)} 分钟，未满静默期 ${Math.round(thresholdMs / 60_000)} 分钟` };
  }
  if (holdActive) return { ...v2, state: 'hold', reason: '挂起锁生效中（你在等/在处理）⇒ 按"不是异常"处理' };
  return { ...v2, state: 'fired', fired: true, reason: `报告已落盘 ${Math.round(ageMs / 60_000)} 分钟（> ${Math.round(thresholdMs / 60_000)} 分钟）仍未见收尾` };
}

/**
 * 事件判定（P2 事件表用）：把 `evaluateRepairLinger` 的结论翻成事件对象 / null。
 * @returns {null|{value:string, detail:string, evidence:object}} null = 当前不在异常态
 */
export function judgeRepairLinger(s, opts = {}) {
  const v = evaluateRepairLinger(s, opts);
  if (v.state === 'undetectable') {
    return {
      value: 'undetectable',
      detail: `${v.reason} —— 这不等于「没有僵留分身」，可手工核对 node <workspace>/repair-ctl.mjs status`,
      evidence: { ok: false, error: v.error, probe: v.repair?.probe ?? null },
    };
  }
  if (v.state !== 'fired') return null;
  return {
    value: `${setValue(v.pids)}@${v.reportMtimeMs}`,
    detail: `修复分身 ${v.count} 个（PID ${cap(v.pids, 3).join('、') || '?'}）跑完未收尾：本轮报告已落盘 ${Math.round(v.ageMs / 60_000)} 分钟（> ${Math.round(v.thresholdMs / 60_000)} 分钟）—— 验收完成后执行 node <workspace>/repair-ctl.mjs finish（连做两下：先收分身、再清标记）`,
    evidence: {
      count: v.count, pids: cap(v.pids, 10), reportFile: v.reportFile, reportMtimeMs: v.reportMtimeMs,
      readyAtMs: num(v.repair?.readyAtMs), wakeAtMs: num(v.repair?.wakeAtMs), baselineMs: v.baselineMs,
      holdActive: v.holdActive, thresholdMs: v.thresholdMs, ageMs: v.ageMs,
      stateDir: v.repair?.stateDir ?? null, reportDir: v.repair?.reportDir ?? null,
    },
  };
}

/** 本地时间短格式（**只做展示**；判据一律用 epoch，见 §1.7.3 时区坑）。 */
const tsLocal = (v) => {
  const t = num(v);
  if (t === null) return '?';
  try { return new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return ts(t); }
};

/**
 * 日报段渲染（B1）—— **只渲染、不判定**：判定仍走 `evaluateRepairLinger`（同一份纯函数，日报不许复制判据）。
 *
 * 为什么必须固定进日报段（方案 R-B1-4 / 第 1 轮审核重要-6）：`lib/watch-policy.mjs` 的 `dailyCap: 10` 是
 *   **全局**每日推送上限 ⇒ 配额用满时本事件会静默降级为"只落报告"，而它本身是 🟡（P2 口径「🔴 推 / 🟡 进日报」）
 *   ⇒ **日报段是本事件唯一的可用性保证**；故本段不依赖任何配额，并把"今日推了几条 / 只落报告几条"写进可见行。
 *
 * @param {object} repair `dsh-butler-watch.collectRepairState()` 的输出
 * @param {{now?:number, repairLingerMs?:number, channel?:object|null}} [opts]
 *   · `channel` = P2 state 的只读摘录 `{pushed, reportOnly, cap, todayPush, todayReport, lastNotifyAt, ackedAt, ackToken}`（由调用方读盘后传入，本函数不碰 IO）
 * @returns {string[]} markdown 行（含段标题；调用方直接 push 进日报）
 */
export function repairSectionLines(repair, opts = {}) {
  const now = num(opts.now) ?? Date.now();
  const v = evaluateRepairLinger({ now, repair }, { now, repairLingerMs: opts.repairLingerMs });
  const r = v.repair ?? {};
  const hold = r.hold ?? {};
  const ch = opts.channel ?? null;
  const lines = ['## 🩺 修复分身与僵留（B1 · 只报警）', ''];

  if (v.state === 'not-wired') {
    lines.push('- ❔ **未接线**：本次快照没有 repair 采集字段（非本机事件源）—— 这不等于「没有僵留分身」');
    return lines;
  }

  const reportTxt = num(r.reportMtimeMs) === null
    ? '未落盘'
    : `${String(r.reportFile ?? '?').split(/[\\/]/).pop()}（落盘 ${tsLocal(r.reportMtimeMs)}）`;
  const holdTxt = !hold.exists
    ? '无'
    : (num(hold.expiresAtMs) === null
      ? '存在（无 TTL ⇒ 保守按有效锁、不报）'
      : `生效中（至 ${tsLocal(hold.expiresAtMs)}${hold.by ? ` · by ${hold.by}` : ''}）`);
  lines.push(`- 分身进程：**${r.count ?? 0}** 个${(r.pids ?? []).length ? `（PID ${(r.pids ?? []).slice(0, 3).join('、')}）` : ''}${r.ok ? '' : ' ⚠️ **不可探测**'} · 本轮报告：${reportTxt} · 挂起锁：${holdTxt}`);

  const mark = v.state === 'fired'
    ? '⚠️ **命中僵留**（🟡 · P2 口径「🔴 推 / 🟡 进日报」⇒ 只进本段、不走推送）'
    : (v.state === 'undetectable' ? '❔ **不可探测**' : '✅ 无僵留');
  lines.push(`- 判定（唯一判据源 \`lib/watch-events.evaluateRepairLinger\` · 阈值 T=${Math.round(v.thresholdMs / 60_000)} 分钟 · 口径=报告落盘后未满 T 不报）：${mark} —— ${v.reason}`);
  if (v.state === 'fired') {
    lines.push('- 收尾（人工；B1 只报警、不动手）：`node <workspace>/repair-ctl.mjs finish` **连做两下**（第一下收分身、第二下清标记）；只想看现场先别收 ⇒ `node <workspace>/repair-ctl.mjs hold --minutes 120 --reason "..."`（放锁生效期间本事件不报）');
  }
  lines.push(ch
    ? `- 通道：今日推送 **${ch.pushed ?? 0}/${ch.cap ?? 10}** · 只落报告 **${ch.reportOnly ?? 0}** ｜本事件今日：推 ${ch.todayPush ?? 0} / 报告 ${ch.todayReport ?? 0}${num(ch.lastNotifyAt) === null ? '' : ` · 最近推送 ${tsLocal(ch.lastNotifyAt)}${num(ch.ackedAt) !== null && num(ch.ackedAt) >= num(ch.lastNotifyAt) ? '（已确认）' : `（未确认${ch.ackToken ? ` · ack ${ch.ackToken}` : ''}）`}`} —— 配额用满时本事件只落报告，**本段不依赖推送通道**`
    : '- 通道：❔ 读不到 `butler-watch-state.json`（P2 状态不可探测）—— 这不等于「今天没告警」');
  return lines;
}

// ------------------------------------------------------------------ 17 类事件定义

export const EVENT_SPECS = [
  // ── 主表 6 ────────────────────────────────────────────────────────
  {
    id: 'archive-error', title: '自动归档出错', level: LEVEL.RED, deliverable: DELIVER.DEFERRABLE,
    category: 'archive', dataSource: 'archive',
    judge: (s) => {
      const a = s.archive;
      if (!a || !a.ok || !a.lastResult) return null;
      // ⚠️ `errors` 是**对象数组**（插件写 `errors: [{sessionId,error}]`；见
      //    tools\dsh-archive-sessions\lib\index.js:992 `errors: []` / :1104 `errors.push(...)`）。
      //    旧实现直接 `num(...)`：`Number([{...}])` = NaN ⇒ null ⇒ **事件永不触发**（红灯通道静默；
      //    空数组因 `Number([]) === 0` 恰好不报，**非空数组**才是漏报形态。2026-09-23 小修·7 修）。
      //    现读法：数组取 `length`、数字原样兼容（历史/手工扁平形态写数字）；空数组 = 0 = 不报。
      const rawErrors = a.lastResult.errors;
      const isArrErrors = Array.isArray(rawErrors);
      const errors = isArrErrors ? rawErrors.length : num(rawErrors);
      if (errors === null || errors <= 0) return null;
      if (!isFresh(a.lastRunAt, a.intervalMs, s.now)) return null; // 旧错残留：不报
      return {
        value: `errors=${errors}@${a.lastRunAt}`,
        detail: `自动归档上次运行（${ts(a.lastRunAt)}）有 ${errors} 个错误`,
        evidence: { errors, errorsShape: isArrErrors ? 'array' : typeof rawErrors, lastRunAt: a.lastRunAt, file: a.file ?? null },
      };
    },
  },
  {
    id: 'archive-stalled', title: '归档定时器停摆', level: LEVEL.YELLOW, deliverable: DELIVER.IMMEDIATE,
    category: 'archive', dataSource: 'archive',
    judge: (s) => {
      const a = s.archive;
      if (!a || !a.ok || a.enabled !== true) return null;
      const interval = num(a.intervalMs) ?? 6 * HOUR_MS;
      const last = num(a.lastRunAt);
      if (last === null) return null;
      if (s.now - last <= interval * 2) return null;
      return {
        value: `stalled@${last}`,
        detail: `归档上次运行 ${ts(last)}，已超过 2×间隔（${Math.round(interval / HOUR_MS)}h）`,
        evidence: { lastRunAt: last, intervalMs: interval },
      };
    },
  },
  // 【2026-09-28 · M2 归档元数据库】写库失败的可见性（方案 §4.2-③ 通道② / §7-⑤ 四段式告警）
  {
    id: 'archive-meta-write-failed', title: '归档元数据库写失败', level: LEVEL.YELLOW, deliverable: DELIVER.DEFERRABLE,
    category: 'archive', dataSource: 'archive',
    judge: (s) => {
      const a = s.archive;
      if (!a || !a.ok) return null;
      const m = a.metaStore;
      if (!m) return null;
      // 判据 = `state.metaStore.writeFailedStreak ≥ 2`（**不再**依赖"连续两次"的空想载体：计数器是持久的）
      const streak = num(m.writeFailedStreak) ?? 0;
      if (streak < 2) return null;
      return {
        value: `writeFailedStreak=${streak}`,
        detail: `归档元数据库（加速缓存）连续 ${streak} 次写入失败（累计 ${m.writeFailedTotal ?? 0} 次）。` +
          '影响：面板元数据将回落到 projcache/日志，两者皆失则显示"（无标题）"。' +
          '处置：查 `.bak` 与磁盘权限；**不要**重跑归档（会话已搬走，重跑＝空转再报错）。',
        evidence: {
          writeFailedStreak: streak, writeFailedTotal: m.writeFailedTotal ?? 0,
          lastWriteError: m.lastWriteError ?? null, file: a.file ?? null,
        },
      };
    },
  },
  {
    id: 'archive-meta-corrupted', title: '归档元数据库损坏', level: LEVEL.RED, deliverable: DELIVER.IMMEDIATE,
    category: 'archive', dataSource: 'archive',
    judge: (s) => {
      const a = s.archive;
      if (!a || !a.ok) return null;
      const st = a.metaStoreState;
      if (!st || st.state !== 'corrupted') return null;
      return {
        value: `corrupted${st.reason ? '@' + st.reason : ''}`,
        detail: '归档元数据库损坏：写侧已 fail-closed（**删除已暂停**、惰性补写与回填一律禁写，等 `.bak` 恢复）。' +
          '处置：查 `.bak` 与磁盘权限；**不要重跑回填/归档**（把损坏当空库覆盖＝9/17 事故的重演动作）。',
        evidence: { metaStoreState: 'corrupted', reason: st.reason ?? null, file: st.file ?? null },
      };
    },
  },
  {
    id: 'upgrade-new-red', title: '升级体检新增 🔴', level: LEVEL.YELLOW, deliverable: DELIVER.IMMEDIATE,
    category: 'upgrade', dataSource: 'upgrade', worseWhen: 'increase',
    judge: (s) => {
      const u = s.upgrade;
      if (!u || !u.ok) return null;
      const reds = (u.red ?? []).map(String).sort();
      if (!reds.length) return null;
      return {
        value: setValue(reds),
        detail: `升级体检 🔴 ${reds.length} 项：${cap(reds, 5).join(', ')}（数据源 ${u.dataSource ?? '?'}）`,
        evidence: { red: cap(reds, 10), dataSource: u.dataSource ?? null },
      };
    },
  },
  {
    id: 'task-failed', title: '看板卡失败', level: LEVEL.RED, deliverable: DELIVER.IMMEDIATE,
    category: 'board', dataSource: 'ledger',
    judge: (s) => {
      const l = s.ledger;
      if (!l || !l.ok) return null;
      const failed = (l.tasks ?? []).filter((t) => t && t.status === 'failed');
      if (!failed.length) return null;
      return {
        value: setValue(failed.map((t) => t.id)),
        detail: `看板失败卡 ${failed.length} 张：${cap(failed.map((t) => `「${t.title ?? t.id}」`), 3).join('、')}`,
        evidence: { cards: cap(failed.map((t) => ({ id: t.id, title: t.title ?? null, updatedAt: num(t.updatedAt) })), 10) },
      };
    },
  },
  {
    id: 'task-overdue', title: '挂起任务超时', level: LEVEL.YELLOW, deliverable: DELIVER.IMMEDIATE,
    category: 'board', dataSource: 'ledger',
    judge: (s, opts = {}) => {
      const l = s.ledger;
      if (!l || !l.ok) return null;
      const limit = num(opts.overdueMs) ?? 3 * DAY_MS;
      const overdue = (l.tasks ?? []).filter((t) => t && (t.status === 'todo' || t.status === 'backlog')
        && num(t.updatedAt) !== null && s.now - num(t.updatedAt) > limit);
      if (!overdue.length) return null;
      return {
        value: setValue(overdue.map((t) => t.id)),
        detail: `${overdue.length} 张卡超 3 天没动：${cap(overdue.map((t) => `「${t.title ?? t.id}」`), 3).join('、')}`,
        evidence: { cards: cap(overdue.map((t) => ({ id: t.id, title: t.title ?? null, updatedAt: num(t.updatedAt) })), 10) },
      };
    },
  },
  {
    id: 'interrupt-backlog', title: '会话中断堆积', level: LEVEL.YELLOW, deliverable: DELIVER.IMMEDIATE,
    category: 'session', dataSource: 'sessions',
    judge: (s, opts = {}) => {
      const sess = s.sessions;
      if (!sess || !sess.ok) return null;
      const n = num(sess.interruptedCount);
      const limit = num(opts.interruptThreshold) ?? 5;
      if (n === null || n <= limit) return null;
      return {
        value: `interrupted=${n}`,
        detail: `被打断会话 ${n} 个（阈值 ${limit}）`,
        evidence: { interruptedCount: n, threshold: limit, ids: cap(sess.interruptedIds ?? [], 10) },
      };
    },
  },

  // ── 扩面 4（开工预检 ⬜ 不在此表，见 buildPreflight）────────────────
  {
    id: 'task-result', title: '计划任务异常（结果码/被禁用）', level: LEVEL.RED, deliverable: DELIVER.IMMEDIATE,
    category: 'infra', dataSource: 'schedules',
    // 判定（2026-09-10 修正，来源卡 836a94a8）：
    //   ① 只有「真失败码」才报 —— 0 / 267008 / 267009 / 267011 是成功/信息码，见 TASK_RESULT_BENIGN
    //   ② 「任务被禁用」单独判：否则刚注册就被禁用的任务 LR 停在 267011，会被 ① 一起静默掉
    //      （计划任务悄悄死掉没人知道 —— 这是主人点名要保留的真异常）
    judge: (s) => {
      const sch = s.schedules;
      if (!sch || !sch.ok) return null;
      const bad = [];
      for (const t of sch.tasks ?? []) {
        if (!t || !t.exists) continue;
        if (isTaskDisabled(t.status) || isTaskDisabled(t.state)) bad.push({ t, label: '已禁用', reason: 'disabled' });
        else if (isTaskResultFailure(t.lastResult)) bad.push({ t, label: String(t.lastResult), reason: 'result' });
      }
      if (!bad.length) return null;
      return {
        value: setValue(bad.map((x) => `${x.t.name}:${x.label}`)),
        detail: `计划任务异常：${cap(bad.map((x) => `${x.t.name}=${x.label}`), 5).join('、')}`,
        evidence: {
          tasks: cap(bad.map((x) => ({
            name: x.t.name, reason: x.reason, lastResult: num(x.t.lastResult),
            status: x.t.status ?? null, state: x.t.state ?? null, lastRunAt: num(x.t.lastRunAt),
          })), 10),
        },
      };
    },
  },
  {
    id: 'guard-unhealthy', title: '守护鱼/dsh 存活异常', level: LEVEL.RED, deliverable: DELIVER.IMMEDIATE,
    category: 'infra', dataSource: 'guard',
    // 判据设计（2026-09-09 实测校准）：
    //   · guard-state.json 的 updatedAt 只在状态变化时写，WATCH 静默期不更新
    //     → 心跳年龄**不能**当故障判据（实测 16 分钟没变仍正常），只看进程/端口/日志活跃度
    //   · 守护鱼与 dsh 都不在 = 主人主动停机（不推送，只落报告）
    //   · 守护鱼在但 dsh 未监听 = 正在拉起（downSince 宽限期内不报），超时才报
    judge: (s, opts = {}) => {
      const g = s.guard;
      if (!g || !g.ok) return null;
      const count = num(g.processCount);
      const guardAlive = count !== null && count >= 1;
      const dshUp = g.port3080 === true;
      const evidence = {
        processCount: count, port3080: g.port3080, phase: g.phase ?? null,
        heartbeatAgeMs: num(g.heartbeatAgeMs), logAgeMs: num(g.logAgeMs),
        downSince: num(g.downSince), downCount: num(g.downCount), pids: cap(g.pids ?? [], 10),
      };
      if (!guardAlive && !dshUp) {
        return {
          value: 'stopped', level: LEVEL.YELLOW, deliverable: DELIVER.IMMEDIATE,
          detail: '守护鱼与 dsh 都未运行（疑似主人主动停机，只落报告不推送）',
          evidence,
        };
      }
      const problems = [];
      if (guardAlive && !dshUp) {
        const downSince = num(g.downSince);
        const graceMs = num(opts.guardDownGraceMs) ?? 5 * 60_000;
        const restarting = downSince !== null && s.now - downSince < graceMs;
        const logAgeMs = num(g.logAgeMs);
        const logStuck = logAgeMs !== null && logAgeMs > (num(opts.guardLogStuckMs) ?? 10 * 60_000);
        if (restarting && !logStuck) return null; // 正在拉起，正常
        problems.push(restarting
          ? `dsh 未监听且守护鱼日志 ${Math.round((logAgeMs ?? 0) / 60_000)} 分钟无动作（疑似卡死）`
          : `dsh 未监听（守护鱼在，downSince=${ts(downSince)}）`);
      }
      if (!guardAlive && dshUp) problems.push('守护鱼进程不在（dsh 在跑，已失去自愈能力）');
      if (guardAlive && count !== null && count !== 1) problems.push(`守护鱼进程数=${count}（应为 1，双守护鱼会互相误杀）`);
      if (!problems.length) return null;
      return {
        value: problems.join('|'),
        detail: problems.join('；'),
        evidence,
      };
    },
  },
  {
    id: 'session-corrupt', title: '会话文件健康异常', level: LEVEL.YELLOW, deliverable: DELIVER.IMMEDIATE,
    category: 'session', dataSource: 'sessionHealth',
    judge: (s) => {
      const h = s.sessionHealth;
      if (!h || !h.ok) return null;
      const corrupt = h.corrupt ?? [];
      const warn = h.warn ?? [];
      if (!corrupt.length && !warn.length) return null;
      const hard = corrupt.length > 0;
      return {
        value: setValue([...corrupt.map((x) => `${x.sessionId}:corrupt`), ...warn.map((x) => `${x.sessionId}:warn`)]),
        level: hard ? LEVEL.RED : LEVEL.YELLOW,
        deliverable: hard ? DELIVER.DEFERRABLE : DELIVER.IMMEDIATE, // 损坏=数据丢失类，穿透免打扰
        detail: hard
          ? `会话文件损坏 ${corrupt.length} 个（帧 0 / 解不开），warn ${warn.length} 个 —— 数据风险`
          : `会话文件告警 ${warn.length} 个（未到损坏级）`,
        evidence: { corrupt: cap(corrupt.map((x) => ({ sessionId: x.sessionId, status: x.status, frameErrors: num(x.frameErrors) })), 10), warn: cap(warn.map((x) => x.sessionId), 10) },
      };
    },
  },
  {
    id: 'structure-health', title: '结构健康异常', level: LEVEL.YELLOW, deliverable: DELIVER.IMMEDIATE,
    category: 'infra', dataSource: 'structure',
    judge: (s, opts = {}) => {
      const st = s.structure;
      if (!st || !st.ok) return null;
      const problems = [];
      const missing = st.missingJunctions ?? [];
      if (missing.length) problems.push(`junction 目标缺失 ${missing.length} 个`);
      const ungrouped = num(st.ungroupedCount);
      const ungroupedLimit = num(opts.ungroupedThreshold) ?? 5;
      if (ungrouped !== null && ungrouped > ungroupedLimit) problems.push(`未分组会话 ${ungrouped} 个`);
      const drift = st.versionDrift ?? [];
      if (drift.length) problems.push(`profile 声明 vs 实体版本漂移 ${drift.length} 项`);
      if (!problems.length) return null;
      return {
        value: problems.join('|'),
        detail: problems.join('；'),
        evidence: { missingJunctions: cap(missing, 5), ungroupedCount: ungrouped, versionDrift: cap(drift, 5) },
      };
    },
  },

  // ── 学习项 6 ─────────────────────────────────────────────────────
  // 【2026-09-16 拷问 1.11】标题原名「会话空转/工具死循环」= **过度归因**：判据实际只有
  //   "尾巴回合未闭合 + 长时间无新事件"，长任务停顿（等大下载 / 长命令 / 人在开会）同样命中——
  //   当天自查就抓到实例：`<session>` 46 分钟无写入后被判死循环，11:12 又正常继续。
  //   现改为**只陈述判据事实**的措辞（"长时间无新事件（回合未闭合）"），归因交给读者。
  //   ⚠️ 只改文案，**阈值与判定逻辑一律不动**（换尺子要两机同改 + 重置计时，需主人另拍）。
  {
    id: 'session-spin', title: '长时间无新事件（回合未闭合）', level: LEVEL.RED, deliverable: DELIVER.IMMEDIATE,
    category: 'session', dataSource: 'sessions',
    judge: (s) => {
      const sess = s.sessions;
      if (!sess || !sess.ok) return null;
      const stuck = sess.stuck ?? [];
      if (!stuck.length) return null;
      return {
        value: setValue(stuck.map((x) => `${x.sessionId}:${x.reason}`)),
        detail: `长时间无新事件的会话 ${stuck.length} 个（回合未闭合 / 重复工具调用 / 推理原地循环，不必然等于故障）：${cap(stuck.map((x) => `${x.sessionId.slice(0, 12)}(${x.reason})`), 3).join('、')}`,
        evidence: { stuck: cap(stuck.map((x) => ({ sessionId: x.sessionId, reason: x.reason, idleMs: num(x.idleMs), toolCalls: num(x.toolCalls) })), 10) },
      };
    },
  },
  {
    id: 'session-long', title: '超长/高轮会话', level: LEVEL.YELLOW, deliverable: DELIVER.IMMEDIATE,
    category: 'session', dataSource: 'sessions',
    judge: (s) => {
      const sess = s.sessions;
      if (!sess || !sess.ok) return null;
      const long = sess.long ?? [];
      if (!long.length) return null;
      return {
        value: setValue(long.map((x) => x.sessionId)),
        detail: `${long.length} 个会话跑得异常久（>2h 或 >200 次 tool/call），可能走弯路`,
        evidence: { long: cap(long.map((x) => ({ sessionId: x.sessionId, hours: x.hours ?? null, toolCalls: num(x.toolCalls) })), 10) },
      };
    },
  },
  {
    id: 'recurring-success', title: 'recurring 卡成功率低', level: LEVEL.YELLOW, deliverable: DELIVER.IMMEDIATE,
    category: 'board', dataSource: 'ledger',
    judge: (s) => {
      const l = s.ledger;
      if (!l || !l.ok) return null;
      const low = l.recurringLow ?? [];
      if (!low.length) return null;
      return {
        value: setValue(low.map((x) => `${x.id}:${x.rate}`)),
        detail: `${low.length} 张 recurring 卡近 10 次成功率 <70%（系统性缺陷，建议查 prompt/验收）`,
        evidence: { cards: cap(low.map((x) => ({ id: x.id, title: x.title ?? null, rate: x.rate, runs: x.runs })), 10) },
      };
    },
  },
  {
    id: 'context-health', title: '会话上下文超 70%', level: LEVEL.YELLOW, deliverable: DELIVER.IMMEDIATE,
    category: 'session', dataSource: 'sessions',
    judge: (s, opts = {}) => {
      const sess = s.sessions;
      if (!sess || !sess.ok) return null;
      const limit = num(opts.contextPct) ?? 70;
      const high = (sess.contextHigh ?? []).filter((x) => num(x.pct) !== null && x.pct >= limit);
      if (!high.length) return null;
      return {
        value: setValue(high.map((x) => `${x.sessionId}:${Math.round(x.pct)}`)),
        detail: `${high.length} 个会话上下文已用 ${cap(high.map((x) => `${Math.round(x.pct)}%`), 3).join('/')} —— 该开新会话或切模型`,
        evidence: { high: cap(high.map((x) => ({ sessionId: x.sessionId, pct: x.pct, contextWindow: x.contextWindow ?? null })), 10) },
      };
    },
  },
  {
    id: 'tunnel-open', title: '手机隧道忘了关', level: LEVEL.RED, deliverable: DELIVER.DEFERRABLE,
    category: 'risk', dataSource: 'tunnel',
    judge: (s, opts = {}) => {
      const t = s.tunnel;
      if (!t || !t.ok) return null;
      if (t.running !== true) return null; // 隧道死了 = 安全态，不告警（风险型反向盯「开」）
      const idleLimit = num(opts.tunnelIdleHours) ?? 4;
      const idle = num(t.idleHours);
      if (idle !== null && idle < idleLimit) return null;
      return {
        value: `open${idle === null ? '' : `@${Math.round(idle)}h`}`,
        detail: idle === null
          ? 'cloudflared 隧道仍在线（无法判断闲置时长，按风险型默认提醒）'
          : `cloudflared 隧道还开着，约 ${Math.round(idle)} 小时没人用了 —— 公网暴露面，用后即关`,
        evidence: { running: true, idleHours: idle, pids: cap(t.pids ?? [], 5) },
      };
    },
  },
  {
    id: 'gitcrypt-key', title: 'git-crypt key 异常', level: LEVEL.RED, deliverable: DELIVER.DEFERRABLE,
    category: 'risk', dataSource: 'gitcrypt',
    judge: (s) => {
      const k = s.gitcrypt;
      if (!k || !k.ok) return null;
      const problems = [];
      if (k.exists !== true) problems.push('key 文件缺失');
      else if (num(k.bytes) === 0) problems.push('key 文件 0 字节');
      const mtime = num(k.mtimeMs);
      if (k.exists === true && mtime !== null) {
        const ageDays = (s.now - mtime) / DAY_MS;
        if (ageDays > 365) problems.push(`key mtime 异常（${Math.round(ageDays)} 天前）`);
        if (mtime > s.now + DAY_MS) problems.push('key mtime 在未来');
      }
      if (!problems.length) return null;
      return {
        value: problems.join('|'),
        detail: `git-crypt key 异常：${problems.join('；')} —— key 丢失 = 两仓密文永久不可读（冷备 <offsite>/dsh-backup-keys/）`,
        evidence: { path: k.path ?? null, exists: k.exists, bytes: num(k.bytes), mtimeMs: mtime },
      };
    },
  },
  // ── 自愈 1（2026-09-21 B1 卡新增；方案 §3.1 · 判定函数 = 上文 judgeRepairLinger）
  //   只报警不动手：命中 ⇒ 走现有 P2 通道（同类 4h 冷却 / 全局日 ≤10 条推送 / 23:00-07:00 免打扰）。
  //   ⚠️ 本事件**必须固定进日报段**（`dsh-butler-panel\report.mjs`）：`dailyCap: 10` 是**全局**上限
  //      ⇒ 配额用满时它会静默降级为"只落报告" —— **推送通道不是可用性保证、日报段才是**（R-B1-4）。
  {
    id: REPAIR_LINGER_EVENT_ID, title: '修复分身僵留（跑完未退出）', level: LEVEL.YELLOW, deliverable: DELIVER.IMMEDIATE,
    category: 'infra', dataSource: 'repair',
    judge: (s, opts = {}) => judgeRepairLinger(s, opts),
  },
];

/** 事件 id 清单（单测 / 面板 / 日报共用）。 */
export const EVENT_IDS = EVENT_SPECS.map((e) => e.id);

/** 判定全部事件（单条判定抛错只丢该条，不影响其余 —— tick 永不 reject）。 */
export function judgeAll(snapshot, opts = {}) {
  const now = num(snapshot?.now) ?? Date.now();
  const snap = { ...(snapshot ?? {}), now };
  const fired = [];
  for (const spec of EVENT_SPECS) {
    let r = null;
    try {
      r = spec.judge(snap, opts);
    } catch (e) {
      r = null;
      if (opts.onJudgeError) { try { opts.onJudgeError(spec.id, e); } catch { /* 观察者故障忽略 */ } }
    }
    if (!r) continue;
    fired.push({
      id: spec.id,
      title: spec.title,
      level: r.level ?? spec.level,
      deliverable: r.deliverable ?? spec.deliverable,
      category: spec.category,
      dataSource: spec.dataSource,
      worseWhen: spec.worseWhen ?? null,
      value: String(r.value ?? ''),
      detail: r.detail ?? spec.title,
      evidence: r.evidence ?? null,
    });
  }
  return fired;
}

/** 开工预检（⬜ 信息项：只进日报头部，永不告警）。 */
export function buildPreflight(snapshot) {
  const s = snapshot ?? {};
  const disk = s.disk ?? {};
  const lines = [];
  const fmtGb = (v) => (num(v) === null ? '?' : `${Math.round(num(v))}GB`);
  if (disk.ok) {
    const warn = [disk.cFreeGb, disk.dFreeGb].some((v) => num(v) !== null && num(v) < 15) ? ' ⚠️' : '';
    lines.push(`盘余量 C: ${fmtGb(disk.cFreeGb)} / D: ${fmtGb(disk.dFreeGb)}${warn}`);
  } else lines.push('盘余量 不可探测');
  lines.push(`代理 7897: ${s.proxy?.ok ? (s.proxy.listening ? '开' : '关') : '不可探测'}`);
  if (s.localStack?.ok) {
    lines.push(`生图栈: 8199 ${s.localStack.bridge ? '桥开' : '桥关'} / 8188 ${s.localStack.comfy ? 'ComfyUI 开' : 'ComfyUI 关'}`);
  } else lines.push('生图栈 不可探测');
  lines.push(`dsh: ${s.guard?.port3080 === true ? '运行中' : '未运行'}`);
  if (s.phone?.ok) {
    lines.push(`手机: 3081 ${s.phone.lanProxy ? '开' : '关'} · 隧道 ${s.phone.tunnel ? '在线' : '离线'}${s.phone.lanUrl ? ` · ${s.phone.lanUrl}` : ''}`);
  }
  return { lines, snapshotAt: num(s.now) };
}

// ------------------------------------------------------------------ 依赖抑制表

/**
 * 抑制规则（方案 §4 P2「依赖抑制表」）。
 * root 为「上下文条件」，suppresses 为被压制的派生事件 id。
 * 注意：维护窗口压制的是**预期事件**（白名单，来自 restart.mjs），不是全局静音。
 */
export const SUPPRESSION_RULES = [
  {
    root: 'maintenance-window',
    suppresses: ['guard-unhealthy', 'task-result', 'session-spin', 'structure-health'],
    why: '维护窗口（重启/迁移）内守护鱼/端口/计划任务必然抖动',
  },
  {
    root: 'guard-unhealthy',
    suppresses: ['task-result', 'session-spin', 'interrupt-backlog', 'structure-health'],
    why: '守护鱼异常是根因：端口/计划任务/dsh 相关事件都是派生',
  },
  {
    root: 'disk-full',
    suppresses: ['archive-error', 'archive-stalled', 'session-corrupt'],
    why: '磁盘满是根因：写入类失败都是派生',
  },
  {
    root: 'network-down',
    suppresses: ['upgrade-new-red', 'tunnel-open'],
    why: '网络不可达是根因：外部源/隧道判定都不可信',
  },
];

/**
 * 应用抑制表：根因先到，派生事件被压制（只发根因）。
 * @param {Array} events judgeAll 的结果
 * @param {{maintenanceActive?:boolean, diskFull?:boolean, networkDown?:boolean}} ctx
 * @returns {{kept:Array, suppressed:Array<{event:object, by:string, why:string}>}}
 */
export function applySuppression(events, ctx = {}) {
  const list = Array.isArray(events) ? events : [];
  const ids = new Set(list.map((e) => e.id));
  const active = new Set();
  if (ctx.maintenanceActive === true) active.add('maintenance-window');
  if (ids.has('guard-unhealthy')) active.add('guard-unhealthy');
  if (ctx.diskFull === true) active.add('disk-full');
  if (ctx.networkDown === true) active.add('network-down');

  const kept = [];
  const suppressed = [];
  for (const e of list) {
    // 根因自身永不被自己压制
    const rule = SUPPRESSION_RULES.find((r) => active.has(r.root) && r.root !== e.id && r.suppresses.includes(e.id));
    if (rule) suppressed.push({ event: e, by: rule.root, why: rule.why });
    else kept.push(e);
  }
  return { kept, suppressed };
}
