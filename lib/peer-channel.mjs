#!/usr/bin/env node
// tools/lib/peer-channel.mjs —— 「跨机传输类 job 的通道自查 + 按需短租」共用件
// （卡：大管家 · 愿景实体核查 R9 · 2026-10-14）
//
// ── 它解决什么 ─────────────────────────────────────────────────────────────────
// 给「主机 A → mirror-host」（或任意 peer）的**传输类 tickd job** 提供同一套通道动作：
//   ① 先试调用方给的候选通道（缺省语义 = 局域网直连优先 → VPS 中继隧道回落）；
//   ② 全不通 ⇒ **按需短租**：`relay-cli enable` + `up`，通了就跑活；
//   ③ 收尾 `releasePeerChannel()` —— **只关"本次由我开的"**（别人手动开的 / 本来已 enable 的，一律不碰）；
//   ④ 租约落盘 `~/.dsh/relay/short-lease.json` ⇒ 给"进程被杀 / 机器断电，隧道挂过夜"留一个回收抓手
//      （`reclaimStaleLease()` 或 CLI `reclaim`）。
//
// ── 为什么不重造一套判据 ───────────────────────────────────────────────────────
// `tools\dsh-butler\mem-sync-tick.mjs`（memory-sync job）自 2026-10-11 起**已有**同款短租
// （lan → tunnel → enable+up → 跑完 down），本模块就是把它那段**抽出来共用**；
// 而 `tools\dsh-session-mirror.mjs`（session-mirror / mirror-audit job）此前只有"择路"、**没有"开的动作"**
// ⇒ 本机在公司有线网（lan 不可达 + 隧道默认关）时**每轮必然让路**（2026-10-14 实测：断链 28 小时、
// `consecutiveUnreachable=14`；手动 enable+up 后一轮即通、补推 243 个 / 122.2 MB）。
//
// 「只关自己开的」在本模块里做**严一档**（比 mem-sync 现版严）：
//   · `enabledBefore === true`（别人已声明要开 —— relay-ondemand / 主人手动）⇒ 我们只 `up` 不 `down`；
//   · 只有"本来 `enabled=false`、本轮由我 `enable+up` 起来的那次"才 `down`。
//
// ── 与 `tools\relay\relay-ondemand.mjs` 的关系（判决体一个字没动）──────────────
// relay-ondemand 判的是「**连续/密集跨机消息**」（K=3 条 / N=10 分钟）⇒ 它**认不出传输类 job 的需求**。
// 本模块不复制它的判决、也不改它：两者**都只调 `relay-cli.mjs` 的 CLI**（enable/up/down/status），互不越权：
//   · relay-ondemand `manageExternal=false` ⇒ 不动"不是它开的"隧道（含本模块开的）；
//   · 本模块 `enabledBefore` 记账 ⇒ 不动"已经开着的"（含 relay-ondemand / 主人开的）。
//
// ── 一键关回（关掉后行为**回到今天之前**：通道不通 ⇒ 让路，不碰隧道）─────────────
//   ① env `DSH_PEER_SHORT_RENT=off`（临时/卡内）
//   ② 开关文件 `~/.dsh/relay/short-rent.json` 的 `enabled:false`
//      （写入入口 = `node <workspace>\tools\peer-channel-cli.mjs off --apply`；`status` 只读看档）
//   ③ 单次：调用方传 `allowRent:false`（如 `dsh-session-mirror.mjs --no-tunnel-rent`）
//   开关文件**缺失 = 默认开**（主人 2026-10-14 11:1x 已拍板做这件事；交付即生效，与 relay-ondemand 同口径）。
//
// ── 纪律（公司有线网 · 2026-10-11 主人令）──────────────────────────────────────
// 短租 = 「用前 enable+up、**用完立刻 down**」；**禁挂长时间/过夜**；**只关自己开的**。
// 判据 = 物理网卡 `Get-NetAdapter` 的 `MediaType=802.3 && Status=Up`（公司有线网）；
// 家里 wifi 等其余网络无此限（本模块不区分 —— 一律"用完即关"是更严的一侧，安全）。
//
// ── 设计约束 ───────────────────────────────────────────────────────────────────
// · **探针由调用方注入**（`probe(candidate) => {ok, err}`）—— 因为各 job 的 ssh 参数（密钥/超时/别名）
//   各不相同，模块**不写死任何别名、地址、密钥**（沿用 multi-host-status / dsh-session-mirror 的口径）。
// · 全同步（`spawnSync`）、零 npm 依赖 —— 与 mem-sync-tick / dsh-session-mirror 两个调用方一致。
// · 一切外部动作可注入（`relayCli` / `leaseFile` / `env` / `now` / `probe`）⇒ 夹具演练**不必碰生产**。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { TOOLS_DIR } from './workspace.mjs';
import { spawnSync } from 'node:child_process';

