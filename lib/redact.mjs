// tools\lib\redact.mjs —— **共享脱敏件**（R-066「密钥面第二道钩子」· 2026-10-16）
//
// 一句话：取证输出落盘 / 打屏之前，**按「键名」*或*「值形态」双判据**把密钥打掉 ——
//   命中一律只输出 `<set:长度>`（不泄漏值本身，也不泄漏"这是什么类型的密钥"）。
//
// ❗为什么必须按值兜底（本文件存在的理由）：
//   2026-10-16 真实踩法 —— `cordis.patch.yml` 的 `channelSecrets:` **子键名是渠道 id**
//   （`local` / `siliconflow`），**键名里没有 key/secret 字样** ⇒ 只认键名的脱敏脚本
//   把明文 API key 原样打进了工具输出（落进会话日志）。
//   **通用教训**：「值是密钥、但键名看不出来」是常态（渠道 id / 账号名 / 环境名当键）。
//
// ── 三条硬口径（改本文件前先读）──────────────────────────────────────────
//   ① **双向判据缺一不可**（R-067 §7 第 9 条「守卫必须双向测」过继口径）：
//      只测"该脱的脱了"不够 —— 必须同时测"**不该脱的没脱**"（脱敏过头会把报告毁掉：
//      路径 / git sha / 版本号 / 日期 / 中文叙述都可能被误伤）。
//   ② **本件是唯一真源**：`tools\dsh-nurse\lib\redact.mjs` 已改为薄转发（别留两份脱敏器，
//      两份必然分叉）。改规则只改这里。
//   ③ **纯函数、零 IO、不 exit**：`createRedactor()` 只做字符串/对象变换，由调用方决定写哪里。
//
// ── 判据速查 ────────────────────────────────────────────────────────────
//   键名类（值 ≥ 4 字符即打）：`*key*` / `*secret*` / `*token*` / `*password*` / `*credential*` …
//   值形态类（与键名无关）：`sk-` `ghp_` `glpat` `AIza` `AKIA` `xox?` `hf_` `npm_` `pypi-` ·
//     PEM 私钥块 · **≥32 字符且高熵（≥4.2 bit/char）的串**
//   **明确不误伤**：纯 hex（`[0-9a-f]{32,}`，= git sha / md5 读数）· 纯数字 · 版本号 · 绝对路径 ·
//     内网 IP（沿用原规则，输出 `<redacted:lan-ip>`）· 中文叙述

import os from 'node:os';

/** 值形态：已知前缀的密钥（与键名无关，看一眼值就知道）。 */
const PREFIX = /\b(?:sk|sk-proj|ghp|gho|ghu|ghs|ghr|glpat|xox[baprs]|AIza|AKIA|hf_|npm_|pypi-)[-_A-Za-z0-9]{8,}\b/g;
/** 值形态：PEM 私钥块（跨行）。 */
const PEM = /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g;
/** 值形态：候选高熵串（再经 looksLikeSecret 二次判定，避免误伤）。 */
const ENTROPY_CAND = /\b[A-Za-z0-9_\-+=]{32,}\b/g;
/** 键名：出现在 `键 <分隔> 值` 左侧的敏感词（大小写不敏感、允许前后缀如 apiKey / accessToken / channelSecret）。
 *  ⚠️ 空白一律用 `[ \t]`（**不跨行**）：用 `\s` 会让 `channelSecrets:\n  local: "…"` 里的**子键名** `local`
 *     被当成值打掉 —— 那既误伤键名、又把 YAML 结构毁成非法（2026-10-16 夹具演练首轮实测抓到）。 */
