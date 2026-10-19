#!/usr/bin/env node
/**
 * board-snapshot-export.mjs —— 看板账本「跨机并回快照」导出器（本机侧，只读取证）
 *
 * 用途：把本机看板账本导出成一份**可安全过仓的 JSON 快照**，供对端用
 *       `board-merge.mjs` 走 Host HTTP API 并回（绝不手改 ledger）。
 *
 * 设计（2026-09-13 · 工作 主机 A）：
 *   · **只读本机，不写任何生产文件**（唯一产出 = 快照文件 + 变更流水一行）
 *   · 快照只含"并回必需的字段"，掉执行历史与路径绝对量 → 由对端用本机 workspaceId 映射
 *   · **归档卡带 `archivedAt`**（2026-09-16 · 卡 AT18）：对端 board-merge 据此在写入前跳过归档卡
 *     （归档卡在 Host 侧整卡只读，写必 400）；旧快照无此字段时对端靠本机侧 archivedAt 兜底
 *   · 出包前做**敏感串体检**（token / api key / 密码 / 私钥块）——命中只告警不阻拦
 *   · 文件名带主机名 + 时间戳，落 `<workspace>\tools\dsh-butler\snapshots\`（随仓3 同步）
 *
 * 用法：
 *   node <workspace>\tools\board-snapshot-export.mjs [--label <短标签>] [--out <目录>] [--json]
 *   node <workspace>\tools\board-snapshot-export.mjs --self-test      # 自检（不读生产账本）
 *
 * ★「疑似 API key」规则收敛（2026-09-16 · 卡 = 误报体检规则收敛）：
 *   旧规则 `\b(sk|ak|pk|ghp|glpat|LTAI)[-_A-Za-z0-9]{16,}\b` 把**参数名** `--skip-board-snapshot`
 *   判成 key（`sk` + `ip-board-snapshot` 正好 ≥16 位）—— 2026-09-16 02:51 Depart 因此 rc=3、
 *   交接单记 deferred(待人工核验)，是纯噪声误报。新口径改判「**形态**」而非缩短长度阈值：
 *     ① 强形态（必报）：标准前缀 + 分隔符 -/_ + 主体 ≥12 位 —— `sk-…` / `ghp_…` / `glpat-…`
 *     ② 无分隔形态：仅 `LTAI…`（阿里云 AccessKeyId，前缀本身即形态）直接报；
 *        小写前缀（sk/ak/pk/ghp/glpat）无分隔时**必须含数字**才报（纯字母串与英文/camelCase 标识符不可分）
 *   仍在报的：真 key 全形态 + 私钥块 + Bearer + password 赋值（检出能力**不得**下降，见 --self-test）。
 *   误报实证（都来自卡描述里的普通文本，2026-09-16 逐条核过）：
 *     · `--skip-board-snapshot` / `skip-board-snapshot`（参数名）
 *     · `skippedAlreadyRestored`（tasks[144] 的 camelCase 变量名——含大小写混用，故熵判据必须收窄到"含数字"）
 *     · `skyscraperphotography`（以 sk 开头的英文词）
 *   有意不报（口径收紧，已知）：无分隔且**纯字母**的前缀长串（`skipped…` / `skabcdefghijklmnopqrst`）。
 *
 * ★「password 赋值」探针的形态收敛（2026-09-16 · 卡 AT13「误报形态 B」）：
 *   旧口径 `(password|passwd|secret|token)\s*[:=]\s*\S{8,}` 只看"关键字 + 8 个非空白"，于是
 *   卡文本里**合法出现的凭据样例**被判成真凭证（主机 B 侧 Depart ②c 每轮 deferred「待人工核验」，
 *   把真未完成项淹没）：取凭据代码 `const token = (r.stdout ?? "").match(/^password=(.+)$/m)?.[1];`、
 *   尖括号占位 `?access_token=<token>`、省略号占位 `?token=...`、引用式 `token=${GITEE_TOKEN}`。
 *   新口径 = **排除"不可能是秘密"的形态**（占位符/打码串 / 代码引用 / 环境变量引用 / 代码标点起头），
 *   逐处判定、跳过继续找；弱口令、无数字长口令、bcrypt 哈希（`$2b$10$…`）照样报。
 *   ⚠️ 判据是"排除不可能形态"，**不是**"要求高熵"——加熵要求会误伤真实弱口令与长口令。
 *   方案与取证：`docs\看板快照敏感串体检-误报形态B-方案-20260916.md`。
 *
 * ★B5 裸 `$var` / B6 裸标识符的形态收敛（2026-09-23 · 卡「小修·1」，AT13 同族延伸）：
 *   生产实测（本机账本 revision 4721）：**导出 rc=3** 的命中**全部**是这两类未覆盖形态，零真凭证 ——
 *     · B5 裸 `$var`：`$env:OSS_PUSH_TOKEN = $giteeTok`（探针捕到 `TOKEN = $giteeTok`）——3 张卡
 *     · B6 裸标识符：`token = launchToken，**进程级、每次启动随机、不落盘**…`（值 = 散文里引用的变量名）
 *   ⇒ depart ②c 每轮 `deferred（待人工核验）`，与"真失败"不可区分（证据 `docs\交付报告-状态不明批-自检-20260923.md` §2.4）。
 *   收敛口径与形态 B 同源（**排除"不可能是秘密"的形态**，**不加熵要求**）：
 *     · B5：值以 `$` 紧跟字母/下划线起头 = 变量引用（`$env:`/`${`/`$(` 既有豁免的自然扩展）。
 *       ⚠️ `$` 后紧跟**数字**不算 —— `$2b$10$…`（bcrypt）等哈希必须照报。
 *     · B6：值是代码标识符，仅两子形态 ——
 *       ① 成员访问链（`opts.launchToken`）；
 *       ② 含 `password|passwd|secret|token` 词根的标识符 + **后随非 ASCII**（中文散文里引用的变量名）。
 *       **有意不豁免**：不含词根、无点号的纯 ASCII 标识符（`correcthorsebatterystaple` / `buildLauncherCommand`）
 *       —— 与真口令不可分（AT13 已论证：纯字母串与标识符/英文词不可分，加熵要求会误伤弱口令）。
 *   ⚠️ 弱口令 / 无数字长口令 / bcrypt 哈希 / 引号包裹强口令的检出能力**不得**下降（`--self-test` 有反向断言）。
 *   回滚点 `_archive\xiaoxiu1-b5b6-20260923-2221\`（before + manifest + restore-xiaoxiu1.mjs）。
 *
 * ★退出码契约（2026-09-16 定 · 调用方 handoff.mjs ②c 依赖它，改这三态必须先改那边）：
 *   0 = 干净出包（体检未命中）
 *   3 = **体检命中但已出包** → 调用方必须记 `deferred（待人工核验）`，绝不可当失败、也绝不可静默放行
 *   1 = 真失败（账本缺失 / 解析失败；快照没出）
 *   为什么必须分开：2026-09-16 02:51 Depart 把 rc=3（已出包）当失败报「导出失败 → deferred」，
 *   掩盖了"快照其实已生成并已过仓"的事实；而失败码原先用 2、与"命中"共用一个非 0 区间，更易混淆。
 * ★`--json` 输出为**单行 compact JSON**（调用方按 stdout 尾行解析；多行美化会解析失败 —— 同上事故根因之二）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DSH_WORKSPACE } from './lib/workspace.mjs';

const DSH_ROOT = process.env.DSH_ROOT || DSH_WORKSPACE;
// 落点刻意避开 `snapshots/`（仓3 .gitignore 忽略该目录名 → 快照进不了仓）
const SNAP_DIR = path.join(DSH_ROOT, 'tools', 'board-snapshots');

function ledgerPath() {
  // 口径 BUTLER_DSH_HOME > DSH_HOME > ~/.dsh（2026-09-14 统一，与 tools/lib/dsh-home.mjs 同源）
  const home = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'task-board', 'ledger-v2.json');
}

/** 可从本机账本 + 交接单双通道探测主机名（与仓1 目录名一致：小写主机名） */
function hostName() {
  return String(os.hostname()).toLowerCase();
}

