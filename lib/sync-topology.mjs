/**
 * dsh-butler / lib/sync-topology.mjs —— 跨机同步「统一开关文件」的**唯一读取器**
 *
 * 真源（方案态 · 已过第三轮独立复审「具备落卡条件」）：
 *   `docs\方案-跨机骨架三柱与统一开关-20261010-v2.md`
 *     · §5.1 键形状（**已删假开关 `audit.weeklyAt`** —— 到期判定只读 `JOBS.at`/`days`/`window`，写它改不动调度）
 *     · §5.2 fail-open / fail-closed 取舍（**逐入口写死**，本文件的判据表逐行照它实现）
 *     · §5.3 不跨机同步（本文件读的那个开关文件**禁止进任何仓**；登记在 `lib/state-files.mjs` `sync:false`）
 *     · §5.4 四入口落点（**接线不在这里** —— 接线属卡 S1b；本文件只提供读取与判据）
 *
 * ## 为什么单独立件（「唯一读取器」的字面意思）
 * 同一份开关要被 **node 侧**（`hot-collect.mjs` / `dsh-session-mirror.mjs` 等）与 **PowerShell 侧**
 * （`dsh-sync-all.ps1` / `dsh-backup-sessions.ps1`）读。若两边各写一份解析 +
 * 各写一套"缺文件怎么办"，那"统一开关"就成了两份口径 —— 正是本方案要消灭的东西。
 * ⇒ **唯一实现落在此处**；PS 侧经本文件的 CLI 入口取值（`node lib/sync-topology.mjs --get repo2.push`），
 *   **不许**在 `.ps1` 里再写一份 `ConvertFrom-Json` 判据（S1b 接线时照此办）。
 *
 * ## fail 口径（v2 §5.2 逐行落地）
 * | 场景 | 取舍 | 本文件的落点 |
 * |---|---|---|
 * | 手工入口读不到开关（缺文件 / 缺字段 / 坏 JSON / 读不动） | **fail-open ⇒ 按各脚本现值执行 + 必须打印** | `readTopology()` 的 `source`/`reason` + `notices`，由调用方决定"现值" |
 * | `remoteSpace` 缺配置 | **fail-closed 到内置默认阈值（20 / 10 GiB）** | `resolveRemoteSpace()` 永远返回可用 targets（`fallback:true` 时给默认 + 打印） |
 * | 开关与 job 参数冲突（如 `repo2.push:false` 而 job 没带 `--skip-sessions`） | **取更严（停推优先）+ 打印不一致告警** | `mergeRepo2Push()`（纯函数） |
 * | fail-open 的真实语义（复审 §4.5 机制 3 第⑤环） | 总闸打开时「缺文件 ⇒ 按现值」= **本次会推仓2** | `NOTICE_*` 文案里**写清"本次会推仓2"**（否则"没打印 = 没生效"无法与"文件丢了"区分） |
 *
 * ⚠️ **本文件在本卡（S1）里没有任何生产调用方** —— 卡 S1 = "只新增、零行为变化"；
 *   四个入口的接线（含打印）属 **S1b**（主人 2026-10-11 夜拍 D9=(a)）。
 * ⚠️ **读取优先级（v2 §5.2 统一口径）**：`CLI 显式参数 > env（调试覆盖）> 开关文件 > 脚本默认`。
 *   本文件只负责**第三段**（开关文件）；env 层去留 = **D7 待拍** ⇒ 本文件**不读任何 env**
 *   （免自造开关；`--path` / `opts.path` 是**夹具注入点**，不是 env 层）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 相对 `~/.dsh` 的开关文件名（**路径写死**，见 v2 §5.1 与母本 A.2）。 */
export const TOPOLOGY_FILE_NAME = 'butler-sync-topology.json';

/** 开关文件 schema 版本（v2 §5.1 原文 `schemaVersion: 1`）。 */
export const TOPOLOGY_SCHEMA_VERSION = 1;

/** GiB（阈值单位换算用，不引入魔法数）。 */
const GIB = 1024 * 1024 * 1024;

