/**
 * 跨机骨架 · **第二柱：远端盘阈值 + 告警** —— 纯函数唯一来源（零 IO、零副作用）。
 *
 * 真源 = `<workspace>\docs\方案-跨机骨架三柱与统一开关-20261010-v2.md` §3（第二柱）：
 *   · §3.2 手段/盘符/两处取样/解析/🔴 解析判据（R5-3）/多盘/失败
 *   · §3.3 阈值存哪（统一开关文件 `butler-sync-topology.json#remoteSpace`；缺配置 ⇒ fail-closed 到内置默认 20/10 GiB）
 *   · §3.4 超阈告警走既有通道（`alert()` + 状态文件字段 + 周报 md；**去重/冷却 = 变严才告警 / 同 level ≥24h 且 ≥1 次核对再告警 / 变松不单独告警**）
 *   · §7.3 五环演练 · 机制 2（判定：取不到 ⇒ `unknown` 不告警；**连续 3 次 unknown 记 warn**）
 * 卡面约束真源 = `docs\复审-方案-跨机骨架v2-第三轮-20261011.md` §7.3 的 **S3 行**：
 *   ② 未新增任何推送面 ③ 解析判据只依赖 `\(([\d.]+ [KMGT]B)\)` ④ 与 S2 取样点去重（**本模块 = 那唯一一份取盘判据**）。
 *
 * ⚠️ 本模块**不做 IO**：不读开关文件（阈值由调用方从 `sync-topology.mjs` 解析后传入）、不 ssh、不写盘、不写日志。
 *   ⇒ 单测可白盒覆盖四态边界与乱码夹具，且"两处取样点共用同一份判据"是结构上强制的（不是靠约定）。
 *
 * ---------------------------------------------------------------------------
 * 🔴 解析判据的**实测依据**（2026-10-12 本机亲跑 · 只读 · `<workspace>\_tmp\s3-probe-fsutil.mjs`）：
 *
 *   mirror-host `D:`（3 行 · GBK 标签经 ssh 后乱码）
 *     1| 可用字节总数        : 245,235,601,408 (228.4 GB)
 *     2| 总字节数             : 644,231,827,456 (600.0 GB)
 *     3| 配额可用字节总数  : 245,235,601,408 (228.4 GB)
 *     ⇒ 括号值 = ["228.4 GB", "600.0 GB", "228.4 GB"]；**首个 = 末个 = 可用** ✅
 *
 *   主机 B `D:`（11 行 —— **这一台证明"取末个/取最小"会读错**）
 *     1| 总可用字节数                :   286,927,441,920 (267.2 GB)
 *     2| 总字节数                     : 1,000,186,310,656 (931.5 GB)
 *     3| 总配额可用字节数          :   286,927,441,920 (267.2 GB)
 *     4| 不可用池字节数          :                 0 (  0.0 KB)
 *     5| 配额不可用池字节数    :                 0 (  0.0 KB)
 *     6| 已用字节数                      :   712,754,458,624 (663.8 GB)
 *     7| 总保留字节数            :       504,410,112 (481.0 MB)   ← 末个括号值 = 481 MB（❌ 不是可用）
 *     8| 卷存储保留字节数   :                 0 (  0.0 KB)   ← 形态 `(  0.0 KB)`：`\(` 后是空格 ⇒ 按 v2 原文正则**天然不匹配**
 *     …（9/10/11 行同形态）
 *     ⇒ 括号值 = ["267.2 GB", "931.5 GB", "267.2 GB", "663.8 GB", "481.0 MB"]
 *     ⇒ **首个 = 267.2 GB（可用 ✅）**；**末个 = 481.0 MB（❌）**；**最小 = 481.0 MB（❌）**
 *
 *   ⇒ 判据定死 = **首个括号数值**（= v2 §3.2 原文 `out.match(/\(([\d.]+ [KMGT]B)\)/)` 的语义，且两机 3 次读数全对）。
 *   ⇒ 顺带修掉 **S2 实交实现的真缺陷**：S2 用「逐行匹配 + 循环不 break ⇒ 末个生效」，
 *     在 mirror-host 上碰巧对（末行=可用）、**在 主机 B 上会读成 481.0 MB ⇒ 假 alert**。本卡按 §7.3-S3②③ 把取盘判据统一到本模块。
 */
