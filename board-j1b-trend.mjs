#!/usr/bin/env node
/**
 * board-j1b-trend.mjs —— 看板 J1b 趋势判据复算（在看板瘦身 · K5 §10 / 方案 §5 J1）
 *
 * 判据出处：docs\看板瘦身与归档物理化-方案-20260924.md §5 J1 / J1b
 *   · J1 相对项：主账本 ≤ 在板卡数 × 10 KB ；绝对项：主账本 ≤ 1 572 864 B（二进制 1.5 MB）
 *   · J1b：**在板体积趋势有界**（近 30 天在板卡数 / 体积的回归斜率 ≈ 0）**与**「周期归档有动作记录」
 *     ⇒ 本脚本只算**趋势那一半**；「执行记录」那一半的载体是看板卡 / 命令行留痕（脚本如实标注未判）。
 *
 * 数据源（全部只读；唯一写入 = 本脚本自己的采样台账）：
 *   ① 生产账本 `$DSH_HOME/task-board/ledger-v2.json`（当前真值：文件二进制字节 + 在板卡数 + revision）
 *   ② 共享采样台账 `$DSH_HOME/board-j1b-samples.jsonl`（本脚本每次跑追加一行；同 revision + 6h 内不重复）
 *   ③ 看板历史快照 `<workspace>\tools\board-snapshots\*.json`（只取 live 卡：`archivedAt === undefined`）
 *      ⚠️ 快照口径 = **快照内 live 卡的 JSON 字节**，与「主账本文件字节」是两个口径 ⇒ 两条序列分开回归，
 *         不混算（混算 = 假斜率）。快照最新一份停在迁移前，故迁移后的点靠 ② 采样续上。
 *
 * 用法：
 *   node <workspace>\tools\board-j1b-trend.mjs                 # 人读报告（并追加一条采样）
 *   node <workspace>\tools\board-j1b-trend.mjs --json          # 机读 JSON（stdout 只有 JSON，日志只落文件）
 *   node <workspace>\tools\board-j1b-trend.mjs --no-sample     # 纯只读，不写采样台账
 *   node <workspace>\tools\board-j1b-trend.mjs --days 30 --slope-threshold-bytes-per-day 10240
 *   node <workspace>\tools\board-j1b-trend.mjs --since 2026-09-28      # 只算 K4 迁移之后的点（口径连续）
 *
 * ⚠️ 口径断点：K4 归档物理化迁移（2026-09-27 23:19）前主账本**含归档卡**、之后**不含** ⇒
 *   窗口跨越该时点时脚本会显式告警（斜率 = 断点两侧口径的混合，不可解释为趋势）。
 *
 * 退出码：0 正常 ／ 2 用法错 ／ 3 环境不可用（账本读不到）／ 7 趋势判定为「无界」（slope 超阈）
 * 收尾一律 `process.exitCode`（本机坑：发过 fetch/IO 的脚本 process.exit() 会触发 libuv 断言 0xC0000409）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { J1, j1Check, fmtBytes } from './lib/board-j1-limits.mjs';
import { LOGS_DIR, TOOLS_DIR } from './lib/workspace.mjs';

export const J1B_VERSION = '1.1.0';

/** J1 判据常量与判据函数的**唯一真源** = `tools\lib\board-j1-limits.mjs`（本脚本只引用、不复制）。 */
export { J1, j1Check, fmtBytes };

/**
 * 已知口径断点：K4 归档物理化迁移（`archive-compact`）时点。
 * ⚠️ 迁移前主账本**含归档卡**、迁移后**不含** ⇒ 跨该时点的斜率是**断点两侧口径的混合**，
 *   **不可解释为趋势**。脚本据此提示（并在窗口跨越断点时建议 `--since`）。
 * 取值来源：内部测量记录（生产实测 2026-09-27 23:19）。
 */
export const K4_MIGRATION_AT = Date.parse('2026-09-27T23:19:00+08:00');
export const K4_MIGRATION_LABEL = '2026-09-27T23:19+08:00';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
export function defaultLedgerFile(home = dshHome()) {
  return path.join(home, 'task-board', 'ledger-v2.json');
}
export function defaultSamplesFile(home = dshHome()) {
  return path.join(home, 'board-j1b-samples.jsonl');
}
export function defaultSnapshotsDir() {
  return path.join(TOOLS_DIR, 'board-snapshots');
}
export function defaultLogFile() {
  return path.join(LOGS_DIR, 'board-j1b-trend.log');
}