/**
 * 各键默认值（= **脚本现值**，逐条附出处）。
 * ⚠️ 这些默认**只在开关文件里没有该键**时用于"报告/派生"，不改变任何脚本行为；
 *   `repo2.push` 取 `false` 的理由 = 现状即停推（`hot` job args 带 `--skip-sessions`、
 *   `handoff` Depart 默认 `skipSessions`、`dsh-sync-all.ps1` 的 `$SyncDisabled=$true`）
 *   —— 与方案 §6.5-D1「本鱼建议维持 false」一致（**D1 未拍**，故此处只与现状对齐）。
 *   📌 订正注（2026-10-14 · 卡「V2.9尾巴4」）：日报「📡 同步健康」段**已认此开关** ——
 *   `dsh-butler-panel\lib\checks.mjs#collectSync` 经本文件的 `repoPushForDir(dirName)` 取键，
 *   停推仓不再印「该 -Push」（此前该段只看本地 git ⇒ `repo2.push=false` 后天天误报，见
 *   `<workspace>\docs\交付报告-V2.9尾巴4-日报同步口径落地-20261014.md`）。
 */
export const TOPOLOGY_DEFAULTS = Object.freeze({
  repo1: Object.freeze({ push: true, pull: true }),
  repo2: Object.freeze({ push: false, pull: true }),
  repo3: Object.freeze({ push: true, pull: true }),
  // 脚本现值真源：`dsh-session-mirror.mjs`（`process.env.DSH_MIRROR_HOST || '…'` / `DSH_MIRROR_ROOT || '…'`）
  mirror: Object.freeze({
    host: process.env.DSH_MIRROR_HOST || 'mirror@example-host',
    root: process.env.DSH_MIRROR_ROOT || path.join(os.homedir(), 'dsh-session-mirror', 'local', '.dsh'),
  }),
  audit: Object.freeze({ enabled: true, sampleVerify: 3 }),
});

/**
 * 仓**工作副本目录名** → 开关文件里的**仓键**（映射的唯一真源）。
 * 为什么必须只有这一处：开关文件的键是 `repo1/repo2/repo3`（母本 §5.1 的键形状），
 * 而 BACKUP_ROOT 下的目录名是 `dsh-core/dsh-sessions/dsh-workspace` —— 两边对不上。
 * 若每个消费者（日报段、面板、脚本）各写一份映射，就是又造一套口径，正是本文件要消灭的东西。
 * ⚠️ 新增仓时必须改这一处（漏改的表现 = 该仓的 push 开关静默失效，判据退回"按现值"）。
 */
export const TOPOLOGY_REPO_OF_DIR = Object.freeze({
  'dsh-core': 'repo1',
  'dsh-sessions': 'repo2',
  'dsh-workspace': 'repo3',
});

/**
 * 按**工作副本目录名**取该仓的 push 开关（目录名无法识别 ⇒ `known:false`，调用方按"不判定"处理）。
 * @param {ReturnType<typeof readTopology>} t
 * @param {string} dirName 例如 `dsh-sessions`
 */
export function repoPushForDir(t, dirName) {
  const repo = TOPOLOGY_REPO_OF_DIR[dirName] ?? null;
  if (!repo) return { known: false, repo: null, push: null, fromFile: false, notices: [] };
  const r = resolveRepo(t, repo);
  return { known: true, repo, push: r.push, fromFile: r.pushFromFile, notices: r.notices };
}

/**
 * `remoteSpace` 的 **fail-closed 内置默认**（v2 §5.2 第 3 行 / §3.3 阈值）。
 * 语义 = 「这是**新增观察能力**，不存在"改变现行为"；反之若 fail-open 到"不告警"，这一柱等于没做」。
 * ⚠️ 接线（S3）时**必须**核对 `mirror.root` 的盘符与 `targets[].volume` 是否同一个盘（方案 §7.4 软肋 4）。
 */
export const REMOTE_SPACE_FALLBACK = Object.freeze({
  enabled: true,
  targets: Object.freeze([
    Object.freeze({
      host: TOPOLOGY_DEFAULTS.mirror.host,
      volume: 'D:',
      warnFreeBytes: 20 * GIB,
      alertFreeBytes: 10 * GIB,
    }),
  ]),
});