const norm = (s) => String(s ?? '').replace(/\s+/g, '');

/** 退出码契约（见文件头；调用方 handoff.mjs ②c 按这三态分流） */
export const EXIT = { ok: 0, failed: 1, sensitive: 3 };

/** 快照里每张卡要带走的字段（白名单；掉 executions / createdAt 等本机态） */
export function toSpecCard(t) {
  const out = {
    id: t.id,
    title: t.title,
    description: String(t.description ?? ''),
    prompt: String(t.prompt ?? ''),
    status: t.status,
    permission: t.permission ?? 'danger-full-access',
    kind: t.kind ?? 'once',
  };
  if (t.line) out.line = t.line;
  if (t.seq) out.seq = t.seq;
  if (t.schedule) out.schedule = t.schedule;
  // 归档标记（2026-09-16 · 卡 AT18）：归档卡在对端整卡只读，board-merge 据此**写入前跳过**。
  // 旧快照不带此字段 ⇒ 对端只能靠"本机侧 archivedAt"兜底（并回器两路都判）；带上可提前分流、少走一轮 400。
  if (t.archivedAt !== undefined && t.archivedAt !== null && t.archivedAt !== '') out.archivedAt = t.archivedAt;
  const ex = Array.isArray(t.executions) ? t.executions : [];
  if (ex.length) {
    // 只留客观条数 + 末条状态（对端据此提示"本机无执行历史"）
    out.executionNote = { rounds: ex.length, lastResult: ex.at(-1)?.result ?? null };
  }
  return out;
}

