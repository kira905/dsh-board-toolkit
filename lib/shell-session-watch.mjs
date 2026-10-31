// dsh-butler / lib/shell-session-watch.mjs —— P2「会盯人」**候选事件**：空壳会话 / 本机空壳-仓里完整
//
// ═══════════════════════════════════════════════════════════════════════════════
// 🔒 锁后交付状态（2026-09-14，主机 B 侧）：**本模块已实现、已单测、未接线。**
//
//   本文件**不被任何生产文件 import**：不注册进 lib/watch-events.mjs 的 EVENT_SPECS、
//   不进 lib/watch-policy.mjs 的分档、不进 butler-watch-state.json、不进 barewatch 台账
//   ⇒ 对裸跑段 2 的三项放行门槛（累计告警 / 误报率 / 疑似误报占比）**零影响**。
//
//   为什么必须锁后接线（不是偷懒，有实证）：
//     barewatch 台账的行 = P2 state 的 `daily.items[]` 逐条落库（butler-barewatch-ledger.jsonl
//     每行含 {day,eventId,level,kind:'report'|'push'}）。而 watch-policy.mjs 对 🟡 事件的
//     处理是 `next.daily.reportOnly += 1; next.daily.items.push({...kind:'report'})`（L149-155）
//     ⇒ **只要注册进主表，即使 level=yellow、永不推送，也会每轮往 daily.items 写一条**，
//       被 barewatch-tick 采集成台账行 → 直接抬高「累计样本数」并计入「疑似误报」分母。
//     ⇒ 「只进报告段、不推、不参与 KPI」这个设想**在主表机制下不成立**；唯一干净的接法是
//       等裸跑段 2 收尾（L1 复查 2026-09-17）后由主人放行，再注册。
//
//   放行后的接线三步（届时见 docs\P2空壳会话事件-候选实现与接线说明-20260914.md）：
//     ① lib/watch-collect.mjs 加一段 heavy 采集：`snap.shellSessions = collectShellSessions({home, now})`
//     ② lib/watch-events.mjs 追加两行：import SHELL_SESSION_EVENT_SPEC + `EVENT_SPECS.push(...)`
//     ③ 跑 _test\test-watch.mjs（届时基线数会从 136 变为 136+N）与 verify-acceptance-p2.mjs
// ═══════════════════════════════════════════════════════════════════════════════
//
// 【判据与 AT2 同源】空壳口径**逐条复刻** `<workspace>\tools\dsh-backup-sessions.ps1` 的纯函数
//   （内部批次「仓2 采集加空壳守卫」2026-09-14 定案），不另造口径：
//     · 判据① 文件 < 2 KB  ── Test-ShellSessionFile  L175（`$info.Bytes -ge $ShellSizeLimit` → 直接放行）
//     · 判据② 逐帧解后事件数 < 3  ── 同函数 L185（`$info.Events -lt $ShellEventLimit` → shell）
//     · 判据③ 逐帧解后没有 turn/start  ── 同函数 L186（`-not $info.HasTurnStart` → shell）
//     ②③ 取「或」，且都只在①成立时评估。
//     · 探针不可用 → 保守按空壳 ── 同函数 L177-181（宁可少覆盖，不可丢内容）
//     · 「本机空壳 / 仓里完整」判据 ── Test-SkippedShell L193-199：
//         LocalLen < 2KB && LocalIsShell && RepoLen > LocalLen ⇒ true
//     · 事件统计口径 ── tools\dsh-session-probe.mjs L44-51：非空行数 = 事件数；
//       行内 JSON 解析成功后 type==='turn/start' 才算有 turn/start
//   ⚠️ 必须**逐帧解**：session.jsonl.zstd 是多帧 zstd 拼接（append-only），只解首帧会把完整会话
//      误判成空壳（AT2 卡实测结论）。此处复用 P2 内部已有的 `decodeZstdFrames`
//      （lib/pitfall-scan.mjs L77，同样是按 magic 切帧逐帧解），不重复实现。
//
// 复用来源（只读，未改动它们）：
//   · lib/pitfall-scan.mjs  → discoverSessionFiles / decodeZstdFrames（扫描 + 逐帧解）
//   · lib/watch-events.mjs  → LEVEL / DELIVER 常量（保持与 P2 事件层同一套枚举）
//   · P6 范式（lib/external-sources.mjs）→「发现 → 只落候选、绝不自动启用」

import fs from 'node:fs';
import path from 'node:path';

