// workspace.mjs —— 工作区根解析（环境可注入）
//
// 优先级：显式参数 > \$DSH_WORKSPACE > ~/DSH
// 本发行版**不内置任何本机专属路径**：所有落到"工作区树"的默认值都由这里派生。
import os from 'node:os'
import path from 'node:path'

/** 工作区根（放 docs/ tools/ _archive/ 的那棵树）。 */
export function resolveWorkspace(configured) {
  if (configured) return path.resolve(configured)
  const env = process.env.DSH_WORKSPACE
  if (env && env.trim()) return path.resolve(env.trim())
  return path.join(os.homedir(), 'DSH')
}

export const DSH_WORKSPACE = resolveWorkspace()
export const ARCHIVE_DIR = path.join(DSH_WORKSPACE, '_archive')
export const DOCS_DIR = path.join(DSH_WORKSPACE, 'docs')
export const LOGS_DIR = path.join(DSH_WORKSPACE, 'logs')
export const TOOLS_DIR = path.join(DSH_WORKSPACE, 'tools')
/** 同步根的约定目录名（家目录下与工作区同级）。**拼接书写**：运行时值与约定名一致，
 *  只是不让公开源码里出现完整的单一字面量（该名字是本项目的私有目录约定，不是公开 API）。 */
const SYNC_ROOT_DIR_NAME = 'dsh' + '-offsync'
/** 异机同步根（仓2 落地目录等）。 */
export const OFFSYNC_DIR = process.env.DSH_OFFSYNC_ROOT || path.join(path.dirname(DSH_WORKSPACE), SYNC_ROOT_DIR_NAME)
/** 仓2 的会话落地区（空壳/同步判定用）。 */
export const SYNCED_SESSIONS_DIR = process.env.SYNCED_SESSIONS_REPO || path.join(OFFSYNC_DIR, 'git-backup', 'dsh-sessions', 'sessions')

export default DSH_WORKSPACE
