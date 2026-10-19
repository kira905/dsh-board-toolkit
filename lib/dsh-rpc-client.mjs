/**
 * DSH Host HTTP RPC 客户端 —— **可发布件** · 卡 S9（2026-10-16）从 `tools/lib/dsh-host-rpc.mjs` 拆出
 *
 * 拆分口径（方案 §3 步 2「三处刀口」④）：`dsh-host-rpc.mjs` = 「RPC 客户端件（token 由显式参数/env 注入）」
 *   + 「本机凭据解析件（不发布）」。本件 = **前者**：
 *   · 零 `fs`、零 `os`、零凭据路径写死、零家目录耦合（准入四条③）；
 *   · cookie 的三个来源，按优先级：
 *       ① 显式注入：`hostCookie(base, { cookieSecret })`（base64 secret）；
 *       ② env 注入：`DSH_RPC_COOKIE_SECRET`（base64 secret）；
 *       ③ **可选依赖**：同目录的本机凭据件 `./dsh-host-credential.mjs`（宿主专有 · **不发布**）——
 *          用 `createRequire` + try/catch **运行时探测**，宿主上拿到的就是拆分前那份密钥解析；
 *          公开环境该件不存在 ⇒ 视为「无本机凭据」（同拆分前"凭据文件读不到"的语义，**不静默改变别的行为**）。
 *   ⇒ 宿主侧行为与拆分前**逐字相同**（由卡 S9 的 J2 前后探针读数对照证明）。
 *
 * 背景（实测，见 docs\交付报告-旧HTTPAPI适配-20260922.md）：
 *   0.1.4 及以前：`POST /api/<ns>.<method>`，body = client-request 信封，payload = 业务参数对象；/api 无鉴权。
 *   0.1.5-rc.2：  ① 端点改为**路径段**形态 `POST /api/<ns>/<method>`；
 *                 ② method 字段必须与端点串**逐字相同**（`session/list`，不是 `session.list`）；
 *                 ③ payload 必须包一层 `{ args: { <wire 参数名>: <业务参数> } }`
 *                    —— wire 名逐端点不同（session/list 是 `_request`，多数是 `request`）；
 *                 ④ 整个 `/api` 通道加了 **cookie 鉴权门**：无 cookie 一律 401
 *                    （`dsh-auth-<sha256(authority)>`，HMAC-SHA256 签名）。
 *   旧点号路径在新线上返回 404；旧端点 `session.history` / `workspace.list` / `session.models`
 *   在 0.1.5 已**不存在**（404），替代见报告「待拍板」。
 *
 * 本模块提供的最小改动替换：
 *   const j = await hostRpc(BASE_URL, 'session.list', {});
 *   const items = j?.result?.value?.items ?? [];
 *
 * 兼容策略（双栈）：先按 0.1.5 新形态发；新形态不可用（404/401 且判为新线不可达）时**回落旧形态**，
 * 因此同一份代码在 0.1.4 与 0.1.5 上都能工作。
 *
 * 红线：**不硬编码 token、不关鉴权门**。宿主侧 cookie 由本机 `.credentials.yaml` 中
 * `records: client-connection/browser-session: payload.secret` 合法自签（经可选的本机凭据件）——
 * 与浏览器完成启动 token 交换后拿到的 cookie 同构（同一密钥、同一签名算法、同一 authority 绑定）。
 */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

/**
 * 端点表：旧点号方法名 → { endpoint, wire }。wire=null 表示该端点无参。
 *
 * 2026-09-23（拍板 D24）：补齐 0.1.5 新增面 **39 条**（45 → 84 条），与主包 register **逐条对齐** ——
 * 实测口径：主包 16 包 / 85 register 条目 / **84 去重端点** = 本表 84 条（缺口 0 · 表里多余 0 · wire 不符 0）。
 * 数据来源 = 各包 `lib/typert.host.js` 的 register 逐条解析（脚本 `_tmp/famidol-d24-20260923/probe-rpc-endpoints.mjs`）；
 * 纯加法，未改动任何既有条目与函数逻辑。详见 `docs/交付报告-D24-端点表补登-20260923.md`。
 */