import { discoverSessionFiles, decodeZstdFrames } from './pitfall-scan.mjs';
import { LEVEL, DELIVER } from './watch-events.mjs';
// 宿主适配层副本（唯一源 tools\lib\host-adapter.mjs；P1 收敛 2026-09-15）
import { isTurnStart } from './host-adapter.mjs';
import { SYNCED_SESSIONS_DIR } from './workspace.mjs';

export const SHELL_SESSION_WATCH_VERSION = '0.1.0';

/** 接线标记：候选实现恒为 false；接线后改为 true（单测有反向断言）。 */
export const WIRED = false;

/** 候选事件 id（**未**出现在 lib/watch-events.mjs 的 EVENT_IDS 里，单测有反向断言）。 */
export const SHELL_SESSION_EVENT_ID = 'shell-session';

/** 判据① 文件大小上限（AT2 L175；`>= 2048` 即视为有内容，连解压都不做）。 */
export const SHELL_SIZE_LIMIT = 2048;

/** 判据② 逐帧解后的事件数下限（AT2 L185；`< 3` 判空壳）。 */
export const SHELL_EVENT_LIMIT = 3;

/** 仓2 采集工作副本里会话树的默认位置（跨机同路径；环境变量可覆盖）。 */
export const DEFAULT_REPO_SESSIONS_DIR = SYNCED_SESSIONS_DIR;

const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const errMsg = (e) => (e?.message ?? String(e ?? 'unknown'));
/** 集合型 value（稳定可比：排序去重后 `|` 连接）——policy 用它做「只报状态变化」。 */
const stableSet = (arr) => [...new Set(arr.map(String))].sort().join('|');
const cap = (arr, n) => arr.slice(0, n);
const shortId = (id) => String(id ?? '').replace(/^session-/, '').slice(0, 12);

// ------------------------------------------------------------------ ① 单文件判定（AT2 同源）

/**
 * 空壳判定（纯函数，口径 = AT2 判据①②③，见文件头出处）。
 * @param {{bytes?:number, events?:number|null, hasTurnStart?:boolean, frames?:number|null,
 *          probeOk?:boolean, probeError?:string|null}} input
 * @returns {{shell:boolean, reason:string, bytes:number, events:number|null, hasTurnStart:boolean,
 *            frames:number|null, probeOk:boolean, probeError:string|null}}
 *   reason ∈ size-gate(①不成立) | probe-unavailable(保守) | few-events(②) | no-turn-start(③) | has-content
 */
export function judgeShellFile(input = {}) {
  const bytes = num(input.bytes) ?? 0;
  const events = num(input.events);
  const base = {
    bytes,
    events,
    hasTurnStart: input.hasTurnStart === true,
    frames: num(input.frames),
    probeOk: input.probeOk !== false,
    probeError: input.probeError ?? null,
  };
  // 判据①：文件 ≥ 2KB ⇒ 大小本身就证明有内容，不判空壳（也不解压）
  if (bytes >= SHELL_SIZE_LIMIT) return { ...base, shell: false, reason: 'size-gate' };
  // 探针不可用（node 缺失 / 解不开 / 调用失败）⇒ 保守按空壳（AT2 L177-181）
  if (base.probeOk !== true || events === null) return { ...base, shell: true, reason: 'probe-unavailable' };
  // 判据②：事件数 < 3
  if (events < SHELL_EVENT_LIMIT) return { ...base, shell: true, reason: 'few-events' };
  // 判据③：没有 turn/start（只剩 session / permission / sandbox / approval / end-seed 这类启动头）
  if (base.hasTurnStart !== true) return { ...base, shell: true, reason: 'no-turn-start' };
  return { ...base, shell: false, reason: 'has-content' };
}

/** 事件统计（口径 = tools\dsh-session-probe.mjs L44-51：非空行数 + type==='turn/start'）。 */
export function countSessionEvents(text) {
  const lines = String(text ?? '').split('\n').filter((l) => l.trim().length > 0);
  let hasTurnStart = false;
  const types = {};
  for (const l of lines) {
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (isTurnStart(o?.type)) hasTurnStart = true;
    if (typeof o?.type === 'string') types[o.type] = (types[o.type] ?? 0) + 1;
  }
  return { events: lines.length, hasTurnStart, types };
}

/**
 * 读单个会话文件并判定（size-gate 时不读盘、不解压 —— 与 AT2 的提前返回一致）。
 * 读不到（stat 失败）⇒ shell=false + error（AT2 L173 同：missing 不判空壳）。
 * @returns {{file:string, shell:boolean, reason:string, bytes:number, events:number|null,
 *            hasTurnStart:boolean, frames:number|null, probeOk:boolean, probeError:string|null, types?:object}}
 */