export const VERSION = 'peer-channel/0.1.0';

/** 一键关回：env（`off` / `0` / `false` / `no` ⇒ 关）。 */
export const ENV_SWITCH = 'DSH_PEER_SHORT_RENT';
/** 覆盖 relay-cli 路径（演练/换实现用）。 */
export const ENV_RELAY_CLI = 'DSH_PEER_RELAY_CLI';
/** 覆盖租约文件路径（演练用；**别在生产设**）。 */
export const ENV_LEASE_FILE = 'DSH_PEER_LEASE_FILE';
/** 覆盖开关文件路径（演练用）。 */
export const ENV_SWITCH_FILE = 'DSH_PEER_SHORT_RENT_FILE';

export const DEFAULT_RELAY_CLI = process.env.DSH_RELAY_CLI || path.join(TOOLS_DIR, 'relay', 'relay-cli.mjs');
/** 租约默认有效期（毫秒）：超过 ⇒ 视为"没来得及归还"，可被 `reclaimStaleLease` 回收。20 分钟。 */
export const DEFAULT_LEASE_MS = 20 * 60 * 1000;

function home0(env) { return env?.USERPROFILE || env?.HOME || os.homedir(); }

/** 开关文件（`{schemaVersion, enabled, by, why, since}`；**缺失 = 默认开**）。 */
export function switchFilePath(opts = {}) {
  const env = opts.env ?? process.env;
  if (opts.switchFile) return path.resolve(String(opts.switchFile));
  if (env[ENV_SWITCH_FILE]) return path.resolve(String(env[ENV_SWITCH_FILE]));
  return path.join(home0(env), '.dsh', 'relay', 'short-rent.json');
}

/** 租约文件（短租状态；与 relay-config.json / ondemand.json 同目录）。 */
export function leaseFilePath(opts = {}) {
  const env = opts.env ?? process.env;
  if (opts.leaseFile) return path.resolve(String(opts.leaseFile));
  if (env[ENV_LEASE_FILE]) return path.resolve(String(env[ENV_LEASE_FILE]));
  return path.join(home0(env), '.dsh', 'relay', 'short-lease.json');
}

function readJson(p, dflt = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
}

function rmQuiet(p) {
  try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
}

const FALSY = new Set(['off', '0', 'false', 'no', 'disable', 'disabled']);

/**
 * 读"按需短租"总开关。**读不到 / 缺文件 / 损坏 ⇒ 开**（fail-open 是**有意的**：
 * 这是"让传输能跑"的功能开关，不是安全开关；关回去是一句话的事，写进报告与 help）。
 * @returns {{enabled:boolean, source:'env'|'file'|'default', reason:string, file:string, raw:object|null}}
 */
