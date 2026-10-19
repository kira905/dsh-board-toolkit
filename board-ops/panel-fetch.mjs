#!/usr/bin/env node
/**
 * board-ops / panel-fetch.mjs —— 面板/归档端点取证通道（**只读**）
 *
 * 干什么：
 *   /api/dsh-butler/state、/api/dsh-archive-sessions/*、/api/task-board/archive 这类端点，
 *   裸 GET 一律 403（要 browserAuth 签名 cookie）⇒ 生效核查里它们只能记「无法判定」。
 *   本工具把「取 cookie → 带 cookie 取数」这条通道做成一条命令，只打印状态码/字段名/体积/耗时。
 *
 * 取 cookie 的两条路（都在内存里，绝不落盘、绝不进日志正文）：
 *   ① 主路 log-token：扫 dsh 启动日志里的 `?token=<T>` → `GET {base}/?token=<T>`（**不跟随跳转**）
 *      → 303 + `set-cookie: dsh-auth-…`（cookie 名/签名**绑定 authority**，Host 头必须与 claim 时逐字一致）。
 *   ② 兜底 secret-sign：读 `~/.dsh/.credentials.yaml` 的 browser-session 密钥**自签**一个同构 cookie
 *      （复用 `lib/dsh-rpc-client.mjs#hostCookie`；主包 <=0.1.4 或无密钥时返回 null）。
 *
 * 用法：
 *   node <workspace>\tools\board-ops\panel-fetch.mjs [--base URL] [--log FILE] [--json] [--no-bare] [--help]
 *
 * 铁律：
 *   · 主机名一律 **127.0.0.1**（localhost 本机 API 慢约 70 倍）
 *   · token / cookie **只在内存**：不写任何文件、不进日志全文（日志只打名字与长度）
 *   · 只读：只发 GET，不改任何生产配置/开关、不重启、不动看板账本
 *
 * 退出码：0 全部端点 200 / 1 有端点非 200 / 2 用法或环境错 / 3 取不到 cookie（端点仍试跑）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOGS_DIR } from '../lib/workspace.mjs';

const DEFAULT_BASE = 'http://127.0.0.1:3080';
const TIMEOUT_MS = 15_000;
const MAX_LOG_BYTES = 4 * 1024 * 1024;   // 超过 4MB 的日志跳过（保护性上限）
const MAX_TOKEN_CANDIDATES = 12;

const ENDPOINTS = [
  { id: 'butler-state', path: '/api/dsh-butler/state', note: '大管家面板只读总览' },
  { id: 'archive-list', path: '/api/dsh-archive-sessions/list?summary=1', note: '归档面板批次摘要' },
  { id: 'board-archive', path: '/api/task-board/archive', note: '看板归档卡' },
];

const HELP = `面板/归档端点取证通道（只读）

用法：node panel-fetch.mjs [选项]
  --base <URL>       DSH 地址（默认 ${DEFAULT_BASE}；铁律：一律用 127.0.0.1，别用 localhost）
  --log <FILE>       指定启动日志（默认自动扫：<workspace>\\logs、~\\.dsh\\logs、%TEMP%、%TEMP%\\dsh-guard）
  --timeout <ms>     单请求超时（默认 ${TIMEOUT_MS}）
  --no-bare          只发「带 cookie」一次（跳过两组对照，快）
  --json             机读输出（stdout 只有 JSON，人读日志走 stderr）
  --help             本帮助

三组对照（默认都跑，用来分清 403 到底是缺 cookie 还是缺 Origin 头）：
  naive       完全裸：只带 accept，别的什么都不加（复现核查里那种「裸 GET 403」）
  originOnly  只带 origin + sec-fetch-site（同源栅栏），**不带 cookie**
  full        带 cookie + origin + sec-fetch-site（本工具主读数）

取 cookie：先认领启动日志里的 ?token=…（GET /?token=… 不跟随跳转 → 303 + set-cookie: dsh-auth-…）；
          日志里没有可用 token 时，兜底用 ~\\.dsh\\.credentials.yaml 的密钥自签（标 via=secret-sign）。
          token / cookie 只在内存，不落盘、不打印全文。

退出码：0 全部端点 200 / 1 有端点非 200 / 2 用法或环境错 / 3 取不到 cookie（端点仍试跑）`;

// ── 参数 ────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP);
  process.exitCode = 0;
} else {
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const JSONOUT = argv.includes('--json');
  /** 人读日志：--json 时只走 stderr（铁律：--json 时 stdout 不许有日志） */
  const log = (s = '') => (JSONOUT ? process.stderr.write(s + '\n') : console.log(s));

  const base = String(val('--base', DEFAULT_BASE)).replace(/\/+$/, '');
  const logFile = val('--log', undefined);
  const timeoutMs = Number(val('--timeout', String(TIMEOUT_MS)));
  const doBare = !argv.includes('--no-bare');

  let badArg = null;
  try { const u = new URL(base); if (!/^https?:$/.test(u.protocol)) badArg = `--base 协议不支持：${u.protocol}`; }
  catch { badArg = `--base 不是合法 URL：${base}`; }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) badArg = `--timeout 不是正数：${argv[argv.indexOf('--timeout') + 1]}`;
  if (badArg) {
    log(`用法错：${badArg}`);
    log('用 --help 看用法。');
    process.exitCode = 2;
  } else {
    await main();
  }

  async function main() {
    const t_start = Date.now();
    log(`== panel-fetch（只读） ==`);
    log(`base=${base}  timeout=${timeoutMs}ms`);

    // ── ① 取 cookie ─────────────────────────────────────────────────────────────
    const claim = await getCookie(base, logFile, timeoutMs, log);
    if (claim.cookiePair) {
      log(`cookie 就绪：name=${claim.cookieName}  value 长度=${claim.cookiePair.length - claim.cookieName.length - 1}  via=${claim.via}  （内存内使用，不落盘）`);
      log(`token 源：${claim.source}`);
    } else {
      log(`⚠ 取不到 cookie（via=${claim.via}）：${claim.reason}`);
      log(`  候选/尝试：${claim.attempts.join('；') || '（无）'}`);
      log(`  ⇒ 端点会照跑，但预期 403。`);
    }

    // ── ② 端点取证（三组对照：naive / originOnly / full） ────────────────────────
    const results = [];
    for (const ep of ENDPOINTS) {
      let naive = null, originOnly = null;
      if (doBare) {
        naive = await probe(base, ep, 'naive', null, timeoutMs);
        originOnly = await probe(base, ep, 'originOnly', null, timeoutMs);
      }
      const full = claim.cookiePair ? await probe(base, ep, 'full', claim.cookiePair, timeoutMs) : null;
      results.push({ id: ep.id, path: ep.path, note: ep.note, naive, originOnly, full, primary: full ?? originOnly ?? naive });
    }

    // ── ③ 打印 ─────────────────────────────────────────────────────────────────
    const okAll = results.every((r) => r.primary?.status === 200);
    const okCount = results.filter((r) => r.primary?.status === 200).length;
    log('');
    for (const r of results) {
      const p = r.primary ?? {};
      log(`[${p.status ?? 'ERR'}] ${r.path}`);
      log(`     对照：naive=${fmt(r.naive)}  originOnly=${fmt(r.originOnly)}  full(带cookie)=${fmt(r.full)}`);
      log(`     耗时=${p.ms ?? '—'}ms  体积=${p.bytes ?? '—'}B  body=${p.kind ?? '—'}`);
      if (p.keys?.length) log(`     keys=${p.keys.join(', ')}`);
      if (p.arraySizes && Object.keys(p.arraySizes).length) log(`     数组长度=${JSON.stringify(p.arraySizes)}`);
      if (p.shape === 'array') log(`     数组元素=${p.length}  首元素 keys=${(p.keys ?? []).join(', ')}`);
      if (p.contentType) log(`     content-type=${p.contentType}`);
      if (p.head) log(`     head=${p.head}`);
      if (p.error) log(`     error=${p.error}`);
    }
    log('');
    log(`成因判读：${cause(results)}`);
    log(`小结：${okCount}/${results.length} 个端点 200 · cookie via=${claim.via} · 总耗时 ${Date.now() - t_start}ms`);
    log(`${okAll ? '✅ 取证通道可用' : '⚠ 有端点非 200（见上）'}`);

    if (JSONOUT) {
      // ⚠️ 只出 JSON，且 **不含** token / cookie 值
      const out = {
        tool: 'panel-fetch',
        base,
        at: new Date().toISOString(),
        host: os.hostname(),
        cookie: {
          obtained: Boolean(claim.cookiePair),
          via: claim.via,
          name: claim.cookieName ?? null,
          source: claim.source ?? null,
          reason: claim.reason ?? null,
          attempts: claim.attempts,
        },
        endpoints: results.map((r) => ({
          id: r.id, path: r.path, note: r.note,
          naive: plain(r.naive),
          originOnly: plain(r.originOnly),
          full: plain(r.full),
          primary: plain(r.primary),
        })),
        cause: cause(results),
        okCount,
        total: results.length,
        okAll,
      };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    }

    process.exitCode = claim.cookiePair ? (okAll ? 0 : 1) : 3;
    // 注：不用 process.exit()（发过 fetch 的脚本强退会概率性崩）
  }
}