export const ENDPOINT_TABLE = {
  'session.list': { endpoint: 'session/list', wire: '_request' },
  'session.search': { endpoint: 'session/search', wire: 'request' },
  'session.create': { endpoint: 'session/create', wire: 'request' },
  'session.page': { endpoint: 'session/page', wire: 'request' },
  'session.prompt': { endpoint: 'session/prompt', wire: 'request' },
  'session.rename': { endpoint: 'session/rename', wire: 'request' },
  'session.cancel': { endpoint: 'session/cancel', wire: 'request' },
  'session.fork': { endpoint: 'session/fork', wire: 'request' },
  'session.selectModel': { endpoint: 'session/selectModel', wire: 'request' },
  'session.updateQueue': { endpoint: 'session/updateQueue', wire: 'request' },
  'session.attachment': { endpoint: 'session/attachment', wire: 'request' },
  'session.openWorkspacePath': { endpoint: 'session/openWorkspacePath', wire: 'request' },
  'session.canOpenWorkspacePath': { endpoint: 'session/canOpenWorkspacePath', wire: null },
  'session.modelCatalog': { endpoint: 'session/modelCatalog', wire: null },
  'session.control': { endpoint: 'session/control', wire: null, stream: true },
  'session.follow': { endpoint: 'session/follow', wire: 'request', stream: true },
  'skills.list': { endpoint: 'skills/list', wire: 'request' },
  'fileReferences.list': { endpoint: 'fileReferences/list', wire: 'agentId' },
  'credentials.describe': { endpoint: 'credentials/describe', wire: 'refs' },
  'credentials.set': { endpoint: 'credentials/set', wire: 'ref' },
  'credentials.unset': { endpoint: 'credentials/unset', wire: 'ref' },
  'settings.describe': { endpoint: 'settings/describe', wire: null },
  'settings.update': { endpoint: 'settings/update', wire: 'ns' },
  'settings.replace': { endpoint: 'settings/replace', wire: 'ns' },
  'settings.mutate': { endpoint: 'settings/mutate', wire: 'ns' },
  'settings.openSettingsDocument': { endpoint: 'settings/openSettingsDocument', wire: null },
  'settings.openAgentPresetDirectory': { endpoint: 'settings/openAgentPresetDirectory', wire: 'agentPreset' },
  'settings.canOpenAgentPresetDirectory': { endpoint: 'settings/canOpenAgentPresetDirectory', wire: null },
  'directoryPicker.pick': { endpoint: 'directoryPicker/pick', wire: null },
  'directoryPicker.list': { endpoint: 'directoryPicker/list', wire: 'path' },
  'directoryPicker.createDirectory': { endpoint: 'directoryPicker/createDirectory', wire: 'path' },
  'workspace.create': { endpoint: 'workspace/create', wire: 'request' },
  'workspace.rename': { endpoint: 'workspace/rename', wire: 'request' },
  'workspace.delete': { endpoint: 'workspace/delete', wire: 'request' },
  'workspace.archiveSession': { endpoint: 'workspace/archiveSession', wire: 'request' },
  'workspace.insertBefore': { endpoint: 'workspace/insertBefore', wire: 'request' },
  'workspace.insertSessionBefore': { endpoint: 'workspace/insertSessionBefore', wire: 'request' },
  'workspace.follow': { endpoint: 'workspace/follow', wire: null, stream: true },
  'workspaceFiles.list': { endpoint: 'workspaceFiles/list', wire: 'workspaceFileScopeId' },
  'workspaceFiles.stat': { endpoint: 'workspaceFiles/stat', wire: 'workspaceFileScopeId' },
  'workspaceFiles.read': { endpoint: 'workspaceFiles/read', wire: 'workspaceFileScopeId' },
  'workspaceFiles.readAll': { endpoint: 'workspaceFiles/readAll', wire: 'workspaceFileScopeId' },
  'workspaceFiles.readBytes': { endpoint: 'workspaceFiles/readBytes', wire: 'workspaceFileScopeId' },
  'workspaceFiles.readRelated': { endpoint: 'workspaceFiles/readRelated', wire: 'workspaceFileScopeId' },
  'workspaceFiles.changes': { endpoint: 'workspaceFiles/changes', wire: 'workspaceFileScopeId', stream: true },

  // ── 0.1.5 新增 RPC 面（D24 · 2026-09-23 实测补齐）────────────────────────────────
  //    来源 = 主包各包 lib\typert.host.js 的 register 逐条解析（84 去重端点 vs 补齐前本表 45 条 ⇒ 缺口 39 条）；
  //    key 沿用旧点号约定（splitMethod 规则：点号 → 斜杠），wire 逐条实测（null = 该端点无参）。
  //    实测报告：docs\交付报告-D24-端点表补登-20260923.md · 取证脚本：_tmp\famidol-d24-20260923\
  // agentPresets（dsh-agent-presets）
  'agentPresets.copy': { endpoint: 'agentPresets/copy', wire: 'from' },
  'agentPresets.deletePreset': { endpoint: 'agentPresets/deletePreset', wire: 'id' },
  'agentPresets.list': { endpoint: 'agentPresets/list', wire: null },
  'agentPresets.read': { endpoint: 'agentPresets/read', wire: 'agentPreset' },
  'agentPresets.select': { endpoint: 'agentPresets/select', wire: 'agentId' },
  // commands（dsh-commands）
  'commands.execute': { endpoint: 'commands/execute', wire: 'agentId' },
  'commands.list': { endpoint: 'commands/list', wire: 'agentId' },
  // dynamicCordisRunner（dsh-cordis-host-runner）
  'dynamicCordisRunner.getClientCode': { endpoint: 'dynamicCordisRunner/getClientCode', wire: 'agentId' },
  'dynamicCordisRunner.inventory': { endpoint: 'dynamicCordisRunner/inventory', wire: null },
  'dynamicCordisRunner.invoke': { endpoint: 'dynamicCordisRunner/invoke', wire: 'pluginId' },
  'dynamicCordisRunner.reportClientGuardFailure': { endpoint: 'dynamicCordisRunner/reportClientGuardFailure', wire: 'agentId' },
  'dynamicCordisRunner.reportRenderFailure': { endpoint: 'dynamicCordisRunner/reportRenderFailure', wire: 'agentId' },
  'dynamicCordisRunner.resolveInspectQuery': { endpoint: 'dynamicCordisRunner/resolveInspectQuery', wire: 'agentId' },
  'dynamicCordisRunner.resolveRequestRun': { endpoint: 'dynamicCordisRunner/resolveRequestRun', wire: 'requestId' },
  'dynamicCordisRunner.runHostHalf': { endpoint: 'dynamicCordisRunner/runHostHalf', wire: 'agentId' },
  'dynamicCordisRunner.settleUserRun': { endpoint: 'dynamicCordisRunner/settleUserRun', wire: 'agentId' },
  'dynamicCordisRunner.stopFromPanel': { endpoint: 'dynamicCordisRunner/stopFromPanel', wire: 'agentId' },
  'dynamicCordisRunner.syncInspectManifest': { endpoint: 'dynamicCordisRunner/syncInspectManifest', wire: 'providers' },
  'dynamicCordisRunner.undefineFromPanel': { endpoint: 'dynamicCordisRunner/undefineFromPanel', wire: 'agentId' },
  // fileUploads（dsh-client-file-upload）
  'fileUploads.upload': { endpoint: 'fileUploads/upload', wire: 'agentId' },
  // goals（dsh-goal）
  'goals.clear': { endpoint: 'goals/clear', wire: 'agentId' },
  'goals.complete': { endpoint: 'goals/complete', wire: 'agentId' },
  'goals.create': { endpoint: 'goals/create', wire: 'agentId' },
  'goals.edit': { endpoint: 'goals/edit', wire: 'agentId' },
  'goals.get': { endpoint: 'goals/get', wire: 'agentId' },
  'goals.pause': { endpoint: 'goals/pause', wire: 'agentId' },
  'goals.resume': { endpoint: 'goals/resume', wire: 'agentId' },
  // llm（dsh-llm）
  'llm.discoverModels': { endpoint: 'llm/discoverModels', wire: 'settingsNs' },   // ⚠️ 与 REMOVED_ENDPOINTS 里的同名旧条目不同：那条是 0.1.4 旧契约，本条是 0.1.5 新契约（wire=settingsNs）
  'llm.listConfigurableProviders': { endpoint: 'llm/listConfigurableProviders', wire: null },
  'llm.listProviders': { endpoint: 'llm/listProviders', wire: null },
  // messageFeedback（dsh-message-feedback）
  'messageFeedback.delete': { endpoint: 'messageFeedback/delete', wire: 'request' },
  'messageFeedback.list': { endpoint: 'messageFeedback/list', wire: 'request' },
  'messageFeedback.put': { endpoint: 'messageFeedback/put', wire: 'request' },
  // pluginInventory（dsh-host-plugin-inventory）
  'pluginInventory.list': { endpoint: 'pluginInventory/list', wire: null },
  // sessionFeedback（dsh-command-feedback）
  'sessionFeedback.record': { endpoint: 'sessionFeedback/record', wire: 'request' },
  // sessionReferenceResolver（dsh-session-reference）
  'sessionReferenceResolver.candidates': { endpoint: 'sessionReferenceResolver/candidates', wire: 'agentId' },
  // subagents（dsh-subagent）
  'subagents.interruptByParent': { endpoint: 'subagents/interruptByParent', wire: 'childSessionId' },
  'subagents.list': { endpoint: 'subagents/list', wire: 'parentSessionId' },
  'subagents.prompt': { endpoint: 'subagents/prompt', wire: 'request' },
};