import { REMOTE_SPACE_FALLBACK } from './sync-topology.mjs';

/** v2 §3.2 的解析判据**原文形态**（只依赖括号数值；不依赖任何标签文字 ⇒ 标签乱码不影响）。 */
export const SPACE_PAREN_PATTERN = '\\(([\\d.]+ [KMGT]B)\\)';

/** 单位换算表（K/M/G/T，均为 1024 基数 —— 与 fsutil 的 `(X GB)` 口径一致）。 */
const UNIT_MULT = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** 四态（v2 §3.2 失败行 + §3.3 三档；**顺序即严重度顺序**）。 */
export const LEVELS = Object.freeze(['unknown', 'ok', 'warn', 'alert']);

/** 严重度排序（`unknown` = -1：**未知不算变严也不算变松**）。 */
export const LEVEL_RANK = Object.freeze({ unknown: -1, ok: 0, warn: 1, alert: 2 });

/** 告警 code（沿用 v2 §2.4 示例的 `remote-volume-low`，**不改名** ⇒ 既有消费方不炸）。 */
export const ALERT_CODES = Object.freeze({
  LOW: 'remote-volume-low',            // 空间低于阈值（warn / alert 两档共用，档位看 `level` 字段）
  UNKNOWN: 'remote-volume-unknown',    // 连续 N 次取不到（"取不到"本身就是症状）
  RECOVERED: 'remote-volume-recovered',// 变松复原（**只留痕、不单独发告警**）
});

/** §3.2：连续 3 次 `unknown` ⇒ 记一条 warn。 */
export const UNKNOWN_WARN_STREAK = 3;

/** §3.4：同一 level 持续 ≥ 24 h（且期间至少经过 1 次核对）⇒ **再**告警一次。 */
export const RESEND_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 兜底阈值（调用方没给 / 给了非法值时用；**fail-closed 到内置默认，绝不退化成"不判"**）。 */
export function defaultThresholds() {
  const t = REMOTE_SPACE_FALLBACK.targets[0];
  return { warnFreeBytes: t.warnFreeBytes, alertFreeBytes: t.alertFreeBytes };
}

/** 归一化阈值入参（缺省/非法 ⇒ 内置默认；单测可直接断言这一条）。 */
export function normThresholds(o = {}) {
  const d = defaultThresholds();
  const warn = Number.isFinite(o.warnFreeBytes) && o.warnFreeBytes >= 0 ? o.warnFreeBytes : d.warnFreeBytes;
  const alert = Number.isFinite(o.alertFreeBytes) && o.alertFreeBytes >= 0 ? o.alertFreeBytes : d.alertFreeBytes;
  return { warnFreeBytes: warn, alertFreeBytes: alert };
}

/**
 * 从 `fsutil volume diskfree` 输出里抽出**全部**括号数值（bytes）。
 * 只依赖 `SPACE_PAREN_PATTERN`；标签乱码 / 英文 / 中文一律不影响（R5-3）。
 */
export function parseSpaceValues(out) {
  const vals = [];
  const s = String(out ?? '');
  const re = new RegExp(SPACE_PAREN_PATTERN, 'g');   // 每次新建 ⇒ 无 lastIndex 共享坑
  for (const m of s.matchAll(re)) {
    const [num, unit] = String(m[1]).split(' ');
    const mult = UNIT_MULT[String(unit ?? '')[0].toUpperCase()] ?? 0;
    const n = Number(num);
    if (!Number.isFinite(n) || mult <= 0) continue;
    vals.push(Math.round(n * mult));
  }
  return vals;
}

/**
 * 远端盘**可用字节**（v2 §3.2 判据 = **首个**含括号数值的行；取不到 ⇒ `null`）。
 *
 * 两步 —— **两步都不依赖任何标签文字**（R5-3 / 验收⑤）：
 *   ① **定行**：逐行找**第一个**含 `\(([\d.]+ [KMGT]B)\)` 的行。实测 = 「可用字节总数 / 总可用字节数」行
 *      （mirror-host 3 行形态 + 主机 B 11 行形态 · 3 次读数全对）。
 *   ② **提精度**：同一行内若另有原生字节数（`\d[\d,]{8,}`），优先用它 —— 括号值是"1 位小数 GB"，
 *      换算回字节有 ≤ ~54 MB 的舍入误差（实测 mirror-host：`245,235,601,408` vs `228.4×1024³` 差 7.1 MB）。
 *      两者偏差 >1% ⇒ 判为"行内那个数字不是这个量的字节数"⇒ **退回括号值**（不猜、不静默取错）。
 *
 * ⚠️ 只取**同一行**的字节数：跨行取值 = 等于又信了"行序/标签"，判据立刻退化（S2 实交实现即栽在行序上）。
 * @returns {number|null}
 */