/** 三组对照的成因判读（只读推断，写给报告用） */
function cause(results) {
  const n = results.map((r) => r.naive?.status);
  const o = results.map((r) => r.originOnly?.status);
  const f = results.map((r) => r.full?.status);
  if (!n.length) return '未做对照（--no-bare）';
  const allFullOk = f.length > 0 && f.every((s) => s === 200);
  if (n.every((s) => s === 200)) return '本机当前连裸 GET 都 200 ⇒ 这批端点在本机没挂鉴权/cookie 门（结论按实测写，别照抄 403 口径）';
  if (o.every((s) => s === 200) && allFullOk) return '裸 GET 403 → 只补 origin/sec-fetch-site 即 200 ⇒ **起因是同源栅栏，不是 cookie**（cookie 非必需，但带上无害）';
  if (allFullOk) return '裸 GET 与 originOnly 均 403 → full 200 ⇒ **cookie 是关键**（Origin 头不够）';
  return '有端点即便带 cookie 也非 200（见上读数；可能是端点未注册 / 权限 / 版本差异）';
}

function fmt(p) {
  if (!p) return '—';
  return `${p.status}${p.bytes ? `/${p.bytes}B` : ''}${p.ms ? `/${p.ms}ms` : ''}`;
}

function plain(p) {
  if (!p) return null;
  return {
    status: p.status, ms: p.ms, bytes: p.bytes, kind: p.kind,
    keys: p.keys ?? null, arraySizes: p.arraySizes ?? null, length: p.length ?? null,
    contentType: p.contentType ?? null, head: p.head ?? null, error: p.error ?? null,
  };
}