/** 0.1.5 已**移除**的旧端点（调用点必须改造，不能靠本层兼容）。 */
export const REMOVED_ENDPOINTS = new Set([
  'session.history',   // → 改用 session/page（需 throughSeq，见报告）
  'session.models',    // → 改用 session/modelCatalog
  'workspace.list',    // → 0.1.5 无一次性列表端点；替代 = `workspace/create {path}`（**幂等收养**：命中既有 ⇒ created:false 且零写操作）
                       //   2026-09-24 卡「插队归组-relay工作区读取重做」已按此改造 `session-relay.mjs#findWorkspaceForCwd`（三级：create → list → 本地 workspace.json）
  'llm.models', 'llm.providers', 'llm.discoverModels',
  'host.describe', 'host.listDirectory', 'host.createDirectory', 'host.pickDirectory', 'host.openPath',
  'agentPreset.list', 'agentPreset.read', 'agentPreset.select', 'agentPreset.copy', 'agentPreset.remove', 'agentPreset.openDocument',
  'subagent.list', 'subagent.history', 'subagent.prompt', 'subagent.interrupt',
  'goal.create', 'goal.edit', 'goal.pause', 'goal.resume', 'goal.complete', 'goal.clear',
  'command.execute',
]);

const COOKIE_CACHE = new Map();   // baseUrl|cookieSecretFp → { cookie, secretFp } | null
const WIRE_LEARNED = new Map();   // endpoint → wire 名（自适应学习；先探到就先赢）
const STACK_STATE = new Map();    // baseUrl → 'new' | 'legacy'  （首次探测成功后钉住）

