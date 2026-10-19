// DSH / tools/lib/session-mirror-shell-guard.mjs —— 镜像侧「空壳不得覆盖完整版」守卫（同步拓扑 M3 · R4）
//
// 真源方案：`docs\同步拓扑重构-仓2退役与mirror-host中枢-方案-20260923.md` §5 阶段 0b · M3 行：
//   「镜像侧加"空壳不得覆盖完整版"守卫（R4）。**判据必须与仓2 侧同源（B-5）**：
//     复用同源纯函数，**禁止另造一套**」
//
// ═══════════════════════════════════════════════════════════════════════════════
// 🔒 判据的**唯一来源** = `tools\dsh-butler\lib\shell-session-watch.mjs`
//    （其文件头明写「判据与 AT2 同源」：逐条复刻 `tools\dsh-backup-sessions.ps1` 的
//      `Test-ShellSessionFile` / `Test-SkippedShell` —— 卡 8fd47fe1「仓2 采集加空壳守卫」
//      2026-09-14 定案；AT2 口径三条 + 两个保守分支，本模块**只引用、不复刻**）：
//      · 判据①（size-gate）文件 ≥ 2 KB ⇒ 视为有内容、**连解压都不做** → SHELL_SIZE_LIMIT
//      · 判据② 逐帧解后事件数 < 3 ⇒ 空壳                          → judgeShellFile → 'few-events'
//      · 判据③ 逐帧解后没有 turn/start ⇒ 空壳                      → judgeShellFile → 'no-turn-start'
//      · 保守分支 A：探针不可用（node 缺失 / 解不开 / 调用失败）⇒ 按空壳
//      · 保守分支 B：读不到文件（stat 失败）⇒ 不算空壳（AT2 同：missing 不判空壳）
//      · 「本地空壳 / 对端那份更大」= `isMismatchShell`（逐条复刻 AT2 `Test-SkippedShell`：
//        LocalLen < 2KB && LocalIsShell && RemoteLen > LocalLen）
//    ⚠️ 本模块**不复制**任何判据实现、**不自造**任何阈值常量 —— 一律 import 复用（复制 = 下次口径漂移的种子）。
//    ⚠️ 必须**逐帧解**：会话文件是多帧 zstd 拼接（append-only），只解首帧会把完整会话误判成空壳
//       （AT2 卡实测反例；`inspectSessionFile` 走 `decodeZstdFrames` 逐帧解，本模块只调它）。
//
// 本模块只做三件事：① 候选筛选（会话树 + 会话日志文件名 + < 2KB）
//                    ② 判定薄封装（镜像侧调用点：`judgeShellOverwrite` / `guardShellOverwrite`）
//                    ③ 记账渲染（`renderShellGuardLines` —— 推送结果里可见 skipped 原因）
// 远端那份的大小探测（SSH）**由调用方注入** ⇒ 本模块不碰网络、不碰 SSH，可离线单测。
// ═══════════════════════════════════════════════════════════════════════════════
//
// 用法（调用方 = `tools\dsh-session-mirror.mjs` 推送分支）：
//   const guard = await guardShellOverwrite(todo, { probeRemote });
//   const todo2 = todo.filter((f) => !guard.blockedRels.has(f.rel));
//   for (const line of renderShellGuardLines(guard)) log(line);
import path from 'node:path';

import { inspectSessionFile, isMismatchShell, SHELL_SIZE_LIMIT } from './shell-session-watch.mjs';
// 会话日志文件名判据的**单一真源**（认全世代：session.jsonl.zstd / session.vN.jsonl.zstd）
import { isSessionFileName } from './session-file-name.mjs';

export const SHELL_GUARD_VERSION = '0.1.0';

/** 会话树白名单前缀（相对 `~\.dsh`）：附件与其它文件一律不参与判定 */
export const SESSION_TREE_PREFIXES = Object.freeze(['sessions/', '_archived-sessions/']);