export function inspectSessionFile(file, opts = {}) {
  const limit = num(opts.sizeLimit) ?? SHELL_SIZE_LIMIT;
  let bytes = 0;
  try { bytes = fs.statSync(file).size; } catch (e) {
    return { file, shell: false, reason: 'missing', bytes: 0, events: null, hasTurnStart: false, frames: null, probeOk: false, probeError: errMsg(e) };
  }
  const gate = judgeShellFile({ bytes, events: 0, hasTurnStart: false, probeOk: true });
  if (gate.reason === 'size-gate') {
    return { file, shell: false, reason: 'size-gate', bytes, events: null, hasTurnStart: false, frames: null, probeOk: true, probeError: null, decoded: false };
  }
  let dec;
  try { dec = decodeZstdFrames(fs.readFileSync(file)); } catch (e) {
    // 读不到/解不动 ⇒ 保守按空壳（同 AT2 探针不可用分支）
    return { file, shell: true, reason: 'probe-unavailable', bytes, events: null, hasTurnStart: false, frames: null, probeOk: false, probeError: errMsg(e), decoded: false };
  }
  const stat = countSessionEvents(dec.text);
  const probeOk = dec.frames > 0 && (dec.frameErrors?.length ?? 0) === 0;   // 同探针 L52 与 P2 decode 口径
  const verdict = judgeShellFile({ bytes, events: stat.events, hasTurnStart: stat.hasTurnStart, frames: dec.frames, probeOk, probeError: probeOk ? null : 'frame decode failed' });
  return { file, ...verdict, types: stat.types, decoded: true };
}

// ------------------------------------------------------------------ ② 「本机空壳 / 仓里完整」判据

/**
 * 不一致判定（纯函数，逐条复刻 AT2 的 Test-SkippedShell L193-199）。
 * @param {number} localBytes 本机那份字节数
 * @param {number|null} repoBytes 仓里那份字节数（null = 仓里没有）
 * @param {boolean} localIsShell 本机是否判空壳（由 judgeShellFile / inspectSessionFile 给出）
 * @returns {boolean} true = 本机空壳且仓里那份更大（拉锯风险）
 */
export function isMismatchShell(localBytes, repoBytes, localIsShell) {
  if ((num(localBytes) ?? 0) >= SHELL_SIZE_LIMIT) return false;   // 判据① 不成立
  if (localIsShell !== true) return false;                        // 判据②③ 都不成立 = 本机有内容
  const rb = num(repoBytes);
  if (rb === null) return false;                                  // 仓里没有
  if (rb <= (num(localBytes) ?? 0)) return false;                 // 仓里那份不比本机大
  return true;
}

// ------------------------------------------------------------------ ③ 事件判定（与 P2 judge 同签名，但未注册）

/**
 * 组装事件（签名同 P2 的 `judge(snapshot, opts)`：返回 null = 不在异常态）。
 * @param {{ok?:boolean, scanned?:number, belowLimit?:number, shells?:Array, repo?:object}} input
 *   = snapshot.shellSessions（接线时由 lib/watch-collect.mjs 采集）
 * @returns {null|{value:string, detail:string, level:string, deliverable:string, evidence:object}}
 */