// ── 取 cookie ──────────────────────────────────────────────────────────────────
async function getCookie(base, forcedLog, timeoutMs, log) {
  const attempts = [];
  const files = forcedLog ? [path.resolve(forcedLog)] : collectLogFiles();
  if (!files.length) return { cookiePair: null, via: 'log-token', reason: '日志目录里没找到候选 .log', attempts, source: null };

  const candidates = [];
  for (const f of files) {
    for (const t of extractTokens(f)) candidates.push({ file: f, ...t });
    if (candidates.length >= MAX_TOKEN_CANDIDATES) break;
  }
  log(`扫日志：${files.length} 个候选文件 · 提到 token 候选 ${candidates.length} 个（值不打印）`);

  const seen = new Set();
  for (const c of candidates.slice(0, MAX_TOKEN_CANDIDATES)) {
    if (seen.has(c.token)) continue;
    seen.add(c.token);
    const r = await claimToken(base, c.token, timeoutMs);
    if (r.ok) {
      return {
        cookiePair: r.cookiePair, cookieName: r.cookieName, via: 'log-token',
        source: `${c.file}:${c.line}`, attempts: [...attempts, `HTTP ${r.status} ✓`],
      };
    }
    attempts.push(`${path.basename(c.file)}:${c.line} → HTTP ${r.status}${r.setCookieCount ? ` (set-cookie ${r.setCookieCount} 条，无 dsh-auth-*)` : ' (无 set-cookie)'}`);
  }

  // 兜底：用 .credentials.yaml 的密钥自签（与浏览器换到的 cookie 同构）
  const self = await cookieFromSecret(base);
  if (self) return { ...self, via: 'secret-sign', source: `~/.dsh/.credentials.yaml (browser-session secret, 自签)`, attempts };
  attempts.push('secret-sign 兜底不可用（无密钥 / 主包旧线）');
  return { cookiePair: null, via: candidates.length ? 'log-token' : 'none', reason: '日志里的 token 全部认领失败，自签兜底也不可用', attempts, source: null };
}