/** 相对路径是否落在会话树内（`sessions/…` 或 `_archived-sessions/…`）。 */
export function isSessionTreeRel(rel) {
  const r = String(rel ?? '').replace(/\\/g, '/');
  return SESSION_TREE_PREFIXES.some((p) => r.startsWith(p));
}

/**
 * 候选筛选（纯函数）：会话树内 + **会话日志文件名**（唯一真源 isSessionFileName）+ size < 2 KB。
 * 只判「小文件」候选 —— 判据① 已成立的会话（≥ 2 KB）不进这道闸（省一次远端探测）。
 * @param {{rel?:string, abs?:string, size?:number}} file
 */
export function isShellGuardCandidate(file) {
  if (!file) return false;
  if (!isSessionTreeRel(file.rel)) return false;
  if (!isSessionFileName(path.posix.basename(String(file.rel).replace(/\\/g, '/')))) return false;
  const size = Number(file.size);
  if (!Number.isFinite(size)) return false;
  return size < SHELL_SIZE_LIMIT;                       // 判据①（同源常量，不自造）
}

/**
 * 单文件守卫判定 —— **镜像侧调用点**（判据全部来自同源模块）。
 *
 * 判定链（写死 · 短路式）：
 *   ① 本地非空壳（判据②③ 都不成立）        ⇒ 放行 `local-not-shell`
 *   ② 远端探测失败（`ok !== true`）         ⇒ **拒** `remote-probe-failed`   ← 保守分支（宁可少覆盖）
 *   ③ 远端无此文件（`exists !== true`）     ⇒ 放行 `remote-missing`          ← 无覆盖发生
 *   ④ 远端存在但大小取不到（bytes 非数）    ⇒ **拒** `remote-size-unknown`   ← 保守分支
 *   ⑤ 同源判据命中（`isMismatchShell`）     ⇒ **拒** `remote-larger`         ← 本卡主判据
 *   ⑥ 其余                                  ⇒ 放行 `remote-not-larger`
 *
 * @param {string} localFile 本地会话文件绝对路径
 * @param {{ok?:boolean, exists?:boolean, bytes?:number|null, error?:string|null}} remote 远端那份的探测结果
 * @param {{info?:object, inspect?:Function}} [opts] `info` = 已算好的本地检查结果（省一次解压）
 * @returns {{blocked:boolean, mismatch:boolean, reason:string, localBytes:number,
 *            remoteBytes:number|null, localShell:boolean, localShellReason:string,
 *            remoteOk:boolean, remoteExists:boolean, remoteGate:string,
 *            localEvents:number|null, localFrames:number|null, localProbeOk:boolean}}
 */
