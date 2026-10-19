// dsh-butler / lib/pitfall-sign.mjs —— P4 坑签名：归一化 + 排除判定 + 主题分类
//
// 方案：docs\大管家v2方案-从只读到真管家-20260909.md §4 P4（行 689-774）
//   「签名 = error.name/code + 规范化错误文本（去路径 / 时间 / PID / 行号）」
//   「防噪音：签名去重 + 门槛 ≥2 次 + 排除业务性失败」
//   「两条口径必须先落 fixture（v2.2 补 · 审核重要 11）」→ _test/fixtures/pitfall-exclude.json
//
// 本模块是**纯函数层**（无 IO，除了读 fixture），R 回归直接单测：
//   - 同一坑、不同路径/时间/PID/会话 → 必须同一签名
//   - 不同坑 → 必须不同签名
//   - 排除清单正反样本逐条跑（fixture 自带 expect）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { COMPONENT_ROOT } from './paths.mjs';

export const PITFALL_SIGN_VERSION = '0.1.0';

/** 排除清单 fixture 默认路径（方案指定的唯一权威源）。 */
export const EXCLUDE_FIXTURE_PATH = path.join(COMPONENT_ROOT, '_test', 'fixtures', 'pitfall-exclude.json');

/** 归一化后保留的文本长度（签名稳定性 vs 可读性）。
 *  2026-10-10 卡「冲刺600·补核心库」（gap-1-05）：**220 → 200**，对齐方案 §3.6.1
 *  「样本 = 脱敏后的错误片段，**单条 ≤200 字符**」（220 是实现先行值，超方案口径 20 字）。 */
export const NORM_TEXT_MAX = 200;

/**
 * 归一化规则（顺序敏感：先路径，再时间/ID，最后行号）。
 * 目标：同一坑的不同现场（路径/时间/PID/callId/行号）必须收敛成同一字符串。
 */
