// dsh-butler / lib/paths.mjs —— 大管家路径解析（单点定义，全部组件共用）
//
// 为什么要有这一层：
//   1. 状态文件一律在 ~/.dsh 下（方案 §6.5），但单测必须能把整个 ~/.dsh 换成临时目录，
//      否则测试会污染生产状态。约定：BUTLER_DSH_HOME > DSH_HOME > os.homedir()/.dsh。
//   2. junction / 实体化迁移后 import.meta.url 可能解析为物理路径，所有"路径相等"判断
//      必须走 realpath（persona 铁律），本模块统一提供。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 组件根目录（本文件位于 <root>/lib/paths.mjs）。realpath 兜住 junction 场景。 */
export const COMPONENT_ROOT = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    return fs.realpathSync(path.join(here, '..'));
  } catch {
    return path.resolve(path.join(here, '..'));
  }
})();

/** schema 迁移脚本目录（migrate-<state>-v<from>-to-v<to>.cjs） */
export const MIGRATIONS_DIR = path.join(COMPONENT_ROOT, 'migrations');

/** 审计规则目录（[2b] P5 填具体规则；本轮为空 = 无拦截） */
export const RULES_DIR = path.join(COMPONENT_ROOT, 'rules');

/** 大管家状态根目录（~/.dsh）。测试用 BUTLER_DSH_HOME 隔离。 */
export function dshHome() {
  const override = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.dsh');
}

/** 常用子路径集中定义，禁止各脚本自己拼字符串。 */
export function butlerPaths(home = dshHome()) {
  return {
    home,
    locks: path.join(home, 'butler-locks'),
    auditDir: path.join(home, 'butler-audit'),
    alertLog: path.join(home, 'butler-alert.log'),
    versionFile: path.join(home, 'butler-version.json'),
    state: (name) => path.join(home, name),
  };
}

/** 状态文件绝对路径。 */
export function statePath(name, home = dshHome()) {
  return path.join(home, name);
}

/** 幂等建目录。 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 真实路径（不存在时返回 resolve 后的绝对路径），用于任何"路径相等"判断。 */
export function realOrResolve(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** 当前月份键（审计流水按月分文件 YYYY-MM.jsonl）。 */
export function monthKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 生成 runId / correlationId（方案 §3.7.3）。 */
export function newRunId(prefix = 'run') {
  const t = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${t}-${process.pid}-${r}`;
}