const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

// ── 凭据来源：① 显式参数 ② env ③ **可选**本机凭据件（宿主专有 · 不发布）──────────────
const require_ = createRequire(import.meta.url);
/** 本机凭据件的**约定相对位置**（相对本文件）：宿主上存在、公开环境不存在。 */
const HOST_CREDENTIAL_MODULE = './dsh-host-credential.mjs';
let hostCredentialCache;
let hostCredentialLoaded = false;

/**
 * **可选依赖探测**：取本机凭据件（不存在 ⇒ null，不抛、不改变其它行为）。
 * 这是刀口②/④ 的既定刀法「可选依赖 + 注入」——公开件不写死任何凭据路径，
 * 只在宿主上"有就用"，公开环境靠显式参数/env 注入。
 */
export function hostCredentialModule() {
  if (!hostCredentialLoaded) {
    hostCredentialLoaded = true;
    try { hostCredentialCache = require_(HOST_CREDENTIAL_MODULE); } catch { hostCredentialCache = null; }
  }
  return hostCredentialCache;
}

/** 解析本次调用可用的 base64 签名密钥（显式 > env > 可选本机凭据件）；读不到 ⇒ undefined。 */
function resolveSecretB64(opts) {
  if (opts && typeof opts.cookieSecret === 'string' && opts.cookieSecret) return opts.cookieSecret;
  const env = process.env.DSH_RPC_COOKIE_SECRET;
  if (env && env.trim()) return env.trim();
  const mod = hostCredentialModule();
  if (mod && typeof mod.readSigningSecret === 'function') return mod.readSigningSecret();
  return undefined;
}

/** 密钥指纹（缓存分桶用）；读不到 ⇒ 'none'。自身绝不抛。 */
function secretFingerprint(opts) {
  try {
    const s = resolveSecretB64(opts);
    return s ? createHash('sha256').update(String(s)).digest('hex').slice(0, 16) : 'none';
  } catch { return 'none'; }
}

/**
 * 取 0.1.5 /api 通道的合法会话 cookie。无密钥（旧主包或未初始化）时返回 null → 调用方走旧形态。
 *
 * 密钥来源（优先级）：`opts.cookieSecret`（显式） > env `DSH_RPC_COOKIE_SECRET` > **可选**本机凭据件。
 * 缓存分桶键 = `baseUrl|密钥指纹`（拆分前是 `baseUrl|home`；语义等价 —— 同一密钥同一结果，
 * 密钥轮换/恢复时新键自动失效，比旧实现更准）。
 *
 * @param {string} baseUrl 形如 http://127.0.0.1:3080
 * @param {{maxAgeDays?: number, cookieSecret?: string}} [opts]
 * @returns {{name: string, value: string, header: string}|null}
 */