export function judgeShellSessions(input, opts = {}) {
  if (!input || input.ok !== true) return null;
  const shells = (input.shells ?? []).filter((s) => s && s.shell === true);
  if (!shells.length) return null;
  const repoOf = (s) => (s.repo && s.repo.exists === true && s.repo.encrypted !== true ? s.repo : null);
  const mismatches = shells.filter((s) => isMismatchShell(s.bytes, repoOf(s)?.bytes ?? null, true));
  const maxList = num(opts.maxList) ?? 5;
  const mismatchIds = new Set(mismatches.map((s) => s.sessionId));
  const value = stableSet(shells.map((s) => `${mismatchIds.has(s.sessionId) ? 'mismatch' : 'shell'}:${s.sessionId}`));
  const detail = mismatches.length
    ? `本机空壳会话 ${shells.length} 个；其中 ${mismatches.length} 个与仓2 采集快照不一致（本机空壳 / 仓里更大）—— 采集覆盖拉锯风险，仓里那份是完整版`
    : `本机空壳会话 ${shells.length} 个（<2KB 且逐帧解后无 turn/start）—— 会话内容疑似已丢失（仓2 快照里也不比本机大）`;
  const describe = (s) => `${shortId(s.sessionId)}(${num(s.bytes) ?? '?'}B/${num(s.events) ?? '?'}事件/${s.reason})`;
  return {
    value,
    level: LEVEL.YELLOW,                 // 🟡 只进报告（2026-09-09 主人拍板：🔴 推 / 🟡 进日报）
    deliverable: DELIVER.DEFERRABLE,     // 数据风险类（形状与 session-corrupt 的损坏态一致）
    detail: `${detail}：${cap(shells.map(describe), maxList).join('、')}${shells.length > maxList ? ` 等 ${shells.length} 个` : ''}`,
    evidence: {
      scanned: num(input.scanned),
      belowLimit: num(input.belowLimit),
      shells: cap(shells.map((s) => ({ sessionId: s.sessionId, bytes: num(s.bytes), events: num(s.events), hasTurnStart: s.hasTurnStart === true, reason: s.reason, repoBytes: num(repoOf(s)?.bytes), mismatch: mismatchIds.has(s.sessionId) })), 10),
      mismatch: cap(mismatches.map((s) => ({ sessionId: s.sessionId, localBytes: num(s.bytes), repoBytes: num(repoOf(s)?.bytes) })), 10),
      repo: input.repo ?? null,
    },
  };
}

/**
 * 候选事件定义（形状与 lib/watch-events.mjs 的 EVENT_SPECS 条目一致）。
 * **当前不注册**：接线 = `EVENT_SPECS.push(SHELL_SESSION_EVENT_SPEC)`（放行后）。见文件头三步。
 */
export const SHELL_SESSION_EVENT_SPEC = Object.freeze({
  id: SHELL_SESSION_EVENT_ID,
  title: '空壳会话 / 本机空壳-仓里完整',
  level: LEVEL.YELLOW,
  deliverable: DELIVER.DEFERRABLE,
  category: 'session',
  dataSource: 'shellSessions',
  worseWhen: 'increase',   // 集合型 value：只有「新增空壳 id」才算变差（对齐 upgrade-new-red）
  judge: (s) => judgeShellSessions(s?.shellSessions ?? null, {}),
});

// ------------------------------------------------------------------ ④ 报告段渲染（预览用；未接线时不写任何报告）

/**
 * 渲染「若接线后日报会多出的一段」（纯文本行；本 CLI 与将来的日报共用）。
 * @returns {string[]} 报告行（无发现时返回单行「无」）
 */
export function renderShellSessionSection(input, opts = {}) {
  const head = '🔍 空壳会话（候选 · 未接线 · 不计入告警 KPI）';
  if (!input || input.ok !== true) return [`${head}：不可探测（${input?.error ?? '数据源不可用'}）`];
  const shells = (input.shells ?? []).filter((s) => s && s.shell === true);
  const mism = shells.filter((s) => isMismatchShell(s.bytes, (s.repo?.exists === true && s.repo.encrypted !== true) ? s.repo.bytes : null, true));
  const lines = [`${head}：本机空壳 ${shells.length} 个 / 与仓2 不一致 ${mism.length} 个（扫描 ${num(input.scanned) ?? '?'} 个会话文件，其中 <2KB 候选 ${num(input.belowLimit) ?? '?'} 个）`];
  if (input.repo && input.repo.ok !== true) lines.push(`  · 仓2 比对降级：${input.repo.reason ?? '不可用'}${input.repo.dir ? `（${input.repo.dir}）` : ''}`);
  for (const s of cap(shells, num(opts.maxList) ?? 10)) {
    const mm = isMismatchShell(s.bytes, (s.repo?.exists === true && s.repo.encrypted !== true) ? s.repo.bytes : null, true);
    const repo = s.repo?.exists === true ? `仓里 ${s.repo.encrypted === true ? '密文' : `${num(s.repo.bytes) ?? '?'}B`}` : '仓里无此文件';
    lines.push(`  · ${shortId(s.sessionId)}  ${num(s.bytes) ?? '?'}B / ${num(s.events) ?? '?'} 事件 / turn-start=${s.hasTurnStart === true} / 判据=${s.reason} / ${repo}${mm ? '  ⚠️ 不一致' : ''}`);
  }
  if (shells.length > (num(opts.maxList) ?? 10)) lines.push(`  · … 其余 ${shells.length - (num(opts.maxList) ?? 10)} 个省略`);
  return lines;
}

// ------------------------------------------------------------------ ⑤ 采集（IO；只读，永不写盘）