export function parseArgs(argv) {
  const o = {
    json: false, noSample: false, days: J1.windowDays,
    slopeThresholdBytesPerDay: J1.slopeThresholdBytesPerDay,
    since: null,
    ledger: null, samples: null, snapshotsDir: null, log: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`缺少参数值：${a}`);
      return v;
    };
    if (a === '--json') o.json = true;
    else if (a === '--no-sample') o.noSample = true;
    else if (a === '--days') o.days = Number(next());
    else if (a === '--since') o.since = next();
    else if (a === '--slope-threshold-bytes-per-day') o.slopeThresholdBytesPerDay = Number(next());
    else if (a === '--ledger') o.ledger = next();
    else if (a === '--samples') o.samples = next();
    else if (a === '--snapshots-dir') o.snapshotsDir = next();
    else if (a === '--log') o.log = next();
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return o;
}

/** 读生产账本（只读）。返回在板卡数 / 文件字节 / revision。 */
export function readLedger(file) {
  let stat = null;
  try { stat = fs.statSync(file); } catch (e) {
    return { ok: false, file, bytes: null, tasks: null, liveCards: null, archivedCards: null, revision: null, error: e?.message ?? String(e) };
  }
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { ok: false, file, bytes: stat.size, tasks: null, liveCards: null, archivedCards: null, revision: null, error: e?.message ?? String(e) };
  }
  let j = null;
  try { j = JSON.parse(raw); } catch (e) {
    return { ok: false, file, bytes: stat.size, tasks: null, liveCards: null, archivedCards: null, revision: null, error: `JSON 解析失败：${e?.message ?? e}` };
  }
  const tasks = Array.isArray(j?.tasks) ? j.tasks : [];
  const live = tasks.filter((t) => t && t.archivedAt === undefined);
  return {
    ok: true, file, bytes: stat.size, tasks, liveCards: live.length,
    archivedCards: tasks.length - live.length,
    liveJsonBytes: Buffer.byteLength(JSON.stringify(live), 'utf8'),
    revision: j?.revision ?? null, error: null,
    mtimeMs: stat.mtimeMs,
  };
}

/** 读采样台账（jsonl；坏行跳过并计数）。 */
export function readSamples(file) {
  const out = { file, exists: fs.existsSync(file), rows: [], badLines: 0 };
  if (!out.exists) return out;
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s);
      if (r && Number.isFinite(Number(r.at))) out.rows.push({ at: Number(r.at), ...r });
      else out.badLines++;
    } catch { out.badLines++; }
  }
  return out;
}

/** 追加一条采样（幂等：同 revision 且距上一条 < 6h ⇒ 不追加）。 */
export function appendSample(file, rec, opts = {}) {
  const minGapMs = opts.minGapMs ?? 6 * 3600_000;
  const cur = readSamples(file);
  const last = cur.rows.length ? cur.rows[cur.rows.length - 1] : null;
  if (last && String(last.revision) === String(rec.revision) && (rec.at - last.at) < minGapMs) {
    return { ok: true, action: 'skip-same-revision', file };
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
    return { ok: true, action: 'appended', file };
  } catch (e) {
    return { ok: false, action: 'error', file, error: e?.message ?? String(e) };
  }
}

/** 从历史快照目录取 live 卡序列（只读；口径 = 快照内 live 卡，与账本文件字节分开算）。 */
export function readSnapshotSeries(dir, opts = {}) {
  const out = { dir, exists: fs.existsSync(dir), files: 0, points: [], errors: [] };
  if (!out.exists) return out;
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (e) {
    out.errors.push(String(e?.message ?? e)); return out;
  }
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const tasks = Array.isArray(j?.tasks) ? j.tasks : (Array.isArray(j?.cards) ? j.cards : null);
      if (!tasks) { out.errors.push(`${n}: 无 tasks/cards`); continue; }
      const live = tasks.filter((t) => t && t.archivedAt === undefined);
      const at = Date.parse(j.exportedAt ?? '') || fs.statSync(file).mtimeMs;
      out.files++;
      out.points.push({
        at, source: 'snapshot', file: n, host: j.fromHost ?? null, kind: j.kind ?? null,
        liveCards: live.length, liveJsonBytes: Buffer.byteLength(JSON.stringify(live), 'utf8'),
        ledgerBytes: null, revision: j.sourceRevision ?? null,
      });
    } catch (e) { out.errors.push(`${n}: ${e?.message ?? e}`); }
  }
  out.points.sort((a, b) => a.at - b.at);
  return out;
}