/**
 * 「疑似 API key」形态判据（2026-09-16 收敛，替代旧 `[-_A-Za-z0-9]{16,}` 全文匹配）：
 *   · 强形态 = 前缀 + 分隔符(-/_) + 主体 ≥12 位 → 标准 key 一定有这个分隔符
 *     （旧规则漏此约束，才会把 `--skip-board-snapshot` 里的 `sk`+`ip-board-…` 吞掉）
 *   · LTAI 形态 = `LTAI` + 连续 alnum ≥12（阿里云 AccessKeyId：前缀即密钥形态，无分隔也报）
 *   · 小写前缀无分隔 = 前缀 + 连续 alnum ≥16 **且含数字**
 *     排除 `skippedAlreadyRestored`（camelCase，tasks[144] 实证）、`skyscraperphotography`（英文词）——
 *     纯字母串与标识符/英文词不可分，故"含数字"是这里唯一可靠的熵信号。
 */
const API_KEY_SEP = /\b(?:sk|ak|pk|ghp|glpat|LTAI)[-_][A-Za-z0-9][A-Za-z0-9_-]{11,}\b/;
const API_KEY_LTAI = /\bLTAI[A-Za-z0-9]{12,}\b/;
const API_KEY_PLAIN = /\b(?:sk|ak|pk|ghp|glpat)[A-Za-z0-9]{16,}\b/g;

function findApiKey(text) {
  const s = String(text ?? '');
  const strong = s.match(API_KEY_SEP);
  if (strong) return strong[0];
  const ltai = s.match(API_KEY_LTAI);
  if (ltai) return ltai[0];
  for (const m of s.matchAll(API_KEY_PLAIN)) if (/[0-9]/.test(m[0])) return m[0];
  return null;
}