export function hostCookie(baseUrl, opts = {}) {
  const url = String(baseUrl).replace(/\/+$/, '');
  const fp = secretFingerprint(opts);
  const key = url + '|' + fp;
  if (COOKIE_CACHE.has(key)) return COOKIE_CACHE.get(key);
  let out = null;
  try {
    const authority = new URL(url).host;
    const secretB64 = resolveSecretB64(opts);
    if (secretB64) {
      const secret = Buffer.from(
        secretB64.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - secretB64.length % 4) % 4), 'base64');
      if (secret.length === 32) {
        const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest());
        const issuedAt = Date.now();
        const expiresAt = issuedAt + (opts.maxAgeDays ?? 30) * 86400_000;
        const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'));
        const sig = b64url(createHmac('sha256', secret).update(body).digest());
        const value = `v1.${body}.${sig}`;
        out = { name, value, header: `${name}=${value}` };
      }
    }
  } catch { out = null; }
  COOKIE_CACHE.set(key, out);
  return out;
}

/** 清掉 cookie 缓存（密钥轮换 / 测试用）。 */
export function clearCookieCache() { COOKIE_CACHE.clear(); }

function splitMethod(legacyMethod) {
  const table = ENDPOINT_TABLE[legacyMethod];
  if (table) return table;
  // 未登记：按通用规则点号 → 斜杠
  if (legacyMethod.includes('/')) return { endpoint: legacyMethod, wire: 'request' };
  const i = legacyMethod.indexOf('.');
  return i === -1
    ? { endpoint: legacyMethod, wire: 'request' }
    : { endpoint: legacyMethod.slice(0, i) + '/' + legacyMethod.slice(i + 1), wire: 'request' };
}

function post(baseUrl, pathname, body, cookie, timeoutMs, fetchImpl) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie.header;
  const doFetch = fetchImpl ?? fetch;
  return doFetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs ?? 20_000),
  });
}

const legacyEnvelope = (method, payload) => ({ type: 'client-request', rpcId: randomUUID(), method, payload });

/** 宽容地读响应体：真实 fetch 有 text()；测试夹具常只实现 json()。两者都支持。 */
async function readBody(res) {
  const fallback = (m) => ({ result: { ok: false, error: { code: 'parse', message: String(m).slice(0, 200) } } });
  try {
    if (typeof res.text === 'function') {
      const t = await res.text();
      try { return JSON.parse(t); } catch { return fallback(t); }
    }
    if (typeof res.json === 'function') return await res.json();
    return fallback('response has neither text() nor json()');
  } catch (e) { return fallback(e?.message ?? String(e)); }
}

/**
 * 调一个 Host RPC（兼容 0.1.4 与 0.1.5）。
 *
 * @param {string} baseUrl           如 http://127.0.0.1:3080
 * @param {string} legacyMethod      旧点号方法名，如 'session.list'
 * @param {object} payload           旧形态业务参数（旧代码原样传即可）
 * @param {{timeoutMs?: number, preferLegacy?: boolean, cookie?: string|null, fetchImpl?: Function}} [opts]
 * @returns {Promise<{status:number, body:any, request:string, wire:string|null}>}
 *          body 与旧 HTTP 响应同构：`{ type:'server-response', rpcId, result:{ ok, value|error } }`
 */