/** 打印文案（**逐句写死** · 单测断言 + S1b 复用；改文案即改口径）。 */
export const NOTICES = Object.freeze({
  /** v2 §5.2 第 1 行原文句（任何"读不到"情形的主句）。 */
  MISSING_FILE: '未找到同步拓扑开关文件，按现值执行',
  /** fail-open 真实语义（v2 §5.2 末行）：总闸打开时"按现值"就是**会推**，文案必须写清。 */
  WILL_PUSH_REPO2: '未找到同步拓扑开关文件，按现值执行（本次会推仓2）',
  /** v2 §5.4-③a/③b 原文句：读到 `false` 时的停推打印。 */
  SKIP_REPO2: '已按总开关跳过仓2（butler-sync-topology.json#repo2.push=false）',
  /** v2 §5.4-① 原文句：开关与 job 参数不一致 ⇒ 取更严。 */
  CONFLICT_JOB: 'topology 与 job 参数不一致：repo2.push=false 但未带 --skip-sessions ⇒ 本轮按停推执行',
  /** `repo2.push` 缺字段/类型不符时的打印（fail-open 主句 + 精确原因）。 */
  MISSING_FIELD: '同步拓扑开关文件缺少字段',
  /** `remoteSpace` 缺配置 ⇒ fail-closed 到内置默认（20 / 10 GiB）。 */
  REMOTE_SPACE_FALLBACK: 'remoteSpace 无有效配置 ⇒ 按内置默认阈值执行（warn 20 GiB / alert 10 GiB）',
});

/** 默认开关文件绝对路径：`<home>/.dsh/butler-sync-topology.json`。 */
export function topologyPath(opts = {}) {
  if (opts.path) return path.resolve(String(opts.path));
  const home = opts.home || os.homedir();
  return path.join(home, '.dsh', TOPOLOGY_FILE_NAME);
}

/** 逐字读取（返回 null = 文件不存在；抛错 = 读到一半失败）。 */
function readText(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined; // undefined = 读不动（区别于 null = 不存在）
  }
}

/** 内部：把"读不到"收敛成一个可判定的 source。 */
function classify(text) {
  if (text === null) return { source: 'missing', reason: 'missing' };
  if (text === undefined) return { source: 'invalid', reason: 'read-error' };
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { source: 'invalid', reason: 'bad-json', detail: String(e?.message ?? e).slice(0, 120) };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { source: 'invalid', reason: 'not-object' };
  return { source: 'file', reason: null, data };
}

/**
 * 读开关文件（**只读**，永不写）。
 * @param {{path?:string, home?:string}} [opts]
 * @returns {{
 *   path:string, ok:boolean, source:'file'|'missing'|'invalid', reason:null|'missing'|'read-error'|'bad-json'|'not-object',
 *   detail?:string, data:object|null, notices:string[]
 * }}
 */
export function readTopology(opts = {}) {
  const p = topologyPath(opts);
  const text = readText(p);
  const c = classify(text);
  const notices = [];
  if (c.source !== 'file') {
    notices.push(`${NOTICES.MISSING_FILE}（${reasonText(c)}：${p}）`);
    return { path: p, ok: false, source: c.source, reason: c.reason, detail: c.detail, data: null, notices };
  }
  return { path: p, ok: true, source: 'file', reason: null, data: c.data, notices };
}

/** 原因 → 人话（打印文案后半段）。 */
export function reasonText(c) {
  switch (c.reason) {
    case 'missing': return '缺文件';
    case 'read-error': return '读取失败';
    case 'bad-json': return `JSON 解析失败${c.detail ? '：' + c.detail : ''}`;
    case 'not-object': return '顶层不是对象';
    default: return '不可用';
  }
}

/**
 * 按点路径取键（**纯读**）。
 * 类型不符（如 `repo2.push` 写成 `"false"` 字符串）按**缺字段**处理 —— 宁可按现值 + 打印，也不猜值。
 * @param {object|null} data 开关文件解析结果（readTopology().data）
 * @param {string} dotted 例如 `repo2.push`
 * @param {'boolean'|'string'|'number'|null} [type] 期望类型（null = 不校验）
 * @returns {{present:boolean, value:*, path:string}}
 */