/** 收集候选日志文件：按 mtime 倒序（最新启动日志在前） */
function collectLogFiles() {
  const tmp = os.tmpdir();
  const dirs = [LOGS_DIR, path.join(os.homedir(), '.dsh', 'logs'), tmp, path.join(tmp, 'dsh-guard')];
  const out = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of names) {
      const p = path.join(d, e.name);
      if (e.isFile() && /\.log$/i.test(e.name)) out.push(p);
      // TEMP 下 dsh-subprocess-* / dsh-* 子目录再下钻一层
      else if (e.isDirectory() && /^dsh[-_]/i.test(e.name) && d === tmp) {
        try {
          for (const f of fs.readdirSync(p, { withFileTypes: true })) {
            if (f.isFile() && /\.log$/i.test(f.name)) out.push(path.join(p, f.name));
          }
        } catch { /* ignore */ }
      }
    }
  }
  const seen = new Set();
  return out
    .filter((p) => { if (seen.has(p)) return false; seen.add(p); return true; })
    .map((p) => { let st; try { st = fs.statSync(p); } catch { return null; } return st.isFile() && st.size > 0 && st.size <= MAX_LOG_BYTES ? { p, m: st.mtimeMs } : null; })
    .filter(Boolean)
    .sort((a, b) => b.m - a.m)
    .map((x) => x.p);
}

/** 从单个日志里提 token（行号倒序 = 更可能是当次）；只在内存里返回，调用方不打印其值 */
function extractTokens(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const re = /[?&]token=([A-Za-z0-9._\-]{6,})/g;
    let m;
    while ((m = re.exec(lines[i]))) out.push({ token: m[1], line: i + 1, authority: (lines[i].match(/https?:\/\/([^/\s?]+)/) ?? [])[1] ?? null });
  }
  return out.reverse();
}

async function claimToken(base, token, timeoutMs) {
  try {
    const url = `${base}/?token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'text/html' } });
    const all = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    const hit = all.map((c) => String(c).trim()).find((c) => /^dsh-auth-/.test(c));
    if (!hit) return { ok: false, status: res.status, setCookieCount: all.length };
    const cookiePair = hit.split(';')[0].trim();
    return { ok: true, status: res.status, cookiePair, cookieName: cookiePair.split('=')[0] };
  } catch (e) {
    return { ok: false, status: 'ERR', setCookieCount: 0, error: String(e?.message ?? e).slice(0, 120) };
  }
}

async function cookieFromSecret(base) {
  try {
    const mod = await import(new URL('../lib/dsh-rpc-client.mjs', import.meta.url).href);
    const c = mod.hostCookie(base);
    return c ? { cookiePair: c.header, cookieName: c.name } : null;
  } catch { return null; }
}

// ── 端点探测 ──────────────────────────────────────────────────────────────────
/** variant：'naive' 完全裸 / 'originOnly' 只带同源栅栏头 / 'full' 带 cookie + 栅栏头 */
async function probe(base, ep, variant, cookiePair, timeoutMs) {
  const t0 = performance.now();
  try {
    const headers = { accept: 'application/json, */*' };
    if (variant !== 'naive') { headers.origin = base; headers['sec-fetch-site'] = 'same-origin'; }
    if (variant === 'full' && cookiePair) headers.cookie = cookiePair;
    const res = await fetch(base + ep.path, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const buf = Buffer.from(await res.arrayBuffer());
    const ms = Math.round(performance.now() - t0);
    const ct = res.headers.get('content-type') ?? undefined;
    return { status: res.status, ms, bytes: buf.length, contentType: ct, ...summarize(buf, ct, res.status) };
  } catch (e) {
    return { status: 'ERR', ms: Math.round(performance.now() - t0), bytes: 0, kind: 'error', error: String(e?.message ?? e).slice(0, 160) };
  }
}

/** 只提取「字段名 / 体积 / 形状」——不复制业务数据，200 响应更不留明文片段 */
function summarize(buf, ct, status) {
  if (!buf.length) return { kind: 'empty' };
  const text = buf.toString('utf8');
  let json;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (json !== undefined) {
    if (Array.isArray(json)) {
      const first = json.find((x) => x && typeof x === 'object');
      return { kind: 'json', shape: 'array', length: json.length, keys: first ? Object.keys(first).slice(0, 12) : [] };
    }
    if (json && typeof json === 'object') {
      const keys = Object.keys(json).slice(0, 15);
      const arraySizes = {};
      for (const k of keys) if (Array.isArray(json[k])) arraySizes[k] = json[k].length;
      return { kind: 'json', shape: 'object', keys, arraySizes };
    }
    return { kind: 'json', shape: typeof json };
  }
  const out = { kind: 'text', contentType: ct };
  if (status >= 400) out.head = text.replace(/\s+/g, ' ').slice(0, 80);
  return out;
}