export function readRentSwitch(opts = {}) {
  const env = opts.env ?? process.env;
  const file = switchFilePath(opts);
  const envRaw = String(env[ENV_SWITCH] ?? '').trim().toLowerCase();
  if (envRaw) {
    const enabled = !FALSY.has(envRaw);
    return { enabled, source: 'env', reason: `env ${ENV_SWITCH}=${envRaw}`, file, raw: null };
  }
  const raw = readJson(file, null);
  if (raw && typeof raw === 'object' && raw.enabled === false) {
    return { enabled: false, source: 'file', reason: `开关文件 ${file} 的 enabled=false${raw.by ? `（by ${raw.by}${raw.why ? ` · ${raw.why}` : ''}）` : ''}`, file, raw };
  }
  if (raw && typeof raw === 'object') {
    return { enabled: true, source: 'file', reason: `开关文件 ${file} 的 enabled=true`, file, raw };
  }
  return { enabled: true, source: 'default', reason: `开关文件不存在（${file}）⇒ 默认开`, file, raw: null };
}

/** 写开关文件（`enabled=false` = 一键关回）。 */
export function writeRentSwitch(enabled, opts = {}) {
  const file = switchFilePath(opts);
  const prev = readJson(file, null);
  const obj = {
    schemaVersion: 1,
    enabled: enabled === true,
    by: opts.by ?? 'peer-channel-cli',
    why: opts.why ?? (enabled === true ? '开回：传输类 job 按需短租' : '关回：回到"通道不通就让路"'),
    since: new Date(opts.now ?? Date.now()).toISOString(),
  };
  writeJsonAtomic(file, obj);
  return { file, before: prev, after: obj };
}

// ── relay-cli 调用（**只调 CLI，不复制隧道逻辑**）─────────────────────────────

/**
 * 调一次 `relay-cli.mjs <sub> --json`。
 * ⚠️ `status` 在"隧道不在"时 rc=10 但 **JSON 仍然有效** ⇒ 这里 `ok` 按"能否解析出 JSON"判。
 */
export function relayCliCall(script, sub, opts = {}) {
  const cli = script ?? DEFAULT_RELAY_CLI;
  const r = spawnSync(process.execPath, [cli, sub, '--json'], {
    encoding: 'utf8', timeout: opts.timeout ?? 60_000, windowsHide: true,
    maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...(opts.env ?? {}) },
  });
  const out = String(r.stdout ?? '');
  let json = null;
  try { json = JSON.parse(out.trim()); } catch { /* 保持 null */ }
  return {
    sub, rc: r.status, json, parsed: json !== null,
    stdout: out.trim().slice(0, 400), stderr: String(r.stderr ?? '').trim().slice(0, 400),
    error: r.error ? String(r.error.message ?? r.error) : null,
  };
}

function tail(s, n = 160) { return String(s ?? '').replace(/\s+$/, '').slice(-n); }

// ── 主入口 ①：通道自查 + 按需短租 ─────────────────────────────────────────────

/**
 * 探活调用方给的候选通道；全不通且开关允许 ⇒ **按需短租**（enable + up）后重试。
 *
 * @param {object} opts
 * @param {Array<{channel:string,target:string,via?:string}>} opts.candidates 候选（**顺序 = 优先级**）
 * @param {(c:{channel:string,target:string})=>{ok:boolean,err?:string}} opts.probe 探针（**必给**）
 * @param {string} [opts.owner] 谁在用（写进租约 / 日志；如 'session-mirror'）
 * @param {string} [opts.relayCli] relay-cli 路径（缺省 env 覆盖 → 生态默认）
 * @param {string} [opts.leaseFile] 租约文件（缺省 env 覆盖 → `~/.dsh/relay/short-lease.json`）
 * @param {boolean} [opts.allowRent] 显式允许/禁止短租（缺省 = 读总开关）
 * @param {boolean} [opts.dryRun] 演练：只报"本可以租"，**一个动作都不做**
 * @param {number} [opts.leaseMs] 租约有效期（缺省 20 分钟）
 * @param {()=>void} [opts.log] 行日志回调
 * @returns {{ok:boolean, channel:string|null, target:string|null, via:string|null,
 *            hostname?:string, tried:Array<object>, rented:boolean, lease:object|null, rent:object|null}}
 */