export function getKey(data, dotted, type = null) {
  const parts = String(dotted).split('.');
  let cur = data;
  for (const k of parts) {
    if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, k)) {
      return { present: false, value: undefined, path: dotted };
    }
    cur = cur[k];
  }
  if (type && typeof cur !== type) return { present: false, value: undefined, path: dotted };
  return { present: true, value: cur, path: dotted };
}

/**
 * 通用取值：开关文件优先，缺则用调用方给的**现值**（fail-open）+ 打印一行。
 * @param {ReturnType<typeof readTopology>} t
 * @param {string} dotted
 * @param {{type?:'boolean'|'string'|'number', fallback?:*, label?:string}} [o]
 * @returns {{value:*, fromFile:boolean, notices:string[]}}
 */
export function resolveKey(t, dotted, o = {}) {
  const notices = [];
  const hit = getKey(t.data, dotted, o.type ?? null);
  if (hit.present) return { value: hit.value, fromFile: true, notices };
  if (!t.ok) {
    // 文件本身不可用 ⇒ 主句已在 readTopology 的 notices 里（调用方负责打印），这里不重复刷屏
    return { value: o.fallback, fromFile: false, notices };
  }
  notices.push(`${NOTICES.MISSING_FIELD} ${dotted} ⇒ 按现值执行（${t.path}）`);
  return { value: o.fallback, fromFile: false, notices };
}

/** 仓 push/pull 取值（`repo1` / `repo2` / `repo3`）。 */
export function resolveRepo(t, repo) {
  const push = resolveKey(t, `${repo}.push`, { type: 'boolean', fallback: TOPOLOGY_DEFAULTS[repo]?.push });
  const pull = resolveKey(t, `${repo}.pull`, { type: 'boolean', fallback: TOPOLOGY_DEFAULTS[repo]?.pull });
  return {
    repo,
    push: push.value,
    pull: pull.value,
    pushFromFile: push.fromFile,
    pullFromFile: pull.fromFile,
    notices: [...push.notices, ...pull.notices],
  };
}

/** `mirror.host` / `mirror.root`（Z6：推中枢落点写死在此）—— 缺则用脚本现值。 */
export function resolveMirror(t) {
  const host = resolveKey(t, 'mirror.host', { type: 'string', fallback: TOPOLOGY_DEFAULTS.mirror.host });
  const root = resolveKey(t, 'mirror.root', { type: 'string', fallback: TOPOLOGY_DEFAULTS.mirror.root });
  return {
    host: host.value,
    root: root.value,
    fromFile: host.fromFile && root.fromFile,
    notices: [...host.notices, ...root.notices],
  };
}

/**
 * `remoteSpace` 解析（**fail-closed**：缺配置一律用内置默认阈值 + 打印，绝不退化成"不告警"）。
 * @returns {{enabled:boolean, targets:Array<object>, fallback:boolean, notices:string[]}}
 */
export function resolveRemoteSpace(t) {
  const notices = [];
  const rs = t.data && typeof t.data.remoteSpace === 'object' && t.data.remoteSpace ? t.data.remoteSpace : null;
  const enabled = rs && typeof rs.enabled === 'boolean' ? rs.enabled : REMOTE_SPACE_FALLBACK.enabled;
  const rawTargets = rs && Array.isArray(rs.targets) ? rs.targets : null;
  const targets = (rawTargets ?? []).map((x) => ({
    host: typeof x?.host === 'string' ? x.host : TOPOLOGY_DEFAULTS.mirror.host,
    volume: typeof x?.volume === 'string' ? x.volume : 'D:',
    warnFreeBytes: Number.isFinite(x?.warnFreeBytes) ? x.warnFreeBytes : REMOTE_SPACE_FALLBACK.targets[0].warnFreeBytes,
    alertFreeBytes: Number.isFinite(x?.alertFreeBytes) ? x.alertFreeBytes : REMOTE_SPACE_FALLBACK.targets[0].alertFreeBytes,
  }));
  const okTargets = targets.filter((x) => x.volume && Number.isFinite(x.warnFreeBytes) && Number.isFinite(x.alertFreeBytes));
  if (okTargets.length === 0) {
    notices.push(NOTICES.REMOTE_SPACE_FALLBACK);
    return {
      enabled,
      targets: REMOTE_SPACE_FALLBACK.targets.map((x) => ({ ...x })),
      fallback: true,
      notices,
    };
  }
  return { enabled, targets: okTargets, fallback: false, notices };
}