/**
 * ★赋值类凭据探针的「非秘密形态」判据（2026-09-16 · 卡 AT13「误报形态 B」收敛）
 *
 * 旧探针 `(password|passwd|secret|token)\s*[:=]\s*\S{8,}` 只看"关键字 + 8 个非空白"，
 * 于是**卡文本里合法出现的凭据样例**被判成真凭证（主机 B 侧每轮 Depart ②c 恒 deferred）：
 *   · B1 取凭据代码：`const token = (r.stdout ?? "").match(/^password=(.+)$/m)?.[1];`
 *   · B2 尖括号占位：`` ?access_token=<token>` ``、`password=<your-password>`
 *   · B3 省略号占位：`?token=...`
 *   · B4 引用式    ：`token=${GITEE_TOKEN}`、`password=$env:APP_SECRET`、`secret=%APP_SECRET%`
 *
 * ⚠️ 判据是「**排除不可能是秘密的形态**」，**不是**「要求高熵」—— 弱口令（`hunter2hunter2`）、
 *    无数字长口令（`correcthorsebatterystaple`）、bcrypt 哈希（`$2b$10$…`）都必须照报。
 *    因此这里只排除：占位符/打码串、代码引用与取凭据写法、环境变量引用、纯省略号；
 *    **不做**长度阈值之外的任何"熵"要求（形态 A 卡已论证过熵判据会误伤标识符）。
 *    同时"跳过继续找下一处"而非整条放弃 —— 同一文本里先出现样例、后出现真凭证时，真凭证仍必须报。
 */