const KEY_ASSIGN = /(^|[\s{,[('"])((?:"|')?[A-Za-z0-9_.\-]*(?:key|secret|token|password|passwd|passphrase|credential)[A-Za-z0-9_.\-]*(?:"|')?)([ \t]*[:=][ \t]*)(?:"([^"\n]{4,})"|'([^'\n]{4,})'|([^\s,;}\])]{4,}))/gim;

/** `<set:N>`：**统一输出形态**（N = 原值字符数）。 */
export const setTag = (v) => `<set:${String(v).length}>`;

/** 香农熵（bit/char）。 */
export function shannon(s) {
  const f = new Map();
  for (const ch of s) f.set(ch, (f.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

/**
 * 「这串像不像密钥」——**误伤防线都在这儿**。
 * 排除项都是实测会出现的正常值：git sha / md5（纯 hex）、纯数字、版本号、`<set:N>` 自身。
 */
export function looksLikeSecret(s) {
  if (s.length < 32) return false;
  if (/^[0-9a-f]+$/.test(s)) return false;          // git sha / md5（报告里满地都是）
  if (/^[0-9A-F]+$/.test(s)) return false;
  if (/^\d+$/.test(s)) return false;                // 纯数字（时间戳 / 计数）
  if (/^v?\d+(?:\.\d+)+(?:[-+][A-Za-z0-9.]+)?$/.test(s)) return false; // 版本号
  if (/^<set:\d+>$/.test(s)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[_\-+=]/].filter((re) => re.test(s)).length;
  if (classes < 3) return false;                    // 只有 1~2 类字符 ⇒ 十有八九是词/短横线命名
  return shannon(s) >= 4.2;
}

/** 静态规则：**顺序有意义** —— 先把"具体形态"干掉，兜底规则放最后。 */
export const REDACT_RULES = [
  { id: 'pem-private-key', re: PEM, to: (m) => setTag(m) },
  { id: 'value-prefix', re: PREFIX, to: (m) => setTag(m) },
  { id: 'bearer', re: /\bBearer[ \t]+([A-Za-z0-9._\-]{12,})/gi, to: (m, t) => `Bearer ${setTag(t)}` },
  { id: 'key-assign', re: KEY_ASSIGN, to: (m, pre, key, sep, dq, sq, bare) => {
    const v = dq ?? sq ?? bare ?? '';
    // ⚠️ 已经是打码态就别再打一次：值形态规则先跑（`sk-…` → `<set:27>`），键名规则再跑时会把
    //    `<set:27>` 当成"新值"打成 `<set:8>`（双重脱敏会把长度信息毁掉 · 2026-10-16 夹具实测抓到）。
    if (/^<set:\d+>$/.test(v)) return m;
    return `${pre}${key}${sep}${setTag(v)}`;
  } },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9._\-]{20,}/g, to: (m) => setTag(m) },
  { id: 'value-entropy', re: ENTROPY_CAND, to: (m) => (looksLikeSecret(m) ? setTag(m) : m) },
  // 绝对用户路径：兼容 JSON 转义后的双反斜杠 / 正斜杠两种形态
  { id: 'user-path', re: /(?:[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2})[A-Za-z0-9_.\-]+/gi, to: '<home>' },
  { id: 'lan-ip', re: /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g, to: '<redacted:lan-ip>' },
];

/** 太通用的用户名不做全局替换（否则在 主机 B 的 `Admin` 上会误伤正文）。 */
export const GENERIC_USERS = new Set(['admin', 'administrator', 'user', 'username', 'root', 'owner', 'guest']);

/** 「只脱密钥」档要保留的规则 id（打屏场景用：人还要读路径 / 机器名 / 用户名，别把可读性一起脱掉）。 */
export const SECRET_ONLY_IDS = new Set(['pem-private-key', 'value-prefix', 'bearer', 'key-assign', 'jwt', 'value-entropy']);

/**
 * @param {{username?:string, secretsOnly?:boolean}} [options]
 *   `secretsOnly:true` ⇒ 只保留**密钥类**规则（打屏 / 诊断输出场景）；
 *   缺省 = 全量（含绝对用户路径 `<home>` / 裸用户名 `<user>` / 内网 IP），用于**落盘留存 / 外发**的现场包。
 */
export function createRedactor(options = {}) {
  const username = options.username !== undefined
    ? options.username
    : (() => { try { return os.userInfo().username; } catch { return ''; } })();

  const rules = options.secretsOnly ? REDACT_RULES.filter((r) => SECRET_ONLY_IDS.has(r.id)) : [...REDACT_RULES];
  if (!options.secretsOnly && username && username.length >= 4 && !GENERIC_USERS.has(username.toLowerCase())) {
    const esc = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rules.push({ id: 'local-user', re: new RegExp(`\\b${esc}\\b`, 'g'), to: '<user>' });
  }

  let total = 0;
  const byRule = {};

  function redact(text) {
    if (typeof text !== 'string') return { text, hits: {} };
    const hits = {};
    let t = text;
    for (const r of rules) {
      // ⚠️ 一律**函数式替换**：$ 开头的替换串会被当模式展开（生态踩过：441 行复制成 735 行）；
      //    高熵规则本来也需要逐值判定。
      const fn = typeof r.to === 'function' ? r.to : () => r.to;
      const m = t.match(r.re);
      if (m && m.length) {
        hits[r.id] = m.length;
        t = t.replace(r.re, (...args) => fn(...args));
      }
    }
    return { text: t, hits };
  }

  function redactAndCount(text) {
    const { text: t, hits } = redact(text);
    for (const [k, v] of Object.entries(hits)) { byRule[k] = (byRule[k] || 0) + v; total += v; }
    return t;
  }

  /** 逐字段脱敏（对象 / 数组 / 字符串），返回新对象。 */
  function deepRedact(obj) {
    if (typeof obj === 'string') return redactAndCount(obj);
    if (Array.isArray(obj)) return obj.map(deepRedact);
    if (obj && typeof obj === 'object') {
      const o = {};
      for (const [k, v] of Object.entries(obj)) o[k] = deepRedact(v);
      return o;
    }
    return obj;
  }

  return {
    redact,
    redactAndCount,
    deepRedact,
    rules,
    stats: () => ({ total, byRule: { ...byRule }, rules: rules.map((r) => r.id) }),
  };
}
