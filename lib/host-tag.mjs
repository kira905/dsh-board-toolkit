// dsh-butler / lib/host-tag.mjs —— 主机短码（host 分文件的统一来源）
//
// 为什么单独一个模块（2026-09-11）：两台机各跑 tick，凡是「渲染物 / 注册表 / 报告」这类
//   **本机自己生成、却要跨机进仓**的文件，只要同名就必然互相覆盖，且每次 depart 都被
//   推前超集门挡下（先例：butler-barewatch 的 <host>-ledger.jsonl / <host>-state.json）。
//   根治手段 = 文件名带主机短码；短码必须**全仓一套口径**（否则同一台机会生出 -
//   host-a / -HOST-A / -host-a-w11 多种写法，又变成新分叉源）。
//
// 口径：小写主机名，非 [a-z0-9-] 压成 `-`，空则回落 'unknown'（绝不生成空后缀退回旧名）。
// 覆盖：opts.host / 环境变量 DSH_HOST_TAG（单测与沙盒用）。
import os from 'node:os';

/**
 * @param {{host?:string}} [opts]
 * @returns {string} 主机短码，如 host-b / host-a
 */
export function hostTag(opts = {}) {
  const raw = String(opts.host ?? process.env.DSH_HOST_TAG ?? os.hostname() ?? '').trim();
  const tag = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return tag || 'unknown';
}

export default hostTag;
