// ============================================================
//  dsh-home.mjs — DSH home 解析（测试环境支持，2026-09-11）
//  ------------------------------------------------------------
//  与主包 @deepseek-ai/dsh-home-paths 同源语义，优先级（2026-09-14 补齐 BUTLER_DSH_HOME）：
//      显式参数  >  $BUTLER_DSH_HOME  >  $DSH_HOME  >  ~/.dsh
//  （空 / 纯空白的取值视为未设置，避免解析到 cwd）
//
//  ⚠️ 与 dsh-butler/lib/paths.mjs 的 dshHome() 同一口径（那边是 BUTLER_DSH_HOME 优先、
//     依次回落到 DSH_HOME 再回落到 ~/.dsh）；本文件此前只认 DSH_HOME，对既有调用方
//     是"行为不变 + 多认一个环境变量"，不会改变任何默认路径。
//
//  用途：让部署/恢复脚本与运行期组件能被指向隔离的测试环境
//        （$env:DSH_HOME = '<offsync>\DSH-test\.dsh'），先把插件部署到测试
//        profile 验证通过，再部署到生产。
//
//  兼容性铁律：不设置任何环境变量时，返回的路径与改造前完全一致
//              （~/.dsh），因此对既有生产流程是零行为变化。
// ============================================================
import os from 'node:os'
import path from 'node:path'

/** 解析 DSH home 绝对路径。 */
export function resolveDshHome(configured) {
  if (configured) return path.resolve(configured)
  // 逐变量判定（2026-09-14 补）：空 / 纯空白取值一律视为「未设置」，逐级回落
  //   BUTLER_DSH_HOME → DSH_HOME → ~/.dsh（复用本文件 envValue()，不另造判定）。
  // 修的就是这个缺口：`process.env.A || process.env.B` 只挡得住**空串**——
  // 纯空白（'   '）是 truthy 会被当成"已设置"，而 `'   '.trim()` 又是空串 ⇒
  // 既不采信 BUTLER_DSH_HOME、也**跳过 DSH_HOME**，直接落回 `~/.dsh`（生产 home）。
  // 实测后果：测试/金丝雀场景里只要残留一个空白值，脚本就静默读写**生产**，
  // 而调用方以为自己在沙箱里（2026-09-14 实测：want 沙箱 / got <home>\.dsh）。
  const override = envValue('BUTLER_DSH_HOME') ?? envValue('DSH_HOME')
  if (override) return path.resolve(override)
  return path.join(os.homedir(), '.dsh')
}

/** web profile 目录（插件实体、package.json、.package-map.json 所在处）。 */
export function webProfileDir(configuredHome) {
  return path.join(resolveDshHome(configuredHome), 'profiles', 'web')
}

/**
 * 标记当前目标是不是测试环境（仅用于日志提示与安全自检）。
 * 判定：home 路径不等于默认的 ~/.dsh。
 */
export function isNonDefaultHome(configuredHome) {
  const def = path.join(os.homedir(), '.dsh')
  return path.resolve(resolveDshHome(configuredHome)) !== path.resolve(def)
}

/** 生产默认工作区（DSH 代码/文档树，2026-09-14 起可被环境变量改道）。 */
export const DEFAULT_DSH_WORKSPACE = path.join(os.homedir(), 'DSH')

/** 任意环境变量的非空取值（空串/纯空白视为未设置）。 */
function envValue(name) {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : null
}

/**
 * 解析 DSH 工作区根（放 docs\ 与管家报告的那棵树）。
 * 优先级：显式参数 > $DSH_WORKSPACE > 由 home 推导（**仅当 home 被环境变量重定向到
 * <某目录>\.dsh 这种"测试实例"形态时**）> <workspace>。
 * ⚠️ 判据必须是「env 显式指向了非默认 home」而不是"路径层数够"——生产 home 也是
 * `<home>\.dsh`（3 层），按层数判会把 workspace 错推成 `<home>`。
 */
export function resolveDshWorkspace(configured) {
  if (configured) return path.resolve(configured)
  const env = envValue('DSH_WORKSPACE')
  if (env) return path.resolve(env)
  const defaultHome = path.join(os.homedir(), '.dsh')
  const override = envValue('BUTLER_DSH_HOME') || envValue('DSH_HOME')
  if (override) {
    const home = path.resolve(override)
    if (home.toLowerCase() !== path.resolve(defaultHome).toLowerCase()
      && path.basename(home).toLowerCase() === '.dsh') {
      return path.resolve(path.dirname(home))
    }
  }
  return DEFAULT_DSH_WORKSPACE
}

/** 管家日报/周报输出目录（$BUTLER_REPORT_DIR 已有先例，2026-09-12 起用于端到端夹具）。 */
export function resolveReportDir(configured) {
  if (configured) return path.resolve(configured)
  const env = envValue('BUTLER_REPORT_DIR')
  if (env) return path.resolve(env)
  return path.join(resolveDshWorkspace(), 'docs', '管家报告')
}

/** 变更流水目录（<workspace>\docs\变更流水）。 */
export function resolveChangelogDir(configured) {
  if (configured) return path.resolve(configured)
  return path.join(resolveDshWorkspace(), 'docs', '变更流水')
}
