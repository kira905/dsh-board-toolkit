/**
 * board-j1-limits.mjs —— J1 主账本体积判据的**唯一真源**（取值出处：方案 §5 J1）
 *
 * 方案：docs\看板瘦身与归档物理化-方案-20260924.md §5 J1（回修② 按 D-2=(c) 重定）
 *   · 相对项：主账本二进制字节 ≤ **在板卡数 × 10 KB**（带缩进口径）
 *   · 绝对项：主账本二进制字节 ≤ **1 572 864 B**（= 1.5 MB 二进制；十进制 1 500 000 B 口径见 §11 P-5 对照）
 *   · J1b：「在板体积趋势有界」**与**「周期归档有执行记录」（**"与"不是"或"**）—— 前者由
 *     `tools\board-j1b-trend.mjs` 复算；后者载体 = 看板卡 / 命令行留痕，本模块不判。
 *   · ⚠️ 执行者未放行前（§11 P-8）**J1 整体不判达标** —— 故本模块只算两个机械项，`overall` 仅是二者之与。
 *
 * 为什么单独一个文件：这三行取值要同时被**三个载体**引用（`board-cleanup.mjs` 日报/面板观测项、
 *   `board-j1b-trend.mjs` 复算脚本、面板片），写在两处就是"第二套口径"（K5 口径铁律明令禁止）。
 *
 * 纯常量 + 纯函数，零依赖、零副作用。
 */

/** J1 判据取值（唯一真源）。 */
export const J1 = Object.freeze({
  perCardBytes: 10 * 1024,             // 相对项系数：≤ 在板卡数 × 10 KB
  absBytes: 1_572_864,                 // 绝对项：1.5 MB（二进制）
  windowDays: 30,                      // J1b 回归窗口（近 30 天）
  slopeThresholdBytesPerDay: 10 * 1024, // J1b「趋势有界」暂定阈（K5 本卡暂定 · 可改；依据 = 稳态波动带）
  minPoints: 5,                        // J1b 少于 5 点不给斜率
  source: 'docs\\看板瘦身与归档物理化-方案-20260924.md §5 J1',
});

/**
 * 数字归一：缺失值（null/undefined/空串）→ null；非有限数 → null。
 * ⚠️ 存在的理由：`Number(null) === 0` 且 `Number.isFinite(0) === true` ⇒ 直接用 Number() 会把
 *   「体积未取到」误判成「0 字节 = 完美达标」（fail-open）。本 helper 是这条口径的唯一实现。
 */
export function toFiniteOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 字节 → 人读串（观测项共用同一格式，避免两处措辞漂移）。 */export function fmtBytes(n) {
  if (!Number.isFinite(Number(n))) return 'n/a';
  const v = Number(n);
  return `${v} B（${(v / 1024).toFixed(1)} KB）`;
}

/**
 * J1 两项机械判据（纯函数）。
 * @param {{liveCards:number, ledgerBytes:number}} input
 * @returns {{ok:boolean, relLimitBytes:number|null, relOk:boolean|null, absLimitBytes:number,
 *            absOk:boolean|null, overall:boolean|null, relMarginBytes:number|null, absMarginBytes:number|null,
 *            why?:string}}
 */
export function j1Check(input = {}) {
  // ⚠️ 坑：`Number(null) === 0`（且 Number.isFinite(0) === true）⇒ 缺失值会被当成"0 字节 = 完美达标"
  //   （fail-open）。故 null/undefined 一律先转 NaN，让"未取到"走显式的不可判分支。
  const toNum = (v) => (v === null || v === undefined || v === '' ? Number.NaN : Number(v));
  const cards = toNum(input.liveCards);
  const bytes = toNum(input.ledgerBytes);
  const absLimitBytes = J1.absBytes;
  if (!Number.isFinite(bytes)) {
    return {
      ok: false, relLimitBytes: null, relOk: null, absLimitBytes, absOk: null, overall: null,
      relMarginBytes: null, absMarginBytes: null, why: 'ledgerBytes 不可用（未取到主账本体积）',
    };
  }
  if (!Number.isFinite(cards)) {
    return {
      ok: false, relLimitBytes: null, relOk: null, absLimitBytes, absOk: bytes <= absLimitBytes, overall: false,
      relMarginBytes: null, absMarginBytes: absLimitBytes - bytes, why: 'liveCards 不可用（未取到在板卡数）',
    };
  }
  const relLimitBytes = cards * J1.perCardBytes;
  const relOk = bytes <= relLimitBytes;
  const absOk = bytes <= absLimitBytes;
  return {
    ok: true, relLimitBytes, relOk, absLimitBytes, absOk, overall: relOk && absOk,
    relMarginBytes: relLimitBytes - bytes, absMarginBytes: absLimitBytes - bytes,
  };
}

export default { J1, j1Check, fmtBytes };