/** 最小二乘回归：x = 距窗口起点的天，y = 值。 */
export function linreg(points, key) {
  const pts = points.filter((p) => Number.isFinite(Number(p[key])) && Number.isFinite(Number(p.at)));
  const n = pts.length;
  if (n < 2) return { n, slopePerDay: null, intercept: null, r2: null, startAt: pts[0]?.at ?? null, endAt: pts[n - 1]?.at ?? null };
  const t0 = Math.min(...pts.map((p) => p.at));
  const xs = pts.map((p) => (p.at - t0) / 86_400_000);
  const ys = pts.map((p) => Number(p[key]));
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  const slope = sxx === 0 ? null : sxy / sxx;
  const intercept = slope === null ? null : my - slope * mx;
  const r2 = (sxx === 0 || syy === 0) ? null : (sxy * sxy) / (sxx * syy);
  return { n, slopePerDay: slope, intercept, r2, startAt: t0, endAt: Math.max(...pts.map((p) => p.at)) };
}

/**
 * 复算（纯函数，便于单测）：把三源合并成两条序列 + 回归 + J1 判定。
 * @param {{ledger:object, samples:Array, snapshots:Array, now:number, days:number,
 *          slopeThresholdBytesPerDay:number, minPoints:number}} input
 */
export function computeTrend(input) {
  const now = input.now ?? Date.now();
  const days = input.days ?? J1.windowDays;
  const since = Number.isFinite(input.since) ? Number(input.since) : null;
  const cutoff = Math.max(now - days * 86_400_000, since ?? Number.NEGATIVE_INFINITY);
  const minPoints = input.minPoints ?? J1.minPoints;
  const threshold = input.slopeThresholdBytesPerDay ?? J1.slopeThresholdBytesPerDay;
  // 窗口是否跨越 K4 迁移断点（断点前的点在"主账本含归档卡"口径下，与之后不可比）
  const spansMigrationBreak = cutoff < K4_MIGRATION_AT && now > K4_MIGRATION_AT;

  const inWindow = (p) => p.at >= cutoff;
  const snap = (input.snapshots ?? []).filter(inWindow);
  const samp = (input.samples ?? []).filter(inWindow);

  // 序列 A：在板卡数（快照 + 采样同口径，可合并）
  const cardPoints = [
    ...snap.map((p) => ({ at: p.at, v: p.liveCards, source: p.source })),
    ...samp.map((p) => ({ at: p.at, v: p.liveCards, source: p.source ?? 'sample' })),
  ].filter((p) => Number.isFinite(Number(p.v))).map((p) => ({ at: p.at, liveCards: Number(p.v), source: p.source }))
    .sort((a, b) => a.at - b.at);

  // 序列 B：在板体积（快照口径 = 快照内 live JSON 字节；采样口径 = 同法算出的 live JSON 字节）
  const liveBytesPoints = [
    ...snap.map((p) => ({ at: p.at, v: p.liveJsonBytes, source: p.source })),
    ...samp.map((p) => ({ at: p.at, v: p.liveJsonBytes, source: p.source ?? 'sample' })),
  ].filter((p) => Number.isFinite(Number(p.v))).map((p) => ({ at: p.at, liveJsonBytes: Number(p.v), source: p.source }))
    .sort((a, b) => a.at - b.at);

  // 序列 C：主账本文件字节（J1 真值口径；只有采样有历史）
  const ledgerBytesPoints = samp
    .filter((p) => Number.isFinite(Number(p.ledgerBytes)))
    .map((p) => ({ at: p.at, ledgerBytes: Number(p.ledgerBytes), source: p.source ?? 'sample' }))
    .sort((a, b) => a.at - b.at);

  const regCards = linreg(cardPoints, 'liveCards');
  const regLiveBytes = linreg(liveBytesPoints, 'liveJsonBytes');
  const regLedgerBytes = linreg(ledgerBytesPoints, 'ledgerBytes');

  // 归档事件（阶梯跳变）识别：周期归档**不是**平滑增长，而是一次性把整线搬走 ⇒
  //   相邻采样间若卡数变动 ≥ max(50 张, 5%)，标为"归档事件痕迹"（供人读时把"跳变"与"趋势"分开看）。
  const steps = [];
  for (let i = 1; i < cardPoints.length; i++) {
    const prev = cardPoints[i - 1];
    const cur = cardPoints[i];
    const dCards = cur.liveCards - prev.liveCards;
    const pct = prev.liveCards > 0 ? dCards / prev.liveCards : 0;
    if (Math.abs(dCards) >= 50 || Math.abs(pct) >= 0.05) {
      const prevB = liveBytesPoints.find((p) => p.at === prev.at)?.liveJsonBytes ?? null;
      const curB = liveBytesPoints.find((p) => p.at === cur.at)?.liveJsonBytes ?? null;
      steps.push({
        at: cur.at, iso: new Date(cur.at).toISOString(), source: cur.source,
        // 跨 K4 迁移断点的跳变 = **口径切换**（主账本从"含归档卡"变"不含"），不是归档事件
        kind: prev.at < K4_MIGRATION_AT && cur.at > K4_MIGRATION_AT ? 'migration-break' : 'archive-event',
        dCards, dCardsPct: Math.round(pct * 1000) / 10,
        dBytes: prevB !== null && curB !== null ? curB - prevB : null,
      });
    }
  }

  const ledger = input.ledger ?? {};
  const liveCards = Number(ledger.liveCards ?? 0);
  const ledgerBytes = Number(ledger.bytes ?? 0);
  // J1 两项机械判据走共享真源（不在此处复制算式）
  const check = j1Check({ liveCards, ledgerBytes });

  // 「趋势有界」= 有足够样本 且 体积斜率不超阈（负斜率/零 = 有界）
  const enough = regLiveBytes.n >= minPoints;
  const slope = regLiveBytes.slopePerDay;
  const bounded = enough && slope !== null && slope <= threshold;

  return {
    version: J1B_VERSION,
    now, isoNow: new Date(now).toISOString(), windowDays: days, cutoff,
    since: since === null ? null : since, sinceIso: since === null ? null : new Date(since).toISOString(),
    spansMigrationBreak, k4MigrationAt: K4_MIGRATION_AT, k4MigrationLabel: K4_MIGRATION_LABEL,
    current: {
      liveCards, ledgerBytes, archivedCards: ledger.archivedCards ?? null,
      revision: ledger.revision ?? null, ledgerFile: ledger.file ?? null,
      liveJsonBytes: ledger.liveJsonBytes ?? null,
    },
    j1: {
      ...check,
      perCardBytes: J1.perCardBytes,   // 系数保留在读数里（人读/机读都看得见判据形态）
      // ⚠️ 「J1 整体达标」还须 J1b 第二半（周期归档执行记录）——不由本脚本判定
    },
    trend: {
      cards: { ...regCards, points: cardPoints.length },
      liveBytes: { ...regLiveBytes, points: liveBytesPoints.length },
      ledgerBytes: { ...regLedgerBytes, points: ledgerBytesPoints.length },
      thresholdBytesPerDay: threshold, minPoints,
      bounded, enoughPoints: enough,
      /** 归档事件痕迹（阶梯跳变；与"趋势"分开看）。 */
      steps: steps.slice(-5),
      stepsTotal: steps.length,
      sourceCounts: { snapshots: input.snapshots?.length ?? 0, samples: input.samples?.length ?? 0 },
    },
    series: { cards: cardPoints, liveBytes: liveBytesPoints, ledgerBytes: ledgerBytesPoints },
    /** J1b 第二半（周期归档有执行记录）—— 本脚本**不判**，只如实标注。 */
    j1bSecondHalf: {
      judged: false,
      why: '「周期归档有动作记录」的载体 = 看板卡执行记录 / 命令行留痕；本脚本无法在只读前提下判定 ⇒ 不参与 overall',
    },
  };
}