/** `audit.enabled` / `audit.sampleVerify`（🔴 `enabled:false` **只关核对判定与报告产物**，job 本体照起 —— 两个都要关）。 */
export function resolveAudit(t) {
  const enabled = resolveKey(t, 'audit.enabled', { type: 'boolean', fallback: TOPOLOGY_DEFAULTS.audit.enabled });
  const sample = resolveKey(t, 'audit.sampleVerify', { type: 'number', fallback: TOPOLOGY_DEFAULTS.audit.sampleVerify });
  return {
    enabled: enabled.value,
    sampleVerify: sample.value,
    enabledFromFile: enabled.fromFile,
    sampleVerifyFromFile: sample.fromFile,
    notices: [...enabled.notices, ...sample.notices],
  };
}

/**
 * `repo2.push` 的**最终判定**（v2 §5.2 第 1 行 + 第 5 行 · 纯函数，不接线）。
 *
 * 判据（顺序写死）：
 *   ① 开关文件显式给了 `repo2.push` ⇒ 以它为准；
 *   ② 文件缺该键 / 文件不可用 ⇒ **fail-open 按该入口现值**（`currentPush`，由调用方给：
 *      `hot` = false（job 带 `--skip-sessions`）/ 两个手工 `.ps1` = true）；
 *   ③ 与 job 参数**冲突**（`jobSkipSessions` 显式给出且与判定相反 / `filePush:false` 而没带 skip）⇒ **取更严（停推优先）+ 打印告警**。
 *
 * ⚠️ **总闸（`dsh-sync-all.ps1#$SyncDisabled`）不在这里** —— 它是主人 2026-09-24 亲令，**优先级最高、语义一字不改**
 *   （D2 建议保留），判定顺序 = 总闸 → 本函数。
 * @returns {{push:boolean, fromFile:boolean, stopped:boolean, notices:string[]}}
 */
export function mergeRepo2Push(t, o = {}) {
  const notices = [];
  const hit = getKey(t.data, 'repo2.push', 'boolean');
  const currentPush = o.currentPush !== undefined ? !!o.currentPush : false;
  const fromFile = hit.present;
  let push = fromFile ? hit.value : currentPush;

  // ② fail-open 的打印：必须写清"本次"到底推不推（复审 §4.5 机制 3 第⑤环）
  if (!fromFile) {
    notices.push(push ? NOTICES.WILL_PUSH_REPO2 : `${NOTICES.MISSING_FILE}（现值 = 本轮不推仓2）`);
  }

  // ③ 与 job 参数冲突 ⇒ 取更严（停推优先）
  if (o.jobSkipSessions !== undefined) {
    const jobSkips = !!o.jobSkipSessions;
    if (push === true && jobSkips === true) {
      push = false;
      notices.push('topology 与 job 参数不一致：repo2.push=true 但 job 带了 --skip-sessions ⇒ 本轮按停推执行（取更严）');
    } else if (push === false && jobSkips === false) {
      notices.push(NOTICES.CONFLICT_JOB);
    }
  }

  // ④ 读到 false ⇒ 停推打印（v2 §5.4-③a/③b 原文句）
  if (!push && fromFile && hit.value === false) notices.push(NOTICES.SKIP_REPO2);

  return { push, fromFile, stopped: !push, notices };
}

/** 把 notices 打出来（CLI 与调用方共用；批量与非 Silent 场景用）。 */
export function formatNotices(notices) {
  return (notices || []).filter(Boolean).join('\n');
}