export function ensurePeerChannel(opts = {}) {
  const env = opts.env ?? process.env;
  const now = Number(opts.now ?? Date.now());
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const owner = String(opts.owner ?? 'peer-channel');
  const candidates = (Array.isArray(opts.candidates) ? opts.candidates : [])
    .filter((c) => c && typeof c.target === 'string' && c.target.trim())
    .map((c) => ({ channel: String(c.channel ?? 'direct'), target: String(c.target), via: c.via ?? null }));
  const probe = opts.probe;
  if (typeof probe !== 'function') throw new Error('ensurePeerChannel: 必须传 probe(candidate) 探针函数');
  const relayCli = opts.relayCli ?? env[ENV_RELAY_CLI] ?? DEFAULT_RELAY_CLI;
  const leaseFile = leaseFilePath({ ...opts, env });
  const sw = opts.allowRent === undefined
    ? readRentSwitch({ ...opts, env })
    : { enabled: opts.allowRent === true, source: 'arg', reason: opts.allowRent === true ? '调用方显式允许' : '调用方显式禁止（--no-tunnel-rent 之类）', file: switchFilePath({ ...opts, env }), raw: null };

  const base = { ok: false, channel: null, target: candidates[0]?.target ?? null, via: null, tried: [], rented: false, lease: null, rent: null };

  // ① 先试候选（局域网优先 → 隧道回落）
  for (const c of candidates) {
    let r;
    try { r = probe(c) || {}; } catch (e) { r = { ok: false, err: `probe 抛错：${e?.message ?? e}` }; }
    if (r.ok) {
      return { ...base, ok: true, channel: c.channel, target: c.target, via: c.via ?? null, hostname: r.hostname ?? null };
    }
    base.tried.push({ channel: c.channel, target: c.target, err: tail(r.err ?? '') });
  }
  if (!candidates.length) { base.rent = { skipped: 'no-candidates' }; return base; }

  // ② 全不通 ⇒ 短租
  if (!sw.enabled) {
    base.rent = { skipped: 'switch-off', switchSource: sw.source, switchReason: sw.reason };
    log(`  ⓘ 按需短租已关（${sw.reason}）⇒ 不碰隧道（回到"通道不通就让路"）`);
    return base;
  }
  if (opts.dryRun) {
    base.rent = { skipped: 'dry-run', note: '演练：本可按需开隧道，但一个动作都没做' };
    return base;
  }

  const st = relayCliCall(relayCli, 'status', { env });
  const enabledBefore = st.json?.enabled === true;
  const steps = [];
  if (!enabledBefore) steps.push(relayCliCall(relayCli, 'enable', { env }));
  const up = relayCliCall(relayCli, 'up', { env });
  steps.push(up);
  log(`  ⓘ 两条通道都不通 ⇒ **按需短租**：relay-cli enable${enabledBefore ? '（跳过：本来已 enabled）' : ''} + up`
    + `（隧道启用前=${enabledBefore}）`);

  // ③ 租完重试候选（⚠️ `tried` 语义 = **试过且失败**的通道，与调用方原有日志口径一致）
  const reTried = [];
  for (const c of candidates) {
    let r;
    try { r = probe(c) || {}; } catch (e) { r = { ok: false, err: `probe 抛错：${e?.message ?? e}` }; }
    if (!r.ok) reTried.push({ channel: c.channel, target: c.target, ok: false, err: tail(r.err ?? '') });
    if (r.ok) {
      const downOnRelease = enabledBefore !== true;   // 只关"本来没启用、本次由我 enable+up"的
      const lease = {
        schemaVersion: 1,
        owner,
        token: `${now}-${process.pid}`,
        openedAt: new Date(now).toISOString(),
        openedAtMs: now,
        expireAtMs: now + Number(opts.leaseMs ?? DEFAULT_LEASE_MS),
        enabledBefore,
        downOnRelease,
        relayCli,
        host: os.hostname(),
        channel: c.channel,
        target: c.target,
      };
      writeJsonAtomic(leaseFile, lease);
      return {
        ...base, ok: true, channel: c.channel, target: c.target, via: c.via ?? null,
        hostname: r.hostname ?? null,
        tried: [...base.tried, ...reTried],
        rented: true, lease,
        rent: { enabledBefore, downOnRelease, steps: steps.map((s) => ({ sub: s.sub, rc: s.rc, parsed: s.parsed })), leaseFile },
      };
    }
  }

  // ④ 租了还不通 ⇒ 把"我留下的痕迹"清掉（别把 enabled=true 这种常驻意图留在生产）
  if (!enabledBefore) {
    const down = relayCliCall(relayCli, 'down', { env });
    steps.push(down);
    log('  ⚠️ 短租后仍不通 ⇒ 已回滚：relay-cli down（不把 enabled=true 留在生产）');
  }
  base.tried = [...base.tried, ...reTried];
  base.rented = true;
  base.rent = { enabledBefore, downOnRelease: false, rolledBack: !enabledBefore, steps: steps.map((s) => ({ sub: s.sub, rc: s.rc, parsed: s.parsed })), leaseFile };
  return base;
}