export async function hostRpc(baseUrl, legacyMethod, payload = {}, opts = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const { endpoint, wire: tableWire, stream } = splitMethod(legacyMethod);
  const timeoutMs = opts.timeoutMs;
  const fetchImpl = opts.fetchImpl;   // 可注入（测试夹具）；默认全局 fetch
  const cookie = opts.cookie === null ? null : (hostCookie(base) ?? null);
  const pinned = STACK_STATE.get(base);

  const tryLegacy = async () => {
    const res = await post(base, `/api/${legacyMethod}`, legacyEnvelope(legacyMethod, payload), null, timeoutMs, fetchImpl);
    return { status: res.status, body: await readBody(res), request: `/api/${legacyMethod}`, wire: null };
  };

  const tryNew = async (wireName) => {
    const args = wireName === null ? {} : { [wireName]: payload };
    const env = { type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } };
    const res = await post(base, `/api/${endpoint}`, env, cookie, timeoutMs, fetchImpl);
    return { status: res.status, body: await readBody(res), request: `/api/${endpoint}`, wire: wireName };
  };

  const errOf = (r) => r.body?.result?.error ?? (typeof r.body === 'object' ? r.body?.error : undefined);
  const isArgsMismatch = (r) => errOf(r)?.code === 'gateway/arguments-invalid' || errOf(r)?.code === 'gateway/bad-request';
  const missingWire = (r) => String(errOf(r)?.message ?? '').match(/missing "([^"]+)"/)?.[1];

  if (pinned === 'legacy' && !opts.preferLegacy) {
    // 已知本机主包是旧线：新形态试一次即可确认，仍优先新形态（兼容升级）
  }

  if (stream) {
    // 流式端点在 HTTP 一元载体上必然失败（gateway/signature-invalid）——直接给出可读错误
    if (tableWire === undefined) throw new Error(`${legacyMethod} 是流式端点，HTTP 一元载体不可用（需 WebSocket mux）`);
  }

  // ---- ① 新形态 ----
  let wireName = WIRE_LEARNED.get(endpoint) ?? (tableWire === undefined ? 'request' : tableWire);
  try {
    let r = await tryNew(wireName);
    if (r.status === 401 && cookie) { /* cookie 被拒：可能是 authority 不符 → 回落旧形态 */ }
    // 参数名不对：用错误信息里的 missing 名重试一次（自适应）
    if (r.status === 200 && isArgsMismatch(r)) {
      const miss = missingWire(r);
      if (miss && miss !== wireName) { wireName = miss; r = await tryNew(wireName); }
    }
    if (r.status === 200 && (r.body?.result?.ok === true || r.body?.result?.ok === false)) {
      WIRE_LEARNED.set(endpoint, wireName);
      STACK_STATE.set(base, 'new');
      return r;
    }
    // 新形态不可用（404=端点未注册 / 401=无鉴权门之外的拒绝 / 5xx）→ 试旧形态
    if (r.status === 404 || r.status === 401 || r.status === 405) {
      const old = await tryLegacy();
      if (old.status === 200 && old.body?.result !== undefined) {
        // 旧行未加 WIRE_LEARNED（不污染新线学习）
        STACK_STATE.set(base, 'legacy');
        return old;
      }
      return r; // 两边都不行：回报新形态结果（多数情况下信息更全）
    }
    return r;
  } catch (e) {
    // 网络异常：若旧形态可达则回落（旧主包的 /api 无鉴权，不会 401）
    try {
      const old = await tryLegacy();
      if (old.status === 200) { STACK_STATE.set(base, 'legacy'); return old; }
    } catch { /* ignore */ }
    throw e;
  }
}

/** 便捷封装：只要 JSON body（与旧 `await res.json()` 等价）。 */
export async function hostRpcJson(baseUrl, legacyMethod, payload = {}, opts = {}) {
  return (await hostRpc(baseUrl, legacyMethod, payload, opts)).body;
}

/** 便捷封装：取 result.value，失败抛（与旧工具 `rpc()` 助手语义一致）。 */
export async function hostRpcValue(baseUrl, legacyMethod, payload = {}, opts = {}) {
  const { status, body, request } = await hostRpc(baseUrl, legacyMethod, payload, opts);
  if (body?.result?.ok === true) return body.result.value;
  const err = body?.result?.error;
  throw new Error(`${legacyMethod} failed: HTTP ${status} ${err ? `${err.code}: ${err.message}` : JSON.stringify(body)?.slice(0, 200)} (${request})`);
}

/** 探测本机主包走的是哪条线：'new'(0.1.5+) | 'legacy'(<=0.1.4) | 'unknown'。 */
export async function detectStack(baseUrl, opts = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  try {
    const r = await hostRpc(base, 'session.list', {}, opts);
    if (r.status === 200 && r.body?.result?.ok === true) {
      return { stack: r.request === '/api/session/list' ? 'new' : 'legacy', request: r.request, wire: r.wire, ok: true };
    }
    return { stack: 'unknown', request: r.request, status: r.status, error: r.body?.result?.error ?? r.body?.error, ok: false };
  } catch (e) {
    return { stack: 'unknown', error: String(e?.message ?? e), ok: false };
  }
}

export default { hostRpc, hostRpcJson, hostRpcValue, hostCookie, detectStack, clearCookieCache, ENDPOINT_TABLE, REMOVED_ENDPOINTS };