// ───────────────────────────────────────── CLI（供 PowerShell 侧取值 · S1b 接线时用）
//
//   node lib/sync-topology.mjs --get repo2.push [--path <file>] [--json]
//   node lib/sync-topology.mjs --dump [--path <file>]          # 打印全部解析结果（人读）
//
// 退出码：0 = 从开关文件读到该键；3 = 未读到（fail-open，stdout 打的是**现值**）；
//        2 = 用法错；4 = 未知键。
// 约定：**值走 stdout**（便于 `.ps1` 捕获），**打印文案走 stderr**（v2 §5.2「无论走哪边都打印」）。
const KNOWN_KEYS = [
  'repo1.push', 'repo1.pull', 'repo2.push', 'repo2.pull', 'repo3.push', 'repo3.pull',
  'mirror.host', 'mirror.root', 'remoteSpace.enabled', 'remoteSpace.targets',
  'audit.enabled', 'audit.sampleVerify',
];

function cliValue(key, t) {
  if (key === 'remoteSpace.targets') return resolveRemoteSpace(t).targets;
  const hit = getKey(t.data, key);
  if (hit.present) return { present: true, value: hit.value };
  const fallbackMap = {
    'repo1.push': TOPOLOGY_DEFAULTS.repo1.push, 'repo1.pull': TOPOLOGY_DEFAULTS.repo1.pull,
    'repo2.push': TOPOLOGY_DEFAULTS.repo2.push, 'repo2.pull': TOPOLOGY_DEFAULTS.repo2.pull,
    'repo3.push': TOPOLOGY_DEFAULTS.repo3.push, 'repo3.pull': TOPOLOGY_DEFAULTS.repo3.pull,
    'mirror.host': TOPOLOGY_DEFAULTS.mirror.host, 'mirror.root': TOPOLOGY_DEFAULTS.mirror.root,
    'remoteSpace.enabled': REMOTE_SPACE_FALLBACK.enabled,
    'audit.enabled': TOPOLOGY_DEFAULTS.audit.enabled, 'audit.sampleVerify': TOPOLOGY_DEFAULTS.audit.sampleVerify,
  };
  return { present: false, value: fallbackMap[key] };
}

export function runCli(argv = process.argv.slice(2)) {
  const t = readTopology({ path: argv.includes('--path') ? argv[argv.indexOf('--path') + 1] : undefined });
  const emitNotices = (extra = []) => {
    const lines = [...t.notices, ...extra].filter(Boolean);
    if (lines.length) process.stderr.write(lines.join('\n') + '\n');
  };

  if (argv.includes('--dump')) {
    emitNotices();
    const dump = {
      path: t.path,
      ok: t.ok,
      source: t.source,
      reason: t.reason,
      repo1: resolveRepo(t, 'repo1'),
      repo2: resolveRepo(t, 'repo2'),
      repo3: resolveRepo(t, 'repo3'),
      mirror: resolveMirror(t),
      remoteSpace: resolveRemoteSpace(t),
      audit: resolveAudit(t),
    };
    process.stdout.write(JSON.stringify(dump, null, 2) + '\n');
    return 0;
  }

  const gi = argv.indexOf('--get');
  if (gi < 0) {
    process.stderr.write('用法：node lib/sync-topology.mjs --get <key> [--path <file>] [--json] | --dump\n'
      + `已知键：${KNOWN_KEYS.join(' / ')}\n`);
    return 2;
  }
  const key = String(argv[gi + 1] ?? '');
  if (!KNOWN_KEYS.includes(key)) {
    process.stderr.write(`未知键：${key}（已知：${KNOWN_KEYS.join(' / ')}）\n`);
    return 4;
  }
  const r = cliValue(key, t);
  const asJson = argv.includes('--json');
  if (!r.present) {
    emitNotices([`sync-topology: 未提供 ${key} ⇒ 输出脚本现值`]);
  } else {
    emitNotices();
  }
  process.stdout.write((asJson ? JSON.stringify(r.value) : String(r.value)) + '\n');
  return r.present ? 0 : 3;
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) process.exitCode = runCli();
