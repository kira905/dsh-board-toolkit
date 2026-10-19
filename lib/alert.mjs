// dsh-butler / lib/alert.mjs —— 大管家告警通道（独立于大管家自身组件）
//
// 方案 §5.1 不匹配处置 ②：告警通道必须独立于大管家自身组件（面板/日报自己掉队时也要能看见）。
// 本模块只用 node 内建 fs + stderr，不 import 面板/host/日报，也不写大管家状态文件：
//   - 落盘：~/.dsh/butler-alert.log（append-only 单行 JSON，供日后日报/守护鱼采集）
//   - 同步：stderr（谁调用谁可见，短命 tick 脚本的日志里就有）
// 后续可插拔通道（桌宠 / 守护鱼 notify / 企业微信）由调用方通过 addChannel() 注册，
// 但任何通道抛错都不得影响主流程。
import fs from 'node:fs';
import { butlerPaths, ensureDir } from './paths.mjs';

const channels = [];

/** 注册附加通道：fn(entry) 可抛错，会被吞掉。 */
export function addChannel(fn) {
  if (typeof fn === 'function') channels.push(fn);
  return () => {
    const i = channels.indexOf(fn);
    if (i >= 0) channels.splice(i, 1);
  };
}

/**
 * 发一条告警。
 * @param {{level?:'info'|'warn'|'error', source:string, message:string, detail?:object}} entry
 * @param {{home?:string, silent?:boolean}} [opts]
 * @returns {{ok:boolean, file:string, error?:string}}
 */
export function alert(entry, opts = {}) {
  const rec = {
    at: new Date().toISOString(),
    level: entry.level ?? 'warn',
    source: entry.source ?? 'butler',
    message: entry.message ?? '',
    detail: entry.detail ?? null,
  };
  const file = butlerPaths(opts.home).alertLog;
  let ok = true;
  let error;
  try {
    ensureDir(butlerPaths(opts.home).home);
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {
    ok = false;
    error = e?.message ?? String(e);
  }
  if (!opts.silent) {
    try {
      process.stderr.write(`[butler-alert][${rec.level}] ${rec.source}: ${rec.message}\n`);
    } catch { /* stderr 不可写就算了 */ }
  }
  for (const ch of channels) {
    try { ch(rec); } catch { /* 通道自身故障不影响主流程 */ }
  }
  return { ok, file, error };
}

/** 读取告警日志尾部（verify / 面板排障用）。 */
export function tailAlerts(limit = 20, opts = {}) {
  const file = butlerPaths(opts.home).alertLog;
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  } catch {
    return [];
  }
}