export function parseFreeBytes(out) {
  const s = String(out ?? '');
  for (const line of s.split(/\r?\n/)) {
    const m = new RegExp(SPACE_PAREN_PATTERN).exec(line);
    if (!m) continue;                                    // ① 本行没有括号数值形态 ⇒ 不是候选行
    const [num, unit] = String(m[1]).split(' ');
    const mult = UNIT_MULT[String(unit ?? '')[0].toUpperCase()] ?? 0;
    if (!mult) continue;
    const fromUnit = Math.round(Number(num) * mult);
    if (!Number.isFinite(fromUnit)) continue;
    const bm = /(\d[\d,]{8,})/.exec(line);               // ② 同行原生字节数（精度更高）
    if (bm) {
      const fromBytes = Number(String(bm[1]).replace(/,/g, ''));
      if (Number.isFinite(fromBytes)
        && Math.abs(fromBytes - fromUnit) <= Math.max(fromUnit * 0.01, 8 * 1024 * 1024)) {
        return fromBytes;
      }
    }
    return fromUnit;
  }
  return null;
}

/**
 * 阈值三档判定（§3.3；取不到 ⇒ `unknown`）。
 * 边界口径 = **严格小于**（"降到 warn 以下"才升级）：`=== warn` ⇒ `ok`，`=== alert` ⇒ `warn`。
 */
export function levelOf(freeBytes, thresholds = {}) {
  const { warnFreeBytes: warn, alertFreeBytes: alert } = normThresholds(thresholds);
  if (!Number.isFinite(freeBytes) || freeBytes < 0) return 'unknown';
  if (freeBytes < alert) return 'alert';
  if (freeBytes < warn) return 'warn';
  return 'ok';
}

/** 读数渲染（GiB，1 位小数；`null` ⇒ `null`）。 */
export function fmtGiB(bytes) {
  if (!Number.isFinite(bytes)) return null;
  return (bytes / 1024 ** 3).toFixed(1);
}

/**
 * 告警决策（§3.4 去重/冷却 + §3.2 失败行）—— **纯函数**，不调 `alert()`、不写盘。
 *
 * @param {object} o
 * @param {object|null} o.prev        上一轮 `remoteSpace` 字段（`{volume,freeBytes,level,checkedAt,unknownStreak}`）；首跑传 null
 * @param {string} o.next             本轮 level（`levelOf()` 的结果）
 * @param {number} [o.now]            当前时间（ms；单测注入）
 * @param {boolean} [o.enabled=true]  `remoteSpace.enabled`（**false ⇒ 关回：不产任何告警、不调 alert()**，验收④）
 * @param {number|null} [o.freeBytes] 本轮读数（渲染用）
 * @param {string} [o.volume]         卷（渲染用）
 * @param {number} [o.warnFreeBytes] / [o.alertFreeBytes]  阈值（渲染 + 判定）
 * @returns {{alerts:Array<object>, escalate:object|null, unknownStreak:number, disabled:boolean,
 *            prevLevel:string|null, threshold:{warnFreeBytes:number, alertFreeBytes:number}, reason:string|null}}
 *   · `alerts`    = 要落进报告 / 状态文件 `alerts[]` 的条目（含 `info` 级的"已恢复"）
 *   · `escalate`  = 需要调 `alert()` 的那一条（**变严** / **同 level ≥24h 重发** / **unknown 连击达标**）；没有则 null
 */