const PLACEHOLDER_WORD = /^(?:x{3,}|\*{2,}|\.{2,}|…+|redacted|change[-_]?me|placeholder|example|todo|your[-_ ]|my[-_ ])/i;
const CODE_REF = /(?:\?\?|\?\.\[|\.match\s*\(|process\.env|os\.environ|getenv\s*\(|\.stdout|\.stdin|=>)/;
const ENV_REF = /^(?:\$env:|\$\{|\$\(|%[A-Za-z_][A-Za-z0-9_]*%)/;
/**
 * B5 裸变量引用：`$giteeTok`（PowerShell/shell 变量）—— `$env:`/`${`/`$(` 已由 ENV_REF 覆盖，这是同族扩展。
 * ⚠️ `$` 后必须紧跟字母/下划线：`$2b$10$…`（bcrypt）、`$1$…`（md5-crypt）等哈希 `$` 后是数字 ⇒ 不豁免。
 */
const BARE_VAR_REF = /^\$[A-Za-z_]/;
/** B6 ① 成员访问链：`opts.launchToken` / `cfg.api.token`（代码取值形态，不是字面量口令） */
const IDENT_CHAIN = /^[$A-Za-z_][$A-Za-z0-9_]*(?:\.[$A-Za-z_][$A-Za-z0-9_]*)+/;
/** B6 ② 标识符头部（用于判"词根 + 后随非 ASCII"） */
const IDENT_HEAD = /^[$A-Za-z_][$A-Za-z0-9_]*/;
const SECRET_WORD = /(?:password|passwd|secret|token)/i;

/**
 * B6 判据：值是否是"散文里引用的代码标识符"（⇒ 豁免）。两子形态，见文件头。
 * 判定只看**值的头部**（`\S{8,}` 会把后随的中文标点/Markdown 标记一起吞进来）。
 */
function looksCodeIdentifier(v) {
  if (IDENT_CHAIN.test(v)) return true;                    // ① 成员访问链
  const m = v.match(IDENT_HEAD);
  if (!m) return false;
  const rest = v.slice(m[0].length);
  // ② 含凭据词根的标识符 + 后随非 ASCII（`launchToken，**进程级…`）——
  //    后随非 ASCII 是关键：真口令 `MyPassword123` 不会黏中文，故仍报（反向断言见 --self-test）。
  return SECRET_WORD.test(m[0]) && rest.length > 0 && !/^[\x00-\x7F]/.test(rest);
}

/** 剥掉包裹值的成对引号（反引号也算）后再判形态：`password: "S3cr3t…"` 不能被引号误伤 */
function stripWrap(s) {
  return String(s ?? '').replace(/^["'`]+/, '').replace(/["'`]+$/, '');
}

/** 该「值」是否属"根本不可能是秘密"的形态 → true = 豁免（不报） */
function looksNonSecret(rawValue) {
  const v = stripWrap(rawValue);
  if (!v) return true;
  if (PLACEHOLDER_WORD.test(v)) return true;   // 占位词 / 打码串
  if (CODE_REF.test(v)) return true;           // 取凭据代码（?? / .match( / process.env …）
  if (ENV_REF.test(v)) return true;            // 环境变量引用（不是密码本身）
  if (BARE_VAR_REF.test(v)) return true;       // B5：裸变量引用（$giteeTok），2026-09-23 卡「小修·1」
  if (looksCodeIdentifier(v)) return true;     // B6：代码标识符 / 成员访问链（launchToken、opts.x）
  if (/^[([{<.*…]/.test(v)) return true;       // 代码标点 / 括号 / 尖括号 / 省略号起头
  return false;
}

/** 「password 赋值」探针：逐处判定，跳过非秘密形态，返回第一处**真凭证**形态的赋值 */
function findSecretAssignment(text) {
  const s = String(text ?? '');
  const re = /(password|passwd|secret|token)\s*[:=]\s*(\S{8,})/gi;
  for (const m of s.matchAll(re)) {
    if (looksNonSecret(m[2])) continue;
    return m[0];
  }
  return null;
}

/** 敏感串体检：命中只告警（不退出），返回命中列表；每条 = label + probe(text)→命中串|null */
const SENSITIVE = [
  ['私钥块', (t) => t.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----/)?.[0] ?? null],
  ['疑似 API key', findApiKey],
  // Bearer 同批接入占位词豁免（`Bearer YOUR_TOKEN_HERE_1234567890` 是文档样例；真 token 高熵不受影响）
  ['Bearer token', (t) => {
    const m = String(t ?? '').match(/Bearer\s+([A-Za-z0-9._\-]{20,})/);
    if (!m || looksNonSecret(m[1])) return null;
    return m[0];
  }],
  ['password 赋值', findSecretAssignment],
];
export function scanSensitive(text) {
  const s = String(text ?? '');
  const hits = [];
  for (const [label, probe] of SENSITIVE) {
    const hit = probe(s);
    if (hit) hits.push({ label, sample: hit.slice(0, 24) + '…' });
  }
  return hits;
}

function selfTest() {
  let pass = 0; const fail = [];
  const ok = (c, m) => { if (c) pass++; else fail.push(m); };
  const spec = toSpecCard({
    id: 'x', title: 't', description: 'd'.repeat(30000), prompt: 'p', status: 'todo',
    executions: [{ result: 'succeeded' }, { result: 'failed' }], line: 'L', seq: 'S', workspaceId: 'W',
  });
  ok(spec.description.length === 30000, 'description 应完整保留（不截断）');
  ok(spec.workspaceId === undefined, 'workspaceId 必须剥离（对端映射）');
  ok(spec.executions === undefined, 'executions 必须剥离');
  ok(spec.executionNote.rounds === 2 && spec.executionNote.lastResult === 'failed', 'executionNote 应记条数与末条结果');
  ok(spec.line === 'L' && spec.seq === 'S', 'line/seq 应保留');
  ok(spec.permission === 'danger-full-access', 'permission 缺省补全');
  // —— 归档标记（2026-09-16 · 卡 AT18：并回器对归档卡恒报 400 的配套修复）——
  const arch = toSpecCard({ id: 'x', title: 't', description: 'd', prompt: 'p', status: 'done', archivedAt: 1789542591405 });
  ok(arch.archivedAt === 1789542591405, '归档卡必须带 archivedAt（对端 board-merge 据此跳过）');
  ok(toSpecCard({ id: 'y', title: 't', description: 'd', prompt: 'p', status: 'done' }).archivedAt === undefined, '未归档卡不得带 archivedAt 字段');
  ok(toSpecCard({ id: 'z', title: 't', description: 'd', prompt: 'p', status: 'done', archivedAt: '' }).archivedAt === undefined, 'archivedAt 空串按未归档处理');
  // —— 敏感串体检（2026-09-16 收敛：① 误报形态不命中 ② 真 key 形态必命中 ③ 长度边界）——
  // 真 key 形态样本一律**拼接构造**：字面量会被平台 push-protection 误判成真凭证
  const hit = (t) => scanSensitive(t).length > 0;
  ok(scanSensitive('hello world').length === 0, '干净文本不该命中');
  // ① 误报形态（现场真凶：参数名 `--skip-board-snapshot` 的 `sk`+`ip-board-snapshot` 被旧规则吞掉）
  ok(!hit('Depart 时不要加 --skip-board-snapshot 参数（形近 sk- 的历史误报样本）'), '误报：含 --skip-board-snapshot 的描述不得命中');
  ok(!hit('--skip-board-snapshot'), '误报：带前导 -- 的参数名不得命中');
  ok(!hit('skip-board-snapshot'), '误报：不带前导 -- 的参数名不得命中');
  ok(!hit('--skip-snapshot'), '误报：短参数名 --skip-snapshot 不得命中');
  ok(!hit('skyscraperphotography'), '误报：无分隔纯小写英文词不得命中（非密钥形态）');
  ok(!hit('skippedAlreadyRestored'), '误报：camelCase 标识符不得命中（tasks[144] 实证，含大小写混用但无数字）');
  ok(!hit('plan{plannedCopies,plannedIndexWrites,plannedMkdirs,skippedAlreadyRestored}'), '误报：实测原文片段不得命中');
  // ② 真 key 形态（红线：检出能力不许下降）
  ok(hit('key = ' + 'sk-' + 'abcdefghijklmnopqrstuvwxyz'), '真 key：sk- 长 key 必须命中');
  ok(hit('ghp_' + 'AbCd1234EfGh5678IjKl90MnOpQrStUvWx'), '真 key：ghp_ 必须命中');
  ok(hit('glpat' + '-AbCd1234EfGh5678IjKl'), '真 key：glpat- 必须命中');
  ok(hit('LTAI' + '5tAbCd1234EfGh5678'), '真 key：LTAI 必须命中');
  ok(hit('LTAI' + 'abcdefghijklmnopqrst'), '真 key：LTAI 无分隔纯字母也命中（前缀即形态）');
  ok(hit('sk' + 'Ab12Cd34Ef56Gh78Ij90'), '真 key：无分隔但含数字必须命中');
  ok(!hit('skAbCdEfGhIjKlMnOpQrStUv'), '边界：无分隔且纯字母不判 key（与 camelCase 标识符不可分）');
  ok(hit('-----BEGIN ' + 'RSA PRIVATE KEY-----'), '真 key：私钥块必须命中');
  ok(hit('Authorization: Bearer AbCd1234EfGh5678IjKl90'), '真 key：Bearer token 必须命中');
  ok(hit('password = hunter2hunter2'), '真 key：password 赋值必须命中');
  // ④ 误报形态 B（2026-09-16 卡 AT13：卡文本里**合法出现**的凭据样例 / URL 占位符 / 取凭据代码）
  //    来源 = 主机 B 侧真实快照逐条定位（host-b-2026-09-16T03-49-55-depart.json 3 处 + 主机 A 生产账本 10 处，
  //    全部落在看板卡 description/prompt 内，零真凭证）
  ok(!hit('const token = (r.stdout ?? "").match(/^password=(.+)$/m)?.[1];'), '误报B1：取凭据代码样例不得命中');
  ok(!hit('dsh web: http://127.0.0.1:3092/?token=... （URL 占位符）'), '误报B3：URL 占位符 ... 不得命中');
  ok(!hit('GET https://gitee.com/api/v5/repos/x/y?access_token=<token>`'), '误报B2：<token> 尖括号占位不得命中');
  ok(!hit('token=${GITEE_TOKEN}'), '误报B4：${VAR} 引用不得命中');
  ok(!hit('password=$env:APP_SECRET'), '误报B4：$env: 引用不得命中');
  ok(!hit('secret=%APP_SECRET%'), '误报B4：%VAR% 引用不得命中');
  ok(!hit('password = process.env.APP_PASSWORD'), '误报B1：process.env 取值不得命中');
  ok(!hit('password=<your-password>'), '误报B2：占位词不得命中');
  ok(!hit('password: "REDACTED"'), '误报B2：REDACTED 不得命中');
  ok(!hit('token = ********'), '误报B2：打码串不得命中');
  ok(!hit('Authorization: Bearer YOUR_TOKEN_HERE_1234567890'), '误报B2：Bearer 占位词不得命中');
  // ⑥ 误报形态 B5（2026-09-23 卡「小修·1」：裸 `$var` —— 本机账本 revision 4721 实测 3 张卡命中）
  ok(!hit('$env:OSS_PUSH_TOKEN = $giteeTok'), '误报B5：`$env:VAR = $var` 赋值（现场原文）不得命中');
  ok(!hit('token = $giteeTok'), '误报B5：裸 `$var` 值不得命中');
  ok(!hit('password = $APP_PASSWORD'), '误报B5：裸 `$VAR` 值不得命中');
  ok(!hit('password = $HOME/.ssh/id_rsa'), '误报B5：变量 + 路径值不得命中');
  // ⑦ 误报形态 B6（裸标识符 —— 同批实测 1 张卡命中 + 成员访问链）
  ok(!hit('token = launchToken，**进程级、每次启动随机、不落盘**'), '误报B6：标识符 + 中文黏连（现场原文）不得命中');
  ok(!hit('token = opts.launchToken'), '误报B6：成员访问链 `opts.x` 不得命中');
  ok(!hit('password = cfg.api.secret'), '误报B6：多级成员访问链不得命中');
  // ⑧ B5/B6 反向断言（红线：收敛**不得**放宽真凭证的命中）
  ok(hit('password = $2b$10$abcdefghijklmnopqrstuv'), '真凭证：`$` 后跟数字（bcrypt 形态）必须命中');
  ok(hit('password = MyPassword123'), '真凭证：含凭据词根但纯 ASCII（无中文黏连）必须命中');
  ok(hit('secret=SuperSecret99!'), '真凭证：含词根且带标点必须命中');
  ok(hit('token = buildLauncherCommand'), '真凭证：无词根无点号的标识符必须命中（与纯字母口令不可分，有意不豁免）');
  // 已知边界（有意保留，非缺陷）：无中文黏连的裸变量名仍报 —— 见交付报告「待拍板」
  ok(hit('token = GITEE_TOKEN'), '已知边界：`token = GITEE_TOKEN` 仍报（与真口令不可分；口径变更须主人拍板）');
  // ⑤ 真凭证（红线：判据只排除"不可能形态"，弱口令 / 无数字长口令 / 哈希都必须照报）
  ok(hit('password = hunter2hunter2'), '真凭证：弱口令赋值必须命中');
  ok(hit('password: "S3cr3t-P@ssw0rd!"'), '真凭证：引号包裹强口令必须命中（先剥引号再判形态）');
  ok(hit("GITEE_TOKEN='a1b2c3d4e5f6a7b8'"), '真凭证：单引号包裹 token 必须命中');
  ok(hit('access_token=6f1a2b3c4d5e6f7a8b9c0d1e2f'), '真凭证：access_token 长 hex 必须命中');
  ok(hit('password = correcthorsebatterystaple'), '真凭证：无数字长口令必须命中（不许加熵要求）');
  ok(hit('secret=$2b$10$abcdefghijklmnopqrstuv'), '真凭证：bcrypt 哈希必须命中（$ 起头但非 $env:/${）');
  ok(hit('note: 取法 token = (r.stdout ?? "") … 实际 password = hunter2hunter2'),
    '边界：误报形态在前、真凭证在后 → 仍必须报真凭证（跳过继续找，不是整条放弃）');
  ok(!hit('password = abc123'), '边界：赋值值 6 字符（<8）不得命中');
  // ③ 长度/边界（强形态主体 ≥12：11 位不报、12 位报）
  ok(!hit('sk-' + 'AbCd1234567'), '边界：sk- 主体 11 位不得命中');
  ok(hit('sk-' + 'AbCd12345678'), '边界：sk- 主体 12 位（临界）必须命中');
  ok(norm(' a  b ') === 'ab', 'norm 应折叠空白');
  ok(EXIT.ok === 0 && EXIT.failed === 1 && EXIT.sensitive === 3, '退出码契约必须是 0 / 1 / 3（handoff ②c 依赖）');
  console.log(`[self-test] ${pass} 项通过${fail.length ? '，' + fail.length + ' 项失败: ' + fail.join(' | ') : ''}`);
  return fail.length === 0;
}

/**
 * 真失败出口（退出码 1）：人读错误进 stderr，机器可读单行 JSON 进 stdout（--json 时）。
 * 「体检命中」不走这里 —— 那条路已出包，退出码 3。
 */
function fail(asJson, code, message) {
  console.error(`✖ ${message}`);
  if (asJson) console.log(JSON.stringify({ ok: false, status: 'failed', code, error: message }));
  process.exitCode = EXIT.failed;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) { process.exitCode = selfTest() ? 0 : 1; return; }
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
  const label = opt('--label', 'board-snapshot');
  const outDir = opt('--out', SNAP_DIR);
  const asJson = args.includes('--json');

  const lp = ledgerPath();
  if (!fs.existsSync(lp)) return fail(asJson, 'ledger-missing', `账本不存在：${lp}`);
  const raw = fs.readFileSync(lp, 'utf8');
  let ledger;
  try { ledger = JSON.parse(raw); } catch (e) { return fail(asJson, 'ledger-unparsable', `账本解析失败：${e.message}`); }

  const tasks = Array.isArray(ledger.tasks) ? ledger.tasks : [];
  const spec = {
    schemaVersion: 1,
    kind: 'task-board-merge-snapshot',
    fromHost: hostName(),
    label,
    exportedAt: new Date().toISOString(),
    sourceRevision: ledger.revision ?? null,
    taskCount: tasks.length,
    note: '由 board-snapshot-export.mjs 生成；对端用 board-merge.mjs 走 Host HTTP API 并回。不含凭据/路径。',
    tasks: tasks.map(toSpecCard),
  };

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `${hostName()}-${stamp}-${label}.json`;
  const outPath = path.join(outDir, fileName);
  const text = JSON.stringify(spec, null, 2);
  const hits = scanSensitive(text);

  fs.writeFileSync(outPath, text, 'utf8');
  const summary = {
    ok: true,
    status: hits.length ? 'sensitive' : 'ok', // ok=干净出包 / sensitive=体检命中待人工核验（均已出包）
    outPath, taskCount: spec.taskCount, revision: spec.sourceRevision,
    byStatus: tasks.reduce((a, t) => (a[t.status] = (a[t.status] ?? 0) + 1, a), {}),
    sensitiveHits: hits,
  };
  // ⚠️ --json 必须**单行 compact**：调用方（handoff.mjs ②c）按 stdout 尾行解析；
  //    多行美化会让尾行变成 "}" → 解析失败 → 调用方误判"导出失败"（2026-09-16 事故根因之二）。
  if (asJson) console.log(JSON.stringify(summary));
  else {
    console.log(`✔ 快照已导出：${outPath}`);
    console.log(`  卡数 ${spec.taskCount}（revision ${spec.sourceRevision}） 状态分布 ${JSON.stringify(summary.byStatus)}`);
    if (hits.length) {
      console.warn(`  ⚠ 敏感串体检命中 ${hits.length} 处（请人工核验后再过仓）：`);
      for (const h of hits) console.warn(`    · ${h.label} → ${h.sample}`);
    } else console.log('  敏感串体检：未命中');
    console.log('  下一步：把该文件随仓3 推送，对端跑 board-merge.mjs --snapshot <文件> --dry-run');
  }
  process.exitCode = hits.length ? EXIT.sensitive : EXIT.ok; // 3 = 有告警但已出包（过仓前请核验）
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) main();