/**
 * 收尾归还：**只关"本次由我开的"那次租**。
 * · 没租过（走 lan / 本来隧道就通）⇒ 什么都不做；
 * · `downOnRelease === false`（进短租前别人已 enable）⇒ 只清自己的租约、**不 down**；
 * · 否则 ⇒ `relay-cli down` + 清租约（**只清 token 还是本次那条**）。
 * @returns {{released:boolean, skipped?:string, detail:string, down?:object}}
 */
export function releasePeerChannel(lease, opts = {}) {
  const env = opts.env ?? process.env;
  const leaseFile = leaseFilePath({ ...opts, env });
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  if (!lease) return { released: false, skipped: 'no-lease', detail: '本轮没租隧道（走直连 / 隧道本来就在跑）⇒ 不关' };
  if (lease.downOnRelease !== true) {
    dropLeaseIfOurs(leaseFile, lease);
    return { released: false, skipped: 'enabled-before-true', detail: '进短租前隧道已 enabled（不是本 job 开的）⇒ 只销自己的租约，**不动隧道**' };
  }
  const relayCli = lease.relayCli ?? opts.relayCli ?? env[ENV_RELAY_CLI] ?? DEFAULT_RELAY_CLI;
  if (opts.dryRun) return { released: false, skipped: 'dry-run', detail: '演练：不真 down' };
  const down = relayCliCall(relayCli, 'down', { env });
  dropLeaseIfOurs(leaseFile, lease);
  log(`  ⓘ 按需短租已回收：relay-cli down（rc=${down.rc}${down.parsed ? ` · portStillListening=${down.json?.portStillListening}` : ''}）`);
  return { released: true, detail: 'down 完成（只关本次由我开的隧道）', down: { rc: down.rc, parsed: down.parsed, portStillListening: down.json?.portStillListening ?? null } };
}

/** 只删"还是我这条"的租约（token 比对，防并发改写被别人顶掉）。 */
function dropLeaseIfOurs(leaseFile, lease) {
  const cur = readJson(leaseFile, null);
  if (!cur || typeof cur !== 'object') return false;
  if (lease?.token && cur.token && cur.token !== lease.token) return false;
  rmQuiet(leaseFile);
  return true;
}

/**
 * 兜底回收：租约过期（进程被杀 / 断电 / 收尾没跑到）⇒ 把隧道关掉、清租约。
 * **只对"本来没启用、由短租开起来"的租约动手**（`downOnRelease===true`）；
 * 对"别人已 enable"的租约只清租约、不碰隧道。
 * ⚠️【R11 · 2026-10-14】`down` 没成（rc≠0）时 ⇒ **保留租约**、`reclaimed:false`、
 *   `reason` 含 `down-failed`（调用方按失败报）—— 明见函数内那段注释。
 * @returns {{reclaimed:boolean, reason:string, lease:object|null, down?:object}}
 */