export function decideRemoteSpaceAlerts(o = {}) {
  const next = LEVELS.includes(String(o.next)) ? String(o.next) : 'unknown';
  const prev = o.prev && typeof o.prev === 'object' ? o.prev : null;
  const enabled = o.enabled !== false;                 // 缺省 true（fail-closed 到"会判"）
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const th = normThresholds(o);
  const prevLevel = prev && LEVELS.includes(String(prev.level)) ? String(prev.level) : null;
  const prevAt = prev && typeof prev.checkedAt === 'string' && Number.isFinite(Date.parse(prev.checkedAt))
    ? Date.parse(prev.checkedAt) : null;
  const streakPrev = prev && Number.isFinite(prev.unknownStreak) && prev.unknownStreak > 0
    ? Math.floor(prev.unknownStreak) : 0;
  const unknownStreak = next === 'unknown' ? streakPrev + 1 : 0;

  const out = {
    alerts: [], escalate: null, unknownStreak, disabled: !enabled,
    prevLevel, threshold: th, reason: null,
  };

  // 🔴 关回（验收④）：`remoteSpace.enabled=false` ⇒ 一条告警都不产（level 仍照算、照展示）
  if (!enabled) { out.reason = 'disabled'; return out; }

  // ① 取不到 ⇒ unknown：**不告警**（验收③）；只有**连续 3 次**才记一条 warn（"取不到"本身是症状）
  if (next === 'unknown') {
    if (unknownStreak === UNKNOWN_WARN_STREAK) {
      const a = {
        level: 'warn', code: ALERT_CODES.UNKNOWN,
        message: '远端盘读数连续 ' + unknownStreak + ' 次取不到（volume=' + String(o.volume || '?')
          + '）—— 取不到本身即症状（方案 §3.2）',
      };
      out.alerts.push(a); out.escalate = a; out.reason = 'unknown-streak';
    }
    return out;
  }

  const rankNext = LEVEL_RANK[next];
  const rankPrev = prevLevel === null ? null : LEVEL_RANK[prevLevel];
  const hard = next === 'warn' || next === 'alert';

  if (hard && (rankPrev === null || rankNext > rankPrev)) {
    out.reason = 'worsened';
  } else if (hard && rankNext === rankPrev && prevAt !== null && (now - prevAt) >= RESEND_INTERVAL_MS) {
    out.reason = 'sustained';   // 同一 level 持续 ≥24 h 且期间至少经过 1 次核对 ⇒ 再告警一次
  }

  if (out.reason) {
    const a = {
      level: 'warn', code: ALERT_CODES.LOW,
      message: '远端盘可用 ' + fmtGiB(o.freeBytes) + ' GiB（level=' + next
        + '；阈值 warn ' + fmtGiB(th.warnFreeBytes) + ' GiB / alert ' + fmtGiB(th.alertFreeBytes) + ' GiB'
        + (out.reason === 'sustained' ? '；同档已持续 ≥24h' : '') + '）',
    };
    out.alerts.push(a);
    out.escalate = a;
    return out;
  }

  // ② 变松（复原）⇒ **不单独发告警**，只在 `alerts[]` 里留一行"已恢复"（进下一次周报）
  if (prevLevel !== null && rankPrev >= LEVEL_RANK.warn && rankNext < rankPrev) {
    out.reason = 'recovered';
    out.alerts.push({
      level: 'info', code: ALERT_CODES.RECOVERED,
      message: '远端盘已恢复：可用 ' + fmtGiB(o.freeBytes) + ' GiB（level=' + next + '，上次 ' + prevLevel + '）',
    });
  }
  return out;
}

/** 本轮的 `remoteSpace` 状态字段（状态文件 / 报告共用同一形状 —— v2 §3.4 通道②）。 */
export function buildRemoteSpaceField(o = {}) {
  const level = LEVELS.includes(String(o.level)) ? String(o.level) : 'unknown';
  return {
    volume: typeof o.volume === 'string' ? o.volume : null,
    freeBytes: Number.isFinite(o.freeBytes) ? o.freeBytes : null,
    level,
    checkedAt: typeof o.checkedAt === 'string' ? o.checkedAt : new Date().toISOString(),
    unknownStreak: Number.isFinite(o.unknownStreak) ? o.unknownStreak : 0,
    enabled: o.enabled !== false,
    warnFreeBytes: normThresholds(o).warnFreeBytes,
    alertFreeBytes: normThresholds(o).alertFreeBytes,
  };
}
