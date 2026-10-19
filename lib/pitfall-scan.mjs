// dsh-butler / lib/pitfall-scan.mjs —— P4 会话扫描：两棵树 + 多帧 zstd + 增量记账 + 健康检查
//
// 方案 §4 P4「数据流」+「扫描范围铁律」：
//   ① 两棵树：sessions\** + ~\.dsh\_archived-sessions\**（归档区是富矿，且持续增量）
//   ② 记账按 sessionId 不按路径：归档时文件从 sessions 移到 _archived-sessions，
//      若 seq 记账绑路径 → 归档后重复全扫。记账键 = sessionId。
//   ③ 健康检查同范围：同一批解码顺带验 zstd 帧 magic + JSONL 完整性（零额外 IO）
//   ④ A14 spike 实测（2026-09-09）：copyFileSync / cpSync(preserveTimestamps) / rename 同卷 /
//      两段式 copy+unlink 四种方式 mtime 全部保留 → mtime 可作廉价预筛，但**不能当唯一判据**
//      （同步盘/重写工具会改 mtime）。判据 = bytes 为主 + lastSeq，mtime 只用于"完全未变"快路径。
//   ⑤ 会话文件名判据 = **认全世代**（2026-09-24 卡「三机同步步A-V3代际适配」）：主包 0.1.5 起落盘名
//      `session.jsonl.zstd` → `session.v3.jsonl.zstd`；原来"只认旧名 + 精确比较"⇒ 活跃树 212 个会话
//      全部失明（实测活跃 0 / archived 1068）。判据真源 = tools\lib\session-file-name.mjs。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

import { classifyError, categorize, signatureOf } from './pitfall-sign.mjs';
// 宿主适配层副本（唯一源 tools\lib\host-adapter.mjs；P1 收敛 2026-09-15）——主包事件名不在此处出现（R4）
import { EV } from './host-adapter.mjs';
// 会话文件名判据真源（唯一源 tools\lib\session-file-name.mjs）——2026-09-24 卡「三机同步步A-V3代际适配」
import {
  SESSION_FILE_NAME_LEGACY, SESSION_FILE_NAME_CURRENT, SESSION_FILE_RE,
  isSessionFileName, sessionFileGeneration,
} from './session-file-name.mjs';
export {
  SESSION_FILE_NAME_LEGACY, SESSION_FILE_NAME_CURRENT, SESSION_FILE_RE,
  isSessionFileName, sessionFileGeneration,
};

export const PITFALL_SCAN_VERSION = '0.1.0';

/** zstd 帧 magic（方案数据流要求逐帧扫 magic）。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 会话文件名 —— ⚠️ **保留为旧世代名（历史消费者兼容），勿再拿它做比较**。
 *  2026-09-24（卡「三机同步步A-V3代际适配」）：主包 0.1.5 起落盘名换成 `session.v3.jsonl.zstd`，
 *  本文件原来"只认旧名 + 精确比较" ⇒ 活跃树 212 个会话全部看不见（实测 discoverSessionFiles 活跃 0 条）。
 *  现口径：读取侧一律 isSessionFileName()（认全世代）；需要代际用 sessionFileGeneration()（旧名=0）；
 *  写入侧用 SESSION_FILE_NAME_CURRENT。真源 = tools\lib\session-file-name.mjs。
 */
export const SESSION_FILE_NAME = SESSION_FILE_NAME_LEGACY;

/** 两棵树（顺序 = 扫描优先级；都不存在时返回空数组，不报错）。 */
export function sessionRoots(home) {
  return [
    { root: 'sessions', dir: path.join(home, 'sessions') },
    { root: 'archived', dir: path.join(home, '_archived-sessions') },
  ];
}

/** 本机标识（坑库跨机同步时区分来源）。 */
export function deviceName() {
  try { return os.hostname() || 'unknown-host'; } catch { return 'unknown-host'; }
}

/**
 * 枚举两棵树里的会话文件。
 * 读取侧判据 = isSessionFileName()（**认全世代**：旧名 `session.jsonl.zstd` + v3 名 `session.v3.jsonl.zstd`）。
 * ⚠️ 同一会话目录两代并存时会各出一条（本函数语义 = "枚举文件"，与 PS 侧 Count-Sessions / 落地器
 *    countLocalSessions 的"数文件"口径保持一致）。
 * @param {string} home ~/.dsh
 * @returns {{sessionId:string, file:string, name:string, generation:number, root:'sessions'|'archived', bytes:number, mtimeMs:number}[]}
 */