// ---------------------------------------------------------------- 输出

export function renderText(r) {
  const L = [];
  const kb = fmtBytes;   // 与观测项共用同一格式化（`tools\lib\board-j1-limits.mjs`）
  L.push(`# J1b 趋势复算（board-j1b-trend v${r.version}）`);
  L.push('');
  L.push(`- 复算时点：${r.isoNow} · 窗口：近 ${r.windowDays} 天${r.sinceIso ? ` · 起点下限 --since ${r.sinceIso}` : ''}`);
  L.push(`- 在板卡数：**${r.current.liveCards}** 张 · 主账本文件：**${kb(r.current.ledgerBytes)}** · revision ${r.current.revision}`);
  L.push(`- J1 相对项（≤ 在板卡数 × 10 KB = ${kb(r.j1.relLimitBytes)}）：${r.j1.relOk ? '✅' : '❌'} 余量 ${kb(r.j1.relMarginBytes)}`);
  L.push(`- J1 绝对项（≤ ${kb(r.j1.absLimitBytes)}）：${r.j1.absOk ? '✅' : '❌'} 余量 ${kb(r.j1.absMarginBytes)}`);
  L.push(`- J1 机械项合并：${r.j1.overall ? '✅' : '❌'}（⚠️ **整体达标还须 J1b 第二半**，见末行）`);
  L.push('');
  L.push('## 回归斜率（近窗口）');
  const row = (label, reg, unit) => {
    const s = reg.slopePerDay === null ? '样本不足' : `${reg.slopePerDay >= 0 ? '+' : ''}${reg.slopePerDay.toFixed(2)} ${unit}/天`;
    const r2 = reg.r2 === null ? 'n/a' : reg.r2.toFixed(3);
    L.push(`- ${label}：n=${reg.n} · 斜率 ${s} · R² ${r2}`);
  };
  row('在板卡数', r.trend.cards, '张');
  row('在板体积（在板卡 JSON 口径）', r.trend.liveBytes, 'B');
  row('主账本文件字节（J1 真值口径）', r.trend.ledgerBytes, 'B');
  L.push('');
  L.push(`- 「趋势有界」判定（暂定阈 ≈ ${r.trend.thresholdBytesPerDay} B/天 · 窗口内 ≥ ${r.trend.minPoints} 点）：**${r.trend.bounded ? '有界 ✅' : '无界 / 样本不足 ❌'}**`);
  if (!r.trend.enoughPoints) L.push(`  - ⓘ 窗口内体积点只有 ${r.trend.liveBytes.points} 个（< ${r.trend.minPoints}）⇒ 斜率仅供参考，判据按「样本不足」处理`);
  L.push(`- 数据源：快照 ${r.trend.sourceCounts.snapshots} 份 · 采样 ${r.trend.sourceCounts.samples} 条（窗口内）`);
  if (r.trend.stepsTotal > 0) {
    const arch = r.trend.steps.filter((s) => s.kind === 'archive-event').length;
    L.push(`- ⚠️ 检出 **${r.trend.stepsTotal} 处阶梯跳变**（其中疑似归档事件 ${arch} 处、K4 迁移口径切换 ${r.trend.stepsTotal - arch} 处）`
      + ` —— 归档是"一次性搬走整线"、**不是平滑增长** ⇒ 斜率会被阶梯干扰，判「趋势有界」时须把跳变与趋势分开看。最近 ${r.trend.steps.length} 处：`);
    for (const s of r.trend.steps) {
      const tag = s.kind === 'migration-break' ? '【K4 迁移口径切换】' : '【阶梯跳变】';
      L.push(`  - ${tag} ${s.iso.slice(0, 16).replace('T', ' ')}Z · 在板 ${s.dCards > 0 ? '+' : ''}${s.dCards} 张（${s.dCardsPct}%）`
        + `${s.dBytes === null ? '' : ` · 在板体积 ${s.dBytes > 0 ? '+' : ''}${s.dBytes} B`} · 来源 ${s.source}`);
    }
    L.push('  - ⓘ 归因提示：采样点之间的跳变可归因（K4 断点 / 归档批次）；**历史快照之间**的跳变还可能混入跨机快照差异（depart 快照取自不同主机）⇒ 不逐条断言为归档。');
  }
  const span = (reg) => (reg.startAt && reg.endAt ? `${new Date(reg.startAt).toISOString().slice(0, 10)} ~ ${new Date(reg.endAt).toISOString().slice(0, 10)}` : 'n/a');
  L.push(`  - 卡数序列跨度：${span(r.trend.cards)} · 体积序列跨度：${span(r.trend.liveBytes)}`);
  L.push('  - ⚠️ 口径提示：历史点全部来自 `tools\\board-snapshots\\`（K4 迁移 **2026-09-27 23:19** 之前的快照）⇒ 斜率含「归档卡未搬出」的成分；迁移后的点在采样台账里累积，满窗口后复算才反映**迁移后**真实趋势。');
  L.push(`  - ⚠️ 两条体积序列口径不同（在板卡 JSON vs 主账本文件）⇒ 分开回归，**不混算**。`);
  if (r.spansMigrationBreak) {
    L.push(`  - 🔴 **窗口跨越 K4 迁移断点（${r.k4MigrationLabel}）** —— 断点前主账本含归档卡、之后不含，两侧口径**不连续** ⇒ 本斜率**不可解释为趋势**；算迁移后趋势请加 \`--since ${r.k4MigrationLabel.slice(0, 10)}\`（并攒够 ≥ ${r.trend.minPoints} 个采样点）。`);
  }
  L.push('');
  L.push(`> J1b 第二半（周期归档有执行记录）：**未判** —— ${r.j1bSecondHalf.why}`);
  return L.join('\n');
}