/** 仓2 工作副本会话树（opts.repoDir > 环境变量 DSH_REPO2_SESSIONS > 默认路径）。 */
export function resolveRepoDir(opts = {}) {
  const explicit = opts.repoDir ?? process.env.DSH_REPO2_SESSIONS ?? null;
  const dir = explicit ? String(explicit) : DEFAULT_REPO_SESSIONS_DIR;
  try { return fs.existsSync(dir) ? dir : null; } catch { return null; }
}

/** git-crypt 密文探测（前 64 字节里找 GITCRYPT 标记）——密文大小 ≠ 明文，比对必须降级。 */
function looksEncrypted(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(64);
      const n = fs.readSync(fd, buf, 0, 64, 0);
      return buf.subarray(0, n).includes('GITCRYPT');
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/**
 * 采集：扫本机会话树（**只扫活跃树**，排除 _archived-sessions —— 对齐 P2 v0.1.2 口径
 * lib/watch-collect.mjs L371-380「归档区会话不是活跃会话」），对 <2KB 候选判空壳，
 * 再与仓2 采集快照比大小（可选）。
 * @param {{home?:string, repoDir?:string|null, now?:number, sizeLimit?:number, skipRepo?:boolean}} opts
 * @returns {{ok:boolean, scanned:number, belowLimit:number, shells:Array, repo:object, error?:string}}
 */
export function collectShellSessions(opts = {}) {
  const home = opts.home ?? null;
  if (!home) return { ok: false, error: 'home required', scanned: 0, belowLimit: 0, shells: [], repo: { ok: false, reason: 'home-missing' } };
  let files;
  try { files = discoverSessionFiles(home); } catch (e) {
    return { ok: false, error: errMsg(e), scanned: 0, belowLimit: 0, shells: [], repo: { ok: false, reason: 'scan-failed' } };
  }
  const limit = num(opts.sizeLimit) ?? SHELL_SIZE_LIMIT;
  const active = files.filter((f) => f.root !== 'archived');   // 口径对齐：归档区不算活跃会话
  const candidates = active.filter((f) => (num(f.bytes) ?? 0) < limit);

  // 仓2 比对准备（只对「本机空壳」需要的候选做，数量级个位数）
  const repoDir = opts.skipRepo === true ? null : resolveRepoDir(opts);
  const sessionsRoot = path.join(home, 'sessions');
  const repo = repoDir
    ? { ok: true, dir: repoDir, checked: 0, missing: 0, encrypted: 0, reason: null }
    : { ok: false, dir: null, reason: opts.skipRepo === true ? 'skipped' : 'repo-not-found' };

  const shells = [];
  let belowLimit = 0;
  for (const f of candidates) {
    belowLimit++;
    const info = inspectSessionFile(f.file, { sizeLimit: limit });
    if (info.shell !== true) continue;
    // ⚠️ `shell: true` 必须带上：judgeShellSessions / renderShellSessionSection 都以它做过滤，
    //   漏了会表现为「shellCount 有值、报告段却是 0 个」（2026-09-14 首次冒烟实测）。
    const rec = { sessionId: f.sessionId, file: f.file, shell: true, bytes: info.bytes, events: info.events, hasTurnStart: info.hasTurnStart, frames: info.frames, reason: info.reason, probeError: info.probeError, repo: null };
    if (repoDir && f.root === 'sessions') {
      const rel = path.relative(sessionsRoot, f.file);
      const repoFile = rel && !rel.startsWith('..') ? path.join(repoDir, rel) : null;
      let st = null;
      try { st = repoFile ? fs.statSync(repoFile) : null; } catch { st = null; }
      if (st && st.isFile()) {
        repo.checked++;
        const enc = looksEncrypted(repoFile);
        if (enc) { repo.encrypted++; rec.repo = { exists: true, bytes: st.size, encrypted: true, file: repoFile }; }
        else rec.repo = { exists: true, bytes: st.size, encrypted: false, file: repoFile };
      } else { repo.missing++; rec.repo = { exists: false, bytes: null, encrypted: false, file: repoFile }; }
    }
    shells.push(rec);
  }
  return { ok: true, scanned: active.length, belowLimit, shells, repo };
}

/** 一步到位：采集 + 判定 + 报告段（CLI 与将来的 collect 接线共用）。 */
export function evaluateShellSessions(opts = {}) {
  const collected = collectShellSessions(opts);
  const event = judgeShellSessions(collected, opts);
  return { collected, event, reportLines: renderShellSessionSection(collected, opts) };
}