export function discoverSessionFiles(home) {
  const out = [];
  for (const { root, dir } of sessionRoots(home)) {
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        if (!isSessionFileName(e.name)) continue;
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (!st.isFile()) continue;
        out.push({
          sessionId: path.basename(path.dirname(full)),
          file: full,
          name: e.name,
          generation: sessionFileGeneration(e.name),
          root,
          bytes: st.size,
          mtimeMs: Math.round(st.mtimeMs),
        });
      }
    }
  }
  return out;
}

/**
 * 多帧 zstd 解码（node:zlib zstdDecompressSync 只解第一帧 → 必须按 magic 切帧）。
 * @param {Buffer} buf
 * @returns {{text:string, frames:number, frameErrors:{frame:number,offset:number,bytes:number,error:string}[], empty:boolean}}
 */
export function decodeZstdFrames(buf) {
  const offsets = [];
  let i = 0;
  while (i < buf.length) {
    const at = buf.indexOf(ZSTD_MAGIC, i);
    if (at < 0) break;
    offsets.push(at);
    i = at + ZSTD_MAGIC.length;
  }
  const parts = [];
  const frameErrors = [];
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)));
    } catch (e) {
      frameErrors.push({ frame: k, offset: start, bytes: end - start, error: e?.message ?? String(e) });
    }
  }
  const text = Buffer.concat(parts).toString('utf8');
  return { text, frames: offsets.length, frameErrors, empty: offsets.length === 0 };
}

/** 递归收集 message content 里的文本块。 */
function collectText(blocks) {
  const out = [];
  const walk = (arr) => {
    for (const b of arr ?? []) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
      if (Array.isArray(b.content)) walk(b.content);
    }
  };
  walk(blocks);
  return out.join('\n');
}

/**
 * 从已解码文本中提取工具错误事件（增量：只处理 seq > sinceSeq）。
 * @param {{text:string, sessionId:string, sinceSeq?:number, fixture?:object, device?:string}} opts
 * @returns {{errors:object[], maxSeq:number, stats:object}}
 */
export function extractToolErrors(opts) {
  const { text, sessionId } = opts;
  const sinceSeq = Number(opts.sinceSeq ?? -1);
  const fixture = opts.fixture;
  const device = opts.device ?? deviceName();
  const errors = [];
  const calls = new Map();
  let maxSeq = sinceSeq;
  let lines = 0;
  let badLines = 0;
  let toolResults = 0;
  let toolCalls = 0;
  let excludedCount = 0;

  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    lines++;
    let ev;
    try { ev = JSON.parse(line); } catch { badLines++; continue; }
    const seq = Number(ev?.seq ?? NaN);
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
    const type = ev?.type;
    if (type !== EV.TOOL_CALL && type !== EV.TOOL_RESULT) continue;
    if (Number.isFinite(seq) && seq <= sinceSeq) continue;

    const d = ev?.data ?? {};
    if (type === EV.TOOL_CALL) {
      toolCalls++;
      calls.set(d.callId ?? d.id ?? '', { name: d.name ?? '', args: typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? '') });
      continue;
    }
    toolResults++;
    const blocks = d?.message?.content;
    const hasErrorFlag = Array.isArray(blocks) && blocks.some((c) => c?.isError === true);
    const hasErrorObj = d?.error && typeof d.error === 'object';
    if (!hasErrorFlag && !hasErrorObj) continue;

    const callId = d?.message?.source?.callId ?? d?.toolCallId ?? d?.callId ?? '';
    const call = calls.get(callId);
    const errObj = d?.error ?? {};
    const errText = collectText(blocks) || String(d?.error?.message ?? '');
    const evt = {
      sessionId,
      device,
      seq: Number.isFinite(seq) ? seq : null,
      time: Number(ev?.time ?? 0) || null,
      tool: call?.name ?? '(unlinked)',
      argsHead: (call?.args ?? '').slice(0, 200),
      name: errObj.name ?? '',
      code: errObj.code ?? '',
      text: errText,
    };
    const cls = classifyError(evt, fixture);
    if (cls.excluded) { excludedCount++; continue; }
    const sig = signatureOf(evt);
    errors.push({
      ...evt,
      sigKey: sig.sigKey,
      id: sig.id,
      normText: sig.normText,
      // 分类只喂归一化文本（路径已去），避免路径关键词污染主题
      category: categorize({ tool: evt.tool, text: sig.normText, name: sig.name, code: sig.code }),
      excludeRule: cls.ruleId,
    });
  }
  return {
    errors,
    maxSeq,
    stats: { lines, badLines, toolCalls, toolResults, errorEvents: errors.length, excluded: excludedCount },
  };
}