export function reclaimStaleLease(opts = {}) {
  const env = opts.env ?? process.env;
  const now = Number(opts.now ?? Date.now());
  const leaseFile = leaseFilePath({ ...opts, env });
  const lease = readJson(leaseFile, null);
  if (!lease || typeof lease !== 'object') return { reclaimed: false, reason: 'no-lease', lease: null };
  const expireAt = Number(lease.expireAtMs ?? 0);
  if (!(expireAt > 0) || now < expireAt) {
    return { reclaimed: false, reason: 'not-expired', lease, expireAtMs: expireAt || null, remainMs: expireAt ? expireAt - now : null };
  }
  if (lease.downOnRelease !== true) {
    rmQuiet(leaseFile);
    return { reclaimed: true, reason: 'expired-但进短租前已 enabled ⇒ 只销租约、不动隧道', lease };
  }
  if (opts.apply !== true) return { reclaimed: false, reason: 'dry-run（过期但未 --apply）', lease, expireAtMs: expireAt };
  const relayCli = lease.relayCli ?? opts.relayCli ?? env[ENV_RELAY_CLI] ?? DEFAULT_RELAY_CLI;
  const down = relayCliCall(relayCli, 'down', { env });
  // 【R11 · 2026-10-14】**down 没成 ⇒ 绝不销租约**（本卡补的真缺口，夹具 C5 实测坐实）：
  //   租约是这套兜底的**唯一抓手** —— 原实现无论 down 成败都 `rmQuiet(leaseFile)`，
  //   于是一次失败（relay-cli 报错 / 端口被别的进程占着 / 输出非 JSON）就**永久失去抓手**：
  //   租约没了 ⇒ 后续任何一轮回收都只会看到 `no-lease`，隧道可能**挂过夜**（正是本机制存在的理由）。
  //   保留租约 ⇒ 下一轮（tickd job `lease-reclaim` 每 5 分钟 / 人工 `peer-channel-cli reclaim --apply`）
  //   自动重试；且 `reclaimed:false` + `reason` 含 `down-failed` ⇒ 调用方按**失败**报（不静默）。
  if (down.rc !== 0) {
    return { reclaimed: false, reason: 'expired-down-failed（保留租约待下轮重试）', lease, down: { rc: down.rc, parsed: down.parsed } };
  }
  rmQuiet(leaseFile);
  return { reclaimed: true, reason: 'expired-已回收', lease, down: { rc: down.rc, parsed: down.parsed } };
}

/** 只读快照（CLI `status` / 排障用）。 */
export function describeChannelState(opts = {}) {
  const env = opts.env ?? process.env;
  const sw = readRentSwitch({ ...opts, env });
  const leaseFile = leaseFilePath({ ...opts, env });
  const lease = readJson(leaseFile, null);
  const st = relayCliCall(opts.relayCli ?? env[ENV_RELAY_CLI] ?? DEFAULT_RELAY_CLI, 'status', { env });
  const now = Number(opts.now ?? Date.now());
  return {
    version: VERSION,
    host: os.hostname(),
    at: new Date(now).toISOString(),
    switch: { enabled: sw.enabled, source: sw.source, reason: sw.reason, file: sw.file },
    leaseFile,
    lease: lease ?? null,
    leaseExpired: !!(lease && Number(lease.expireAtMs ?? 0) > 0 && now >= Number(lease.expireAtMs)),
    tunnel: {
      enabled: st.json?.enabled ?? null,
      up: st.json?.ok === true,
      pid: st.json?.tunnel?.pid ?? null,
      portListening: st.json?.tunnel?.portListening ?? null,
      rc: st.rc,
    },
  };
}

export default { ensurePeerChannel, releasePeerChannel, reclaimStaleLease, readRentSwitch, writeRentSwitch, describeChannelState };