const NORMALIZERS = [
  // Windows 绝对路径（含空格外的常见字符；盘符开头）
  [/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g, '<PATH>'],
  // UNC / 双反斜杠路径
  [/\\\\[^\s"']+/g, '<PATH>'],
  // 正斜杠盘符路径 <workspace>/...
  [/\b[A-Za-z]:\/[^\s"']+/g, '<PATH>'],
  // ISO / 常见日期时间
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TIME>'],
  [/\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2}/g, '<TIME>'],
  // 13 位毫秒 epoch（会话时间戳）
  [/\b1\d{12}\b/g, '<TS>'],
  // 工具 callId / UUID / 会话 id / 长 hex
  [/call_\d+_[A-Za-z0-9]+/g, '<CALL>'],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>'],
  [/session-[0-9a-f-]{8,}/gi, '<SID>'],
  [/\b[0-9a-f]{16,}\b/gi, '<HEX>'],
  // PID
  [/\bpid[=: ]+\d+/gi, 'pid=<PID>'],
  [/\bProcessId\s*[:=]\s*\d+/gi, 'ProcessId=<PID>'],
  // rg 的行列号 path:12:34:
  [/:\d+:\d+(?=:)/g, ':<LINE>'],
  // 绝对路径被吃掉后残留的裸盘符
  [/\b[A-Za-z]:\\/g, '<PATH>\\'],
];

/** 折叠空白（保留换行语义为单个空格，签名是单行键）。 */
function collapse(s) {
  return s.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n+/g, ' \\n ').trim();
}

// ---------------------------------------------------------- 用户名脱敏（方案 §3.6.1）

/** 本机用户名列表。默认取 `os.userInfo().username`（跨机 `<user>` / `Admin` 各自成立）；
 *  可用 `BUTLER_NORM_USER` 覆盖（多值逗号分隔，单测注入用）—— **空串 = 不替换任何名字**。
 *  只收长度 ≥3 的名字（1~2 字符误伤率过高）。 */
export function normUsers() {
  const raw = process.env.BUTLER_NORM_USER !== undefined
    ? process.env.BUTLER_NORM_USER
    : (() => { try { return os.userInfo().username; } catch { return ''; } })();
  return String(raw ?? '').split(',').map((s) => s.trim()).filter((s) => s.length >= 3);
}

/**
 * 用户名归一化（**在静态路径规则之后跑**，兜住路径规则吃不到的形态）。
 *   ① 无盘符的用户目录形态：`\Users\<user>` / `/Users/<user>` / `/home/<user>` → `<PATH>`
 *   ② 裸用户名（词边界，大小写不敏感）→ `<USER>`
 *  ⚠️ 已知代价：用户名恰是常见英文词时（如 主机 B 的 `Admin`）该词会被一并抽象化 ——
 *     签名仍收敛（同一坑同一签名），只损失一点可读性；要关掉用 `BUTLER_NORM_USER=` 空串。
 * @param {string} s
 * @param {string[]} [users]
 * @returns {string}
 */
export function normalizeUserTokens(s, users = normUsers()) {
  let out = String(s ?? '');
  out = out.replace(/[/\\](?:Users|users|home)[/\\][^\s"':;]+/g, '<PATH>');
  for (const u of users) {
    const esc = u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { out = out.replace(new RegExp(`(?<![\\w.-])${esc}(?![\\w.-])`, 'gi'), '<USER>'); } catch { /* 非法名字跳过 */ }
  }
  return out;
}

/**
 * 归一化错误文本。
 * @param {string} text
 * @returns {string}
 */
export function normalizeErrorText(text) {
  let s = String(text ?? '');
  for (const [rx, rep] of NORMALIZERS) s = s.replace(rx, rep);
  s = normalizeUserTokens(s);
  s = collapse(s);
  return s.length > NORM_TEXT_MAX ? s.slice(0, NORM_TEXT_MAX) : s;
}

/**
 * 计算坑签名。
 * @param {{name?:string, code?:string, text?:string}} err
 * @returns {{sigKey:string, id:string, normText:string, name:string, code:string}}
 */
export function signatureOf(err = {}) {
  const name = String(err.name ?? '').trim() || 'Error';
  const code = String(err.code ?? '').trim() || 'NO_CODE';
  const normText = normalizeErrorText(err.text);
  const sigKey = `${name}|${code}|${normText}`;
  const id = crypto.createHash('sha1').update(sigKey, 'utf8').digest('hex').slice(0, 16);
  return { sigKey, id, normText, name, code };
}

// ---------------------------------------------------------------- 排除清单

/** 读排除清单 fixture。加载失败 → 返回空规则（= 不排除任何东西，保守多记）+ error 说明。 */
export function loadExcludeFixture(file = EXCLUDE_FIXTURE_PATH) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    const keep = Array.isArray(j?.keep) ? j.keep : [];
    const exclude = Array.isArray(j?.exclude) ? j.exclude : [];
    for (const r of [...keep, ...exclude]) {
      if (!r || typeof r.id !== 'string' || !r.match || typeof r.match !== 'object' || !Object.keys(r.match).length) {
        throw new Error(`规则非法（需要 id + 非空 match）：${JSON.stringify(r)?.slice(0, 120)}`);
      }
    }
    return { ok: true, file, version: j.version ?? 1, policy: j.policy ?? {}, keep, exclude, error: null };
  } catch (e) {
    return { ok: false, file, version: null, policy: {}, keep: [], exclude: [], error: e?.message ?? String(e) };
  }
}

function matchList(ruleVal, actual) {
  if (!Array.isArray(ruleVal) || !ruleVal.length) return true;
  const a = String(actual ?? '').toLowerCase();
  return ruleVal.some((v) => String(v).toLowerCase() === a);
}

function matchRegexList(ruleVal, text) {
  if (!Array.isArray(ruleVal) || !ruleVal.length) return true;
  return ruleVal.some((r) => {
    try { return new RegExp(r, 'i').test(text); } catch { return false; }
  });
}

/** 单条规则是否命中（字段 AND；同字段数组 OR）。 */
export function ruleMatches(rule, ev) {
  const m = rule.match ?? {};
  if (Object.keys(m).length === 0) return false;
  if (!matchList(m.tools, ev.tool)) return false;
  if (!matchList(m.names, ev.name)) return false;
  if (!matchList(m.codes, ev.code)) return false;
  if (!matchRegexList(m.textRegex, String(ev.text ?? ''))) return false;
  return true;
}

/**
 * 判定一条错误是否属于「业务性失败」（排除，不入坑库）。
 * 顺序：keep 优先 → exclude → 默认保留。
 * @param {{name?:string, code?:string, text?:string, tool?:string}} ev
 * @param {ReturnType<typeof loadExcludeFixture>} fixture
 * @returns {{excluded:boolean, ruleId:string|null, reason:string, matchedKeep:boolean}}
 */
export function classifyError(ev, fixture) {
  const f = fixture ?? loadExcludeFixture();
  for (const r of f.keep) {
    if (ruleMatches(r, ev)) return { excluded: false, ruleId: r.id, reason: r.reason ?? '', matchedKeep: true };
  }
  for (const r of f.exclude) {
    if (ruleMatches(r, ev)) return { excluded: true, ruleId: r.id, reason: r.reason ?? '', matchedKeep: false };
  }
  return { excluded: false, ruleId: null, reason: '默认保留（保守：宁可多记）', matchedKeep: false };
}

// ---------------------------------------------------------------- 主题分类

/** 坑库主题（方案：docs\坑库\{pwsh,插件,会话,守护鱼,同步,其他}.md）。 */
export const CATEGORIES = ['pwsh', '插件', '会话', '守护鱼', '同步', '其他'];

/** 文本关键词 → 主题（顺序 = 优先级，先具体后泛化）。 */
const TEXT_RULES = [
  ['守护鱼', [/守护鱼/, /\bguard\b/i, /guard-state/, /dsh-guard/i, /restart-coordinator/i]],
  ['同步', [/gitee/i, /git-crypt/i, /gitignore/i, /\bgit\b/i, /备份/, /同步/, /baidu/i, /nutstore/i, /坚果云/, /百度/]],
  ['插件', [/plugin/i, /插件/, /cordis/i, /\bbundle/i, /package-map/i, /node_modules/i, /\.package-map/]],
  ['会话', [/session/i, /会话/, /\.zstd/i, /zstd/i, /jsonl/i, /_archived-sessions/i]],
  ['pwsh', [/pwsh/i, /powershell/i, /PSVersion/i, /\bBOM\b/i, /\.ps1/i, /\.cmd/i, /\.bat/i, /Set-Content/i, /ExecutionPolicy/i]],
];

/** 工具名兜底 → 主题。 */
const TOOL_RULES = [
  [/^(pwsh|bash|terminal|shell)$/i, 'pwsh'],
  [/^browser_/i, '插件'],
  [/^(skill|imagegen|edit_image|generate_image)/i, '插件'],
];

/**
 * 主题分类：**只看错误语义**（已归一化的文本 + name/code），不看路径 ——
 * 路径里的关键词会污染分类（实测：`FS_STALE_VERSION` 首现路径在 `git-backup\` 下，
 * 被误归「同步」；其实它是通用坑）。
 * 工具名只作兜底（文本判不出来时）。
 * @param {{tool?:string, text?:string, name?:string, code?:string}} ev
 * @returns {string}
 */
export function categorize(ev = {}) {
  const hay = `${ev.text ?? ''} ${ev.name ?? ''} ${ev.code ?? ''}`;
  for (const [cat, rxs] of TEXT_RULES) {
    if (rxs.some((rx) => rx.test(hay))) return cat;
  }
  const tool = String(ev.tool ?? '');
  for (const [rx, cat] of TOOL_RULES) if (rx.test(tool)) return cat;
  return '其他';
}