export function judgeShellOverwrite(localFile, remote, opts = {}) {
  const inspect = opts.inspect ?? inspectSessionFile;
  const info = opts.info ?? inspect(localFile, opts);

  const localBytes = Number(info?.bytes ?? 0) || 0;
  const localShell = info?.shell === true;
  const remoteOk = remote?.ok === true;
  const remoteExists = remoteOk && remote?.exists === true;
  // ⚠️ 归一化必须显式挡 `null` / `''`：`Number(null) === 0`、`Number('') === 0` —— 天真写法会把
  //    「远端大小未知」当成「远端 0 字节」，从而走成"远端不比本机大 ⇒ 放行"（危险方向！）。
  const rawBytes = remoteExists ? remote?.bytes : null;
  const remoteBytes = (rawBytes === null || rawBytes === undefined || rawBytes === '')
    ? null
    : (Number.isFinite(Number(rawBytes)) ? Number(rawBytes) : null);

  const base = {
    localBytes,
    remoteBytes,
    localShell,
    localShellReason: String(info?.reason ?? 'unknown'),
    localEvents: Number.isFinite(Number(info?.events)) ? Number(info.events) : null,
    localFrames: Number.isFinite(Number(info?.frames)) ? Number(info.frames) : null,
    localProbeOk: info?.probeOk === true,
    remoteOk,
    remoteExists,
    // 「远端那份是不是完整版（判据① 意义）」：远端 ≥ 2 KB ⇒ 必然 > 本地空壳（本地必 < 2 KB）
    remoteGate: remoteExists
      ? (remoteBytes === null ? 'unknown' : (remoteBytes >= SHELL_SIZE_LIMIT ? 'has-content(size-gate)' : 'below-size-gate'))
      : 'absent',
  };

  // ⚠️ 同源判据（唯一来源）：remoteBytes 为 null 时它自身返回 false（= 仓2 侧语义「仓里没有 / 不比本机大」）
  const mismatch = isMismatchShell(localBytes, remoteBytes, localShell);

  if (localShell !== true) return { ...base, mismatch, blocked: false, reason: 'local-not-shell' };
  if (!remoteOk) return { ...base, mismatch, blocked: true, reason: 'remote-probe-failed' };
  if (!remoteExists) return { ...base, mismatch, blocked: false, reason: 'remote-missing' };
  if (remoteBytes === null) return { ...base, mismatch, blocked: true, reason: 'remote-size-unknown' };
  if (mismatch) return { ...base, mismatch, blocked: true, reason: 'remote-larger' };
  return { ...base, mismatch, blocked: false, reason: 'remote-not-larger' };
}

/** 候选数上限（超出 ⇒ **全部**保守拒绝、且不做任何远端探测）：防 SSH 风暴 + 防误推，方向永远朝"宁可少覆盖"。 */
export const DEFAULT_MAX_CANDIDATES = 20;

/** 拒绝原因 → 中文说明（记账用；写死，便于人读与单测断言）。 */
export const REASON_TEXT = Object.freeze({
  'remote-larger': '本地空壳 + 远端那份更大（完整版）⇒ 拒绝覆盖',
  'remote-size-unknown': '本地空壳 + 远端那份存在但大小取不到 ⇒ 保守拒绝（宁可少覆盖）',
  'remote-probe-failed': '本地空壳 + 远端探测失败 ⇒ 保守拒绝（宁可少覆盖）',
  'too-many-candidates': `本地空壳候选超过上限（${DEFAULT_MAX_CANDIDATES} 个）⇒ 全部保守拒绝（防 SSH 风暴 / 防误推）`,
  'remote-missing': '本地空壳 + 远端无此文件 ⇒ 放行（不构成覆盖）',
  'remote-not-larger': '本地空壳 + 远端不比本机大 ⇒ 放行（无可丢内容）',
  'local-not-shell': '本地非空壳（判据②③ 都不成立）⇒ 放行',
});

/**
 * 批量守卫（唯一入口）：先本地判空壳（零网络成本），**只对判为空壳的候选**做远端探测。
 * @param {Array<{rel:string, abs:string, size:number}>} files 本轮待推送清单
 * @param {{probeRemote?:(rel:string)=>Promise<{ok:boolean,exists:boolean,bytes:number|null,error?:string|null}>,
 *          inspect?:Function}} opts
 * @returns {Promise<{version:string, candidates:number, checked:number, blockedCount:number,
 *            allowedCount:number, blocked:Array, allowed:Array, blockedRels:Set<string>,
 *            summary:string}>}
 */