/**
 * 增量计划：哪些文件需要（重）扫。
 * 快路径 = bytes 与 lastSeq 都没变（mtime 变化不触发重扫 —— A14：归档移动/同步会改 mtime 而内容不变）。
 * @param {ReturnType<typeof discoverSessionFiles>} files
 * @param {Record<string, {bytes:number, lastSeq:number}>} scanFiles 记账
 * @param {{full?:boolean}} [opts]
 */
export function planScan(files, scanFiles, opts = {}) {
  const todo = [];
  const skipped = [];
  for (const f of files) {
    const prev = scanFiles?.[f.sessionId];
    if (!opts.full && prev && Number(prev.bytes) === f.bytes) {
      skipped.push({ ...f, reason: 'bytes-unchanged', prevLastSeq: prev.lastSeq ?? -1 });
      continue;
    }
    todo.push({ ...f, sinceSeq: opts.full ? -1 : Number(prev?.lastSeq ?? -1) });
  }
  return { todo, skipped };
}

/**
 * 扫一遍本机两棵树（增量）。
 * @param {{home:string, scanFiles?:object, now?:number, fixture?:object, full?:boolean, maxFiles?:number}} opts
 * @returns {{
 *   files:object[], todo:object[], skipped:object[], errors:object[], health:object[],
 *   scanUpdates:object, stats:object, roots:object[]
 * }}
 */
export function scanHome(opts) {
  const home = opts.home;
  const now = opts.now ?? Date.now();
  const device = deviceName();
  const files = discoverSessionFiles(home);
  const { todo, skipped } = planScan(files, opts.scanFiles ?? {}, { full: opts.full });
  const batch = Number.isFinite(opts.maxFiles) && opts.maxFiles > 0 ? todo.slice(0, opts.maxFiles) : todo;

  const errors = [];
  const health = [];
  const scanUpdates = {};
  const stats = { scanned: 0, bytes: 0, frames: 0, frameErrors: 0, lines: 0, badLines: 0, toolResults: 0, excluded: 0, errors: 0, elapsedMs: 0 };
  const t0 = Date.now();

  for (const f of batch) {
    let buf;
    try { buf = fs.readFileSync(f.file); } catch (e) {
      health.push({ sessionId: f.sessionId, root: f.root, file: f.file, status: 'unreadable', error: e?.message ?? String(e), checkedAt: now });
      continue;
    }
    const dec = decodeZstdFrames(buf);
    const ex = extractToolErrors({ text: dec.text, sessionId: f.sessionId, sinceSeq: f.sinceSeq, fixture: opts.fixture, device });
    errors.push(...ex.errors);
    stats.scanned++;
    stats.bytes += buf.length;
    stats.frames += dec.frames;
    stats.frameErrors += dec.frameErrors.length;
    stats.lines += ex.stats.lines;
    stats.badLines += ex.stats.badLines;
    stats.toolResults += ex.stats.toolResults;
    stats.excluded += ex.stats.excluded;
    stats.errors += ex.errors.length;

    const status = dec.empty || dec.frameErrors.length ? 'corrupt' : (ex.stats.badLines > 0 ? 'warn' : 'ok');
    health.push({
      sessionId: f.sessionId, root: f.root, file: f.file, bytes: f.bytes,
      frames: dec.frames, frameErrors: dec.frameErrors.length, frameErrorDetail: dec.frameErrors.slice(0, 3),
      lines: ex.stats.lines, badLines: ex.stats.badLines, status, checkedAt: now,
    });
    scanUpdates[f.sessionId] = {
      file: f.file, root: f.root, bytes: f.bytes, mtimeMs: f.mtimeMs,
      lastSeq: ex.maxSeq, scannedAt: now, device,
    };
  }

  // 已跳过（内容未变）的文件也要保记账路径最新（归档移动后路径变化不影响判据，但面板要显示对）
  for (const f of skipped) {
    const prev = opts.scanFiles?.[f.sessionId];
    scanUpdates[f.sessionId] = {
      file: f.file, root: f.root, bytes: f.bytes, mtimeMs: f.mtimeMs,
      lastSeq: prev?.lastSeq ?? -1, scannedAt: prev?.scannedAt ?? now, device, skipped: true,
    };
  }

  stats.elapsedMs = Date.now() - t0;
  return { files, todo, skipped, errors, health, scanUpdates, stats, roots: sessionRoots(home), device };
}