function logLine(file, msg, opts) {
  if (!file) return { ok: true, skipped: true };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message ?? String(e) }; }
}

// ---------------------------------------------------------------- main

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`用法错：${e?.message ?? e}\n`);
    process.exitCode = 2; return;
  }
  if (o.help) {
    process.stdout.write('用法：node board-j1b-trend.mjs [--json] [--no-sample] [--days 30] [--since <ISO|YYYY-MM-DD>] [--ledger <f>] [--samples <f>] [--snapshots-dir <d>] [--slope-threshold-bytes-per-day N]\n');
    return;
  }
  const home = dshHome();
  const ledgerFile = o.ledger ?? defaultLedgerFile(home);
  const samplesFile = o.samples ?? defaultSamplesFile(home);
  const snapshotsDir = o.snapshotsDir ?? defaultSnapshotsDir();
  const logFile = o.log ?? defaultLogFile();

  const ledger = readLedger(ledgerFile);
  if (!ledger.ok) {
    logLine(logFile, `✘ 账本不可读：${ledgerFile} — ${ledger.error}`);
    process.stderr.write(`环境不可用：账本读不到（${ledgerFile}）：${ledger.error}\n`);
    process.exitCode = 3; return;
  }

  // 采样（默认写；--json 也写，但日志只落文件）
  let sampleWrite = { ok: true, action: 'disabled' };
  if (!o.noSample) {
    const now = Date.now();
    sampleWrite = appendSample(samplesFile, {
      at: now, iso: new Date(now).toISOString(), host: os.hostname(),
      liveCards: ledger.liveCards, ledgerBytes: ledger.bytes, liveJsonBytes: ledger.liveJsonBytes,
      archivedCards: ledger.archivedCards, revision: ledger.revision, source: 'sample',
    });
  }

  const samples = readSamples(samplesFile);
  const snaps = readSnapshotSeries(snapshotsDir);
  let sinceMs = null;
  if (o.since) {
    const t = Date.parse(o.since);
    if (!Number.isFinite(t)) {
      process.stderr.write(`用法错：--since 无法解析为时间：${o.since}\n`);
      process.exitCode = 2; return;
    }
    sinceMs = t;
  }
  const result = computeTrend({
    ledger, samples: samples.rows, snapshots: snaps.points,
    now: Date.now(), days: Number.isFinite(o.days) ? o.days : J1.windowDays,
    slopeThresholdBytesPerDay: o.slopeThresholdBytesPerDay, since: sinceMs,
  });
  result.source = {
    ledgerFile, samplesFile, snapshotsDir, logFile,
    sampleWrite, samplesTotal: samples.rows.length, samplesBadLines: samples.badLines,
    snapshotsFiles: snaps.files, snapshotErrors: snaps.errors,
  };

  if (o.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    logLine(logFile, `json 复算：live=${result.current.liveCards} bytes=${result.current.ledgerBytes} slope=${result.trend.liveBytes.slopePerDay} bounded=${result.trend.bounded} sample=${sampleWrite.action}`);
  } else {
    const text = renderText(result);
    process.stdout.write(`${text}\n`);
    logLine(logFile, `复算：live=${result.current.liveCards} bytes=${result.current.ledgerBytes} slope=${result.trend.liveBytes.slopePerDay} bounded=${result.trend.bounded} sample=${sampleWrite.action}`);
  }
  // 退出码 7 = 趋势无界（不阻断读；给 CI/巡检用）
  if (!result.trend.bounded) process.exitCode = 7;
}

// 入口守卫：junction 下 import.meta.url 解析为物理路径、argv[1] 为逻辑路径 ⇒ 双方 realpath 后比
const isMain = (() => {
  try {
    const a = fs.realpathSync(process.argv[1] ?? '');
    const b = fs.realpathSync(fileURLToPath(import.meta.url));
    return a.toLowerCase() === b.toLowerCase();
  } catch { return false; }
})();
if (isMain) await main();