export async function guardShellOverwrite(files, opts = {}) {
  const inspect = opts.inspect ?? inspectSessionFile;
  const probeRemote = opts.probeRemote ?? (async () => ({ ok: false, exists: false, bytes: null, error: 'probeRemote 未注入' }));

  const candidates = (files ?? []).filter(isShellGuardCandidate);
  const max = Number.isFinite(Number(opts.maxCandidates)) && Number(opts.maxCandidates) > 0
    ? Number(opts.maxCandidates) : DEFAULT_MAX_CANDIDATES;
  const blocked = [];
  const allowed = [];

  // 保守分支 C：候选过多 ⇒ 全部拒绝、**不探测**（防 SSH 风暴；方向与 AT2 保守分支一致：宁可少覆盖）
  if (candidates.length > max) {
    for (const f of candidates) {
      blocked.push({
        rel: f.rel, localBytes: Number(f.size) || 0, remoteBytes: null,
        reason: 'too-many-candidates', mismatch: false, remoteGate: 'not-probed',
        localShellReason: 'not-probed', localEvents: null, localFrames: null, remoteError: null,
      });
    }
    blocked.sort((a, b) => (a.rel < b.rel ? -1 : 1));
    return {
      version: SHELL_GUARD_VERSION, candidates: candidates.length, checked: 0,
      blockedCount: blocked.length, allowedCount: 0, blocked, allowed,
      blockedRels: new Set(blocked.map((b) => b.rel)),
      conservativeAllBlocked: true,
      summary: `空壳守卫：候选 ${candidates.length} 个 > 上限 ${max} 个 ⇒ **全部保守拒绝**（本轮不做远端探测）`,
    };
  }

  for (const f of candidates) {
    const info = inspect(f.abs, {});
    if (info?.shell !== true) {
      const v = judgeShellOverwrite(f.abs, { ok: true, exists: false, bytes: null }, { info });
      allowed.push({ rel: f.rel, bytes: v.localBytes, reason: v.reason, remoteBytes: v.remoteBytes, mismatch: v.mismatch });
      continue;
    }
    let remote = null;
    try { remote = await probeRemote(f.rel); }
    catch (e) { remote = { ok: false, exists: false, bytes: null, error: e?.message ?? String(e) }; }
    const v = judgeShellOverwrite(f.abs, remote, { info });
    const row = {
      rel: f.rel, localBytes: v.localBytes, remoteBytes: v.remoteBytes,
      reason: v.reason, mismatch: v.mismatch, remoteGate: v.remoteGate,
      localShellReason: v.localShellReason, localEvents: v.localEvents, localFrames: v.localFrames,
      remoteError: remote?.error ?? null,
    };
    if (v.blocked) blocked.push(row);
    else allowed.push(row);
  }

  blocked.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  allowed.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const summary = candidates.length === 0
    ? '空壳守卫：无 <2KB 会话候选（本轮零影响）'
    : `空壳守卫：候选 ${candidates.length} 个（<2KB 会话文件）· 拒绝覆盖 ${blocked.length} 个 · 放行 ${allowed.length} 个`;

  return {
    version: SHELL_GUARD_VERSION,
    candidates: candidates.length,
    checked: candidates.length,
    blockedCount: blocked.length,
    allowedCount: allowed.length,
    blocked,
    allowed,
    blockedRels: new Set(blocked.map((b) => b.rel)),
    summary,
  };
}

/**
 * 记账渲染（推送结果里必须能被人看见 skipped 原因）—— 纯函数，返回可打印行。
 * 候选为 0 时也返回一行（让"守卫真跑过"在日志里可查）。
 * @param {object} result guardShellOverwrite 的返回值
 * @returns {string[]}
 */
export function renderShellGuardLines(result) {
  if (!result) return [];
  const lines = [`  ${result.candidates === 0 ? '✅' : (result.blockedCount ? '🛡' : '✅')} ${result.summary}`];
  for (const b of result.blocked) {
    lines.push(`    ⊘ 拒绝覆盖 ${b.rel}`);
    lines.push(`        本地 ${b.localBytes} B（判据=${b.localShellReason}${b.localEvents === null ? '' : ` / ${b.localEvents} 事件`}）· 远端 ${b.remoteBytes === null ? '大小未知' : `${b.remoteBytes} B`}（${b.remoteGate}）`);
    lines.push(`        原因 ${b.reason} —— ${REASON_TEXT[b.reason] ?? '（未登记）'}${b.remoteError ? ` · 探测错误 ${String(b.remoteError).slice(0, 120)}` : ''}`);
  }
  return lines;
}
