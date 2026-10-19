// tools\lib\production-guard.mjs —— **生产路径闸**（R-060「隔离闸」的共享件 · 2026-10-16）
//
// 一句话：演练 / 恢复 / 回滚 / 清理类脚本动**生产树**里的东西之前，必须在**机器层**被拦住 ——
//   没显式 `--allow-production` ⇒ 拒跑（不是"警告后继续"），参数认不出 ⇒ fail-closed（绝不静默回落默认根）。
//
// ❗来由（近两月 7 起「演练/测试打到生产」，根因 5/7 = 「参数形态没认出 ⇒ 静默回落默认生产根」）：
//   ① 2026-09-13 六包①-2：沙箱演练传 `--root=<路径>`（**等号形态**）被恢复脚本静默忽略 ⇒ `--apply` 真回滚了生产
//   ② 2026-09-17 15:20 ③-1：**同形态再犯** ⇒ 误打生产 report.mjs
//   ③ 2026-09-16 17:34 冷接机：`merge-pitfalls`/`merge-memory` 按 USERPROFILE 解析**本机**目录 ⇒ 污染生产坑库+记忆库
//   ④ 2026-09-16 13:3x 坑17：沙盒守卫只挡首选分支 ⇒ 回退路径 `Stop-Process` 真杀生产 dsh
//   ⑤ 2026-09-14 环境边界：测试实例继承宿主 `DSH_WEB_URL=3080` ⇒ deploy 自检/面板误打生产
//   ⑥ 2026-10-08 P1：看板客户端 baseUrl 硬编码 3080 ⇒ 测试实例动作打到**生产账本**
//   ⑦ 2026-10-13 V7 卡：**junction 物理路径**绕过「只比逻辑根」的闸 ⇒ 误对生产落盘 6 件
//   真源 = `docs\大管家V3.0.0-需求收集-20260929.md` §4 R-060（含逐条取证）。
//
// ───────────────── 三条硬口径（改本文件前先读） ─────────────────
//   ① **不是第二份参数解析**：一律 `import { parseArgs } from './deploy-guard.mjs'` 再往外套，
//      单一真源在 deploy-guard。本文件只做「生产树判定 + 显式放行 + dry-run 第一道门」。
//   ② **生产判定 = realpath + 逻辑路径双比**：任一侧落在生产树内即算生产。
//      为什么两边都要：`<workspace>\_archive` / `logs` / `generated` / `backups` / `snapshots` 是 **junction**
//      （realpath 落到 `<offsync>\...`，看着在树外）、而 `_tmp` 里又可能出现反向链接（逻辑在树外、
//      realpath 落回生产实体）⇒ 只比一侧，另一侧就能绕过（V7 卡事故形态）。
//   ③ **dry-run 是第一道门，且必须在函数内**：`gateProductionWrite` 第一件事就是判 dryRun。
//      调用方的写盘函数**也必须**把 `if (dryRun) return <计划>` 放在**第一行** —— 只在 CLI 层判挡不住
//      "演练传 dryRun:true 也真动手"（R-065 取证②：六包①-2 / ③-1 两次同源事故）。
//
//   ④ 【2026-10-16 · R-067 追加】**放行被真正用上时，记一条"绕过留痕"**（`bypass-ledger.mjs`）；
//      这是本文件唯一的写盘动作，**且是 fail-open 的观察面、不是闸门**：
//        · 记的是"门判为拦 + 显式放行真的放过去了"（`allowProduction===true` 且真有生产目标命中）；
//        · **dry-run 一次都不记**（dry-run 在第一道门就返回，压根走不到放行分支）；
//        · 台账写失败**绝不**反过来拒跑 / 改返回值 / 抛错 —— 详情见 `tools\lib\bypass-ledger.mjs` 头注；
//        · 不想要这条痕迹的调用方（夹具自测 / 调用方已自行记录）：传 `ledgerBypass: false` 抑制。
//      为什么必须在这儿接：本文件是 ~50 支 `--allow-production` 脚本的**单一真源**，
//      接一处就覆盖全部走共享件的脚本；散在各脚本里接 = 迟早漏一批（R-067 的病根就是"绕过不可见"）。
//      ⇒ 本文件的自我描述由"**零 IO**"订正为"**除绕过留痕台账外零 IO**"。
//
// ───────────────── 接入三步（试点脚本照抄） ─────────────────
//   import { parseProductionArgs, gateProductionWrite, refuseLine, EXIT } from '../lib/production-guard.mjs';
//   ① 参数：`const pa = parseProductionArgs(argv, KNOWN, { withDryRun: true })`
//            `if (!pa.ok) { console.error(describeUnknown(pa.unknown, pa.known)); process.exitCode = EXIT.USAGE; return }`
//            ⚠️ KNOWN 里**不要**再写 `--allow-production`（共享件已带）；位置参数/`--key=值`形态由 parseArgs 兜住。
//   ② 写前：`const g = gateProductionWrite({ targets: [...], allowProduction: pa.allowProduction, dryRun, reason: '...' })`
//            `if (!g.ok) { console.error(refuseLine(g)); process.exitCode = g.exitCode; return }`
//   ③ 缺省：`dryRun = pa.dryRun`（缺省 dry-run 是生态规矩）；**真写**才需要 `--allow-production`。
//
// 退出码口径（与 `deploy-guard.mjs` / 既有 ~50 支 `--allow-production` 脚本一致）：
//   0 = 通过 · 1 = 门禁未过（EXIT.GATE · 调用方自行决定用不用）· 2 = 用法/参数错 **或"缺 --allow-production"**
//   ⇒ 缺放行开关**默认给 2**（= "你没给我需要的东西"，与 memory-schema-migrate / butler-pools-apply 等既有脚本同口径，
//      也便于本卡判据 J2「目标指生产 + 不给放行 ⇒ exit 2」逐支现跑复现）。
//
// 本文件自身**零 IO**（只读 realpath / readdir 不产生副作用）、不写任何文件、不 exit（退出码由调用方落）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseArgs, describeUnknown, normalizePath, EXIT } from './deploy-guard.mjs';
import { recordBypass } from './bypass-ledger.mjs';
import { DSH_WORKSPACE, ARCHIVE_DIR, OFFSYNC_DIR } from './workspace.mjs';

// 参数解析单一真源 = deploy-guard（本文件**不**再写一份）
export { parseArgs, describeUnknown, normalizePath, EXIT };

/** 放行开关（与生态既有 ~50 支脚本同名同形）。 */
export const ALLOW_FLAG = '--allow-production';
/** 只读演练开关（缺省即 dry-run 的脚本可不加；共享件按需注入白名单）。 */
export const DRY_RUN_FLAG = '--dry-run';
/** 生产树根之一：DSH 主树。 */
export const DSH_ROOT = DSH_WORKSPACE;

// ───────────────────────────────────────────────────────── 1) 路径工具

/** 去尾部分隔符（已是最短的盘符根形态则不动）。 */
function stripTail(p) {
  const s = String(p);
  if (/^[a-zA-Z]:[\\/]?$/.test(s)) return s.slice(0, 2) + '\\';
  return s.replace(/[\\/]+$/, '') || s;
}

/** 统一成绝对 + 反斜杠形态（Windows 下 path.resolve 已是反斜杠；跨形态输入如 `<workspace>/x` 也归一）。 */
export function normSep(p) {
  return stripTail(path.resolve(String(p))).replace(/\//g, '\\');
}

/**
 * 前缀判定（**大小写不敏感 + 分隔符感知**）。
 * ⚠️ 不用简单 startsWith：`<workspace>X` 会被 `<workspace>` 误判命中（少一个分隔符的经典坑）。
 */
export function isUnder(child, root) {
  const c = normSep(child).toLowerCase();
  const r = normSep(root).toLowerCase();
  return c === r || c.startsWith(r.endsWith('\\') ? r : r + '\\');
}

// ───────────────────────────────────────────────────────── 2) 生产树判定

/**
 * R-067：留痕里的"调用方"是谁 —— 取**入口脚本文件名**（`process.argv[1]` 的 basename）。
 * 为什么不用 cwd / session：绕过痕迹要能一眼看出"哪个脚本放行的"，脚本名最直接；
 * 路径可能很长（几十个字符）⇒ 只取 basename，路径详情在 `target` / `detail` 里。
 * ⚠️ realpath 归一（junction 子目录里跑 node 时 argv[1] 是逻辑路径、basename 仍对，但要防 `..` 形态）。
 */
function actorOf(argv = process.argv) {
  try {
    const p = String(argv?.[1] ?? '');
    return p ? path.basename(p) : '(未知调用方)';
  } catch { return '(未知调用方)'; }
}

/**
 * 生产树根清单（默认 = `<workspace>` 与 `~/.dsh`）。
 * @param {{roots?:string[], dshRoot?:string, home?:string}} [opts]
 *        三个覆盖项**只给夹具/自测用**（例：把夹具目录声明成"生产树"来验拦截；测试 home 声明成非生产）；
 *        **生产调用一律用默认值**，别给脚本开"改根"的口子（那是新的绕过面）。
 * @returns {Array<{label:string, logical:string, real:string}>} 每根都给「逻辑」「realpath」两面
 */
export function productionRoots(opts = {}) {
  const raw = Array.isArray(opts.roots) && opts.roots.length
    ? opts.roots
    : [opts.dshRoot ?? DSH_ROOT, opts.home ?? path.join(os.homedir(), '.dsh')];
  return raw.map((r) => ({
    label: String(r),
    logical: normSep(r),
    real: normSep(normalizePath(r)), // `<workspace>` 本体是真实目录；仍两边都算，防将来被改成链接
  }));
}

/**
 * 判定单个目标：是不是落在生产树内。
 * **realpath + 逻辑路径双比**：任一侧命中即 `isProduction:true`。
 * @param {string} p 目标路径（绝对或相对，相对按 cwd 解析）
 * @param {object} [opts] 见 productionRoots（roots/dshRoot/home 仅夹具用）
 * @returns {{input:string, logical:string, real:string, isProduction:boolean,
 *            matchedBy:Array<{root:string, side:'logical'|'real'}>, roots:string[]}}
 */
export function classifyTarget(p, opts = {}) {
  const input = String(p ?? '');
  const roots = productionRoots(opts);
  const logical = normSep(input);
  const real = normSep(normalizePath(input));
  const matchedBy = [];
  for (const r of roots) {
    if (isUnder(logical, r.logical)) matchedBy.push({ root: r.label, side: 'logical' });
    if (isUnder(real, r.real)) matchedBy.push({ root: r.label, side: 'real' });
  }
  return {
    input,
    logical,
    real,
    isProduction: matchedBy.length > 0,
    matchedBy,
    roots: roots.map((r) => r.label),
  };
}

/** 便捷布尔版。 */
export function isProductionPath(p, opts = {}) {
  return classifyTarget(p, opts).isProduction;
}

/** 把一条判定渲染成人话（报告/错误信息里直接用）。 */
export function describeTarget(c) {
  const sides = c.matchedBy.map((m) => `${m.side === 'logical' ? '逻辑路径' : 'realpath'}命中 ${m.root}`).join(' / ');
  const cross = c.logical.toLowerCase() !== c.real.toLowerCase()
    ? `（逻辑 ${c.logical} → realpath ${c.real}，junction 跨面）`
    : '';
  return `${c.logical}${cross}  ← ${sides || '不在生产树内'}`;
}

// ───────────────────────────────────────────────────────── 3) 参数解析（薄包装）

/**
 * 生产闸版参数解析：deploy-guard 的 fail-closed 白名单 + 本域默认开关。
 * **不另写解析**：`--root=<路径>` 这种等号形态与 `--root <路径>` 两种写法都由它解析成同一个「值」，
 * 认不出的 token（未知参数 / 位置参数 / 布尔开关带 `=值`）一律进 `unknown` ⇒ `ok:false` ⇒ 调用方 rc=2。
 * @param {string[]} argv process.argv.slice(2)
 * @param {Array<string|{flag:string,takesValue?:boolean,alias?:string}>} [known] 脚本自己的参数（**别写 --allow-production**）
 * @param {{withDryRun?:boolean}} [opts] withDryRun=true 时把 `--dry-run` 也纳入白名单
 * @returns {ReturnType<typeof parseArgs> & {known:Array, allowProduction:boolean, dryRun:boolean}}
 */
export function parseProductionArgs(argv, known = [], opts = {}) {
  const spec = [{ flag: ALLOW_FLAG, takesValue: false }];
  if (opts.withDryRun) spec.push({ flag: DRY_RUN_FLAG, takesValue: false });
  for (const k of known) spec.push(k);
  const pa = parseArgs(argv, spec);
  return {
    ...pa,
    known: spec,
    allowProduction: pa.flags[ALLOW_FLAG] === true,
    dryRun: pa.flags[DRY_RUN_FLAG] === true,
  };
}

// ───────────────────────────────────────────────────────── 4) 单调用点闸门

/** 目标归一：接受字符串，或 `{path, label}` 对象（便于错误信息点名"这是哪个参数"）。 */
function normalizeTarget(t) {
  if (t && typeof t === 'object') return { path: String(t.path ?? ''), label: t.label ? String(t.label) : '' };
  return { path: String(t ?? ''), label: '' };
}

/**
 * **生产写入闸（单调用点）**：所有"我要写/删/回滚这些路径"的地方都走它。
 *
 * 第一道门 = **dry-run**（函数内第一条语句，不是 CLI 层）：dryRun=true 一律放行且**不做任何判定外的动作**
 * —— 语义是"你只是要一份计划，闸门不该拦计划"（真正的保护来自调用方把 `if (dryRun) return` 放在写盘函数第一行）。
 *
 * @param {object} o
 * @param {Array<string|{path:string,label?:string}>} o.targets 本次**要写/删/回滚**的目标（只读计划不必传）
 * @param {boolean} [o.allowProduction] 是否显式给了 `--allow-production`
 * @param {boolean} [o.dryRun] 是否 dry-run（true ⇒ 直接放行，零判定副作用）
 * @param {string} [o.reason] 人话说明（写进拒绝文案，例：`回滚 P2 单元`）
 * @param {string} [o.op='写'] 动词（写 / 删 / 回滚 / 搬移），只影响文案
 * @param {number} [o.exitCode] 拒绝时的建议退出码（缺省 EXIT.USAGE=2；想用"门禁未过"档传 EXIT.GATE=1）
 * @param {object} [o.pathOpts] 传给 classifyTarget 的覆盖项（**仅夹具/自测**）
 * @param {boolean} [o.ledgerBypass=true] R-067：放行真被用上时记不记绕过台账（`false` = 不记；夹具自测用）
 * @returns {{ok:boolean, dryRun:boolean, allowProduction:boolean, refuse?:string, code?:string,
 *            exitCode:number, reason:string, hits:Array, checked:Array}}
 */
export function gateProductionWrite(o = {}) {
  // ── ⑨ dry-run 第一道门（**必须是本函数第一条语句**；R-065② / R-060 硬要求）
  if (o.dryRun === true) {
    return {
      ok: true, dryRun: true, allowProduction: o.allowProduction === true,
      exitCode: EXIT.OK, reason: 'dry-run（零写入）—— 生产闸不参与（闸只管真写/真删/真回滚）',
      hits: [], checked: [],
    };
  }

  const targets = (Array.isArray(o.targets) ? o.targets : []).map(normalizeTarget).filter((t) => t.path);
  const checked = targets.map((t) => ({ ...classifyTarget(t.path, o.pathOpts ?? {}), label: t.label }));
  const hits = checked.filter((c) => c.isProduction);
  const exitCode = Number.isInteger(o.exitCode) ? o.exitCode : EXIT.USAGE;
  const op = o.op ?? '写';

  if (hits.length === 0) {
    return {
      ok: true, dryRun: false, allowProduction: o.allowProduction === true,
      exitCode: EXIT.OK, reason: `目标均不在生产树内（${checked.length} 项已判）· 零拦截`, hits: [], checked,
    };
  }

  if (o.allowProduction === true) {
    // R-067：放行**真的被用上**（有生产目标命中）⇒ 留一条绕过痕迹。fail-open，绝不改本函数返回值语义。
    if (hits.length && o.ledgerBypass !== false) {
      recordBypass({
        gate: 'allow-production',
        reason: o.reason ?? null,
        actor: actorOf(),
        target: hits.map((c) => c.logical ?? c.path).slice(0, 6).join(' ; '),
        detail: { op, hitCount: hits.length },
      });
    }
    return {
      ok: true, dryRun: false, allowProduction: true,
      exitCode: EXIT.OK,
      reason: `已显式放行（${ALLOW_FLAG}）⇒ 允许对生产树${op}（${hits.length} 项）`,
      hits, checked,
    };
  }

  const lines = [
    `❌ 拒绝：${op}目标落在**生产树**内，但没给放行开关（R-060 隔离闸 · fail-closed）。`,
    ...hits.slice(0, 6).map((c) => `   · ${c.label ? `[${c.label}] ` : ''}${describeTarget(c)}`),
    hits.length > 6 ? `   · ……另有 ${hits.length - 6} 项同样命中生产树` : null,
    `   要真动它：显式加 \`${ALLOW_FLAG}\`（例：node <本脚本> … ${ALLOW_FLAG}）。`,
    `   只是演练/自测：把目标指到隔离目录（%TEMP%\\<夹具> 或测试 home），别指向生产树。`,
    `   只想要一份计划：用 dry-run/--plan 形态（零写入，不需要放行开关）。`,
    o.reason ? `   本次动作：${o.reason}` : null,
  ].filter(Boolean);

  return {
    ok: false, dryRun: false, allowProduction: false,
    refuse: 'need-allow-production', code: 'need-allow-production',
    exitCode, reason: lines.join('\n'), hits, checked,
  };
}

/** 拒绝文案（调用方：`console.error(refuseLine(g))`）。放着方便统一格式。 */
export function refuseLine(gate) {
  return gate?.reason ?? '❌ 拒绝：生产闸未通过';
}

/**
 * 缺省-dry-run 的便捷包装：`planOnly(state)` 给"只读计划"，`apply(state)` 给"真执行"。
 * dry-run 时**只调 planOnly**（apply 绝不进）；非 dry-run 时先过生产闸，再调 apply。
 * 给"想在函数内做第一道门但懒得写样板"的调用方用；不强制。
 */
export function runGuarded({ dryRun, targets, allowProduction, reason, op, exitCode, pathOpts, planOnly, apply }) {
  const plan = typeof planOnly === 'function' ? planOnly() : planOnly;
  if (dryRun === true) return { ok: true, dryRun: true, plan, applied: false, gate: null };
  const gate = gateProductionWrite({ targets, allowProduction, dryRun: false, reason, op, exitCode, pathOpts });
  if (!gate.ok) return { ok: false, dryRun: false, plan, applied: false, gate };
  const applied = typeof apply === 'function' ? apply() : apply;
  return { ok: true, dryRun: false, plan, applied: true, result: applied, gate };
}

// 供测试/自检用：`node production-guard.mjs --selftest`（只读，不写盘）
if (process.argv[1] && /production-guard\.mjs$/i.test(process.argv[1]) && process.argv.includes('--selftest')) {
  const roots = productionRoots();
  console.log('生产树根：');
  for (const r of roots) console.log(`  · ${r.label}   逻辑=${r.logical}   realpath=${r.real}`);
  for (const p of [path.join(DSH_ROOT, 'docs', 'x.md'), path.join(os.homedir(), '.dsh', 'butler-version.json'), path.join(ARCHIVE_DIR, 'r060', 'x'), path.join(OFFSYNC_DIR, 'deep', '_archive', 'x')]) {
    const c = classifyTarget(p);
    console.log(`${c.isProduction ? '生产 ' : '非生产'} ${describeTarget(c)}`);
  }
  console.log(`\n本文件零写入；只读自检完成。可用开关：${ALLOW_FLAG}`);
  process.exitCode = EXIT.OK;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 【R-065 · 锁6 · 2026-10-16】「删除 / 搬移三件套强制化」—— 本段是**追加**：
//   上方 R-060 段的既有导出与行为**一字未改**（向后兼容，老调用方不受影响）。
//
// 三件套 + 一条新判据：
//   ① **reparse point 拒删**：目标自身、或目标树内任何 junction / 符号链接 ⇒ 拒
//      （防「跟删」把链接指向的真实数据一起删掉 —— 2026-09-09 `.dsh\dsh-imagegen` 生图历史永久损失形态）。
//   ② **白名单拒跑**：目标必须落在调用方声明的白名单根之下；**不声明白名单 = 拒跑**
//      （治根因 5/7：「参数形态没认出 ⇒ 静默回落默认根」）。
//   ③ **dry-run 是"写动作函数"里的第一道门**：`runDestructive()` 保证 dry-run 下 `apply` 回调**永不进**；
//      调用方的写/删函数也必须把 `if (dryRun) return <计划>` 放在第一行。
//   ④ **作用域必须点明**（本卡新增 · 取证 `docs\事故-隔离演练误杀生产dsh-20261016.md`）：
//      「dry-run / 隔离」都要写清覆盖了哪几个面（文件面 / 进程面 / 网络面）；
//      **动作触及的面 ⊄ 声明的面 ⇒ 拒**。
//      🔴 **进程面闸刻意放在 dry-run 门之前** —— 今天的第 5 起同族事故正是「dry-run 传了、文件面隔离了、
//         进程面没隔离」⇒ 演练把生产 dsh 真杀了。**dry-run 不豁免进程面判定。**
//
// 接入（试点脚本照抄）：
//   import { runDestructive } from '../lib/production-guard.mjs';
//   const r = runDestructive({
//     targets: [...], whitelist: [ALLOWED_ROOT], op: '删', scope: ['file'], requires: ['file'],
//     dryRun, allowProduction: pa.allowProduction, reason: '清归档临时目录',
//     planOnly: () => ({ would: '删 3 个目录' }),
//     apply: () => { if (dryRun) return null; /* 真删 */ },
//   });
//   if (!r.ok) { console.error(r.reason); process.exitCode = r.exitCode; return; }
//
// 退出码：0 通过 · 1 门禁未过（调用方自定）· 2 用法错 / 缺 --allow-production · **3 被拒（reparse / 白名单 / 作用域 / 进程面）**
// 逃生舱（都要显式、都留痕在返回值里）：`--allow-reparse` · `--on-scan-error warn` · `DSH_DESTRUCTIVE_GUARD=off`
// 本段同样**零写入**（只读 lstat / readdir），不删不动任何文件。
// ═══════════════════════════════════════════════════════════════════════════════

/** R-065 专用退出码（0/1/2 沿用生态口径，**3 = 被拒**，与 file-lease 的"被占用"同档语义）。 */
export const DESTRUCTIVE_EXIT = { OK: 0, GATE: 1, USAGE: 2, REFUSE: 3 };
/** 作用域三个面（R-065④）。 */
export const SCOPE_AREAS = ['file', 'process', 'network'];
/** 单次扫描条目上限（超限 = 没扫完 ⇒ fail-closed）。 */
export const DEFAULT_MAX_SCAN_ENTRIES = 200000;
/** 单次扫描深度上限。 */
export const DEFAULT_MAX_SCAN_DEPTH = 64;
/** 逃生舱环境变量（`off` 才是关；其它值一律不放行）。 */
export const DESTRUCTIVE_ESCAPE_ENV = 'DSH_DESTRUCTIVE_GUARD';
/** 生产端口默认值（进程面判定用）。 */
export const DEFAULT_PROD_PORTS = [3080];

const SCOPE_ZH = { file: '文件面', process: '进程面', network: '网络面' };

/** 逃生舱：只有显式 `DSH_DESTRUCTIVE_GUARD=off` 才放行（其余值一律按开）。 */
export function destructiveGuardEnabled(env = process.env) {
  return String(env?.[DESTRUCTIVE_ESCAPE_ENV] ?? '').trim().toLowerCase() !== 'off';
}

// ───────────────────────────────────────────────────── 5) R-065 ① reparse point 判定

/**
 * 单点 lstat：是不是 reparse point（junction / 符号链接 / 挂载点）。**只读、零副作用**。
 * 判据 = Node `lstat.isSymbolicLink()`：Windows 上 libuv 按 `FILE_ATTRIBUTE_REPARSE_POINT` 归类
 * ⇒ junction、符号链接、卷挂载点都会命中（宁可判宽，安全件方向）。
 */
export function lstatReparse(p) {
  const out = { path: normSep(p), exists: false, isReparse: false, kind: null, pointsTo: null, pointsToDir: null, error: null };
  let st = null;
  try { st = fs.lstatSync(p); }
  catch (e) { out.error = e?.code ?? String(e?.message ?? e); return out; }
  out.exists = true;
  if (st.isSymbolicLink()) {
    out.isReparse = true;
    out.kind = 'link(junction/symlink)';
    try { out.pointsTo = fs.readlinkSync(p); } catch { out.pointsTo = null; }
    try { out.pointsToDir = fs.statSync(p).isDirectory(); } catch { out.pointsToDir = null; }
  }
  return out;
}

/** 便捷布尔版。 */
export function isReparsePoint(p) {
  return lstatReparse(p).isReparse;
}

/**
 * 递归扫目标树里的 reparse point。**只读**（readdir + lstat），不跟随链接、不进链接内部。
 * fail-closed 口径：扫不动（EACCES 等）/ 超条目上限 / 超深度 ⇒ 记 `errors` / `truncated`
 * ⇒ 由调用方（`gateReparse`）按 `onScanError` 决定拒绝还是只警告。
 * @param {string} root 目标（删/搬的根）
 * @param {{maxEntries?:number, maxDepth?:number, followSelf?:boolean}} [opts]
 * @returns {{root:string, ok:boolean, missing:boolean, hits:Array, scanned:number, dirs:number,
 *            truncated:boolean, errors:Array, stopReason:string|null, elapsedMs:number}}
 */
export function scanReparsePoints(root, opts = {}) {
  const t0 = Date.now();
  const maxEntries = Number.isInteger(opts.maxEntries) && opts.maxEntries > 0 ? opts.maxEntries : DEFAULT_MAX_SCAN_ENTRIES;
  const maxDepth = Number.isInteger(opts.maxDepth) && opts.maxDepth > 0 ? opts.maxDepth : DEFAULT_MAX_SCAN_DEPTH;
  const res = {
    root: normSep(root), ok: true, missing: false, hits: [], scanned: 0, dirs: 0,
    truncated: false, errors: [], stopReason: null, elapsedMs: 0,
  };
  const self = lstatReparse(root);
  if (!self.exists) {
    res.missing = true;
    if (self.error && self.error !== 'ENOENT') res.errors.push({ path: res.root, error: self.error });
    res.stopReason = 'missing';
    res.elapsedMs = Date.now() - t0;
    return res;
  }
  if (self.isReparse) {
    res.hits.push({ path: res.root, rel: '.', side: 'self', kind: self.kind, pointsTo: self.pointsTo, pointsToDir: self.pointsToDir });
    if (!opts.followSelf) { res.stopReason = 'self-is-link'; res.elapsedMs = Date.now() - t0; return res; }
  }
  if (!self.isReparse || opts.followSelf) {
    let isDir = false;
    try { isDir = fs.statSync(root).isDirectory(); }
    catch (e) { res.errors.push({ path: res.root, error: e?.code ?? String(e?.message ?? e) }); res.stopReason = 'stat-failed'; res.elapsedMs = Date.now() - t0; return res; }
    if (!isDir) { res.stopReason = 'not-a-dir'; res.elapsedMs = Date.now() - t0; return res; }
  }
  const stack = [{ dir: path.resolve(root), depth: 0 }];
  while (stack.length) {
    const cur = stack.pop();
    let ents = null;
    try { ents = fs.readdirSync(cur.dir, { withFileTypes: true }); }
    catch (e) { res.errors.push({ path: cur.dir, error: e?.code ?? String(e?.message ?? e) }); continue; }
    res.dirs += 1;
    for (const ent of ents) {
      const full = path.join(cur.dir, ent.name);
      res.scanned += 1;
      if (res.scanned > maxEntries) { res.truncated = true; res.stopReason = 'max-entries'; break; }
      let isLink = false;
      try { isLink = ent.isSymbolicLink(); } catch { isLink = false; }
      if (isLink) {
        const info = lstatReparse(full);
        res.hits.push({
          path: full, rel: path.relative(root, full) || '.', side: 'inside',
          kind: info.kind, pointsTo: info.pointsTo, pointsToDir: info.pointsToDir,
        });
        continue; // 命中即不进 —— 跟进去正是"跟删面"
      }
      if (ent.isDirectory()) {
        if (cur.depth + 1 <= maxDepth) stack.push({ dir: full, depth: cur.depth + 1 });
        else { res.truncated = true; res.stopReason = 'max-depth'; }
      }
    }
    if (res.truncated && res.stopReason === 'max-entries') break;
  }
  res.elapsedMs = Date.now() - t0;
  return res;
}

/**
 * ① reparse 闸：目标树里有任何 reparse point ⇒ 拒（exit 3）。
 * `allowReparse:true` = 显式逃生舱（要留痕）；扫不动 / 没扫完默认也拒（`onScanError:'warn'` 才降级为警告）。
 */
export function gateReparse(o = {}) {
  const targets = (Array.isArray(o.targets) ? o.targets : []).map(normalizeTarget).filter((t) => t.path);
  const onScanError = o.onScanError === 'warn' ? 'warn' : 'refuse';
  const scans = targets.map((t) => ({ label: t.label, ...scanReparsePoints(t.path, { maxEntries: o.maxEntries, maxDepth: o.maxDepth, followSelf: o.followSelf }) }));
  const hits = [];
  for (const s of scans) for (const h of s.hits) hits.push({ ...h, label: s.label, root: s.root });
  const errors = scans.flatMap((s) => s.errors.map((e) => ({ ...e, label: s.label })));
  const truncated = scans.some((s) => s.truncated);
  const missing = scans.filter((s) => s.missing).map((s) => s.root);
  const base = { hits, scans, errors, truncated, missing, onScanError, allowReparse: o.allowReparse === true };

  if (hits.length && o.allowReparse !== true) {
    const lines = [
      `❌ 拒绝：目标树内命中 **${hits.length}** 个 reparse point（junction / 符号链接）⇒ 判为"跟删高危"（R-065① · fail-closed）。`,
      ...hits.slice(0, 8).map((h) => `   · ${h.label ? `[${h.label}] ` : ''}${h.path}${h.side === 'self' ? '（目标自身）' : ''} → ${h.pointsTo ?? '(读不到目标)'}`),
      hits.length > 8 ? `   · ……另有 ${hits.length - 8} 个` : null,
      `   递归删 / 搬移会**跟着链接把目标里的真实数据一起删掉**（2026-09-09 生图历史永久损失就是这个形态）。`,
      `   要删的是链接本身：用 \`cmd /c rd "<链接路径>"\` 单独摘链接（不递归）。`,
      `   确实要连真实数据一起删：显式加 \`--allow-reparse\`（留痕、责任自负）。`,
    ].filter(Boolean);
    return { ...base, ok: false, code: 'reparse-hit', exitCode: DESTRUCTIVE_EXIT.REFUSE, reason: lines.join('\n') };
  }
  // R-067：命中 reparse 却仍显式放行 ⇒ 留痕（两条分支都要覆盖：`--allow-reparse` 是唯一入口）。
  if (hits.length && o.allowReparse === true && o.ledgerBypass !== false) {
    recordBypass({
      gate: 'allow-reparse',
      reason: o.reason ?? null,
      actor: actorOf(),
      target: hits.map((h) => h.path).slice(0, 6).join(' ; '),
      detail: { hitCount: hits.length },
    });
  }
  if ((errors.length || truncated) && onScanError === 'refuse') {
    const lines = [
      `❌ 拒绝：**没能把目标树扫完** ⇒ 无法断言"树里没有 junction"（R-065① · fail-closed）。`,
      truncated ? `   · 扫描被上限截断（条目/深度超限）⇒ 后面还有没扫到的地方。` : null,
      ...errors.slice(0, 5).map((e) => `   · ${e.path} —— ${e.error}`),
      errors.length > 5 ? `   · ……另有 ${errors.length - 5} 处读不动` : null,
      `   处置：把 \`--max-entries\` / \`--max-depth\` 调大重跑；确实要跳过这层检查 ⇒ 显式 \`--on-scan-error warn\`（留痕）。`,
    ].filter(Boolean);
    return { ...base, ok: false, code: truncated ? 'scan-truncated' : 'scan-error', exitCode: DESTRUCTIVE_EXIT.REFUSE, reason: lines.join('\n') };
  }
  // R-067：扫描没扫完却降级为"只警告" ⇒ 留痕（这条比 `--allow-reparse` 更隐蔽：它什么都不说就放过去了）。
  if ((errors.length || truncated) && onScanError === 'warn' && o.ledgerBypass !== false) {
    recordBypass({
      gate: 'scan-degrade',
      reason: o.reason ?? null,
      actor: actorOf(),
      target: targets.map((t) => t.path).slice(0, 6).join(' ; '),
      detail: { errors: errors.length, truncated },
    });
  }
  return { ...base, ok: true, code: null, exitCode: DESTRUCTIVE_EXIT.OK, reason: `✅ reparse 检查通过（扫 ${scans.length} 棵 / ${scans.reduce((a, s) => a + s.scanned, 0)} 条目 / 命中 ${hits.length}）` };
}

// ───────────────────────────────────────────────────── 6) R-065 ② 白名单判定

/** 单点白名单判定（**逻辑路径 + realpath 双比**，任一侧命中即算在册；跨面会标出来）。 */
export function classifyWhitelist(target, whitelist = []) {
  const list = (Array.isArray(whitelist) ? whitelist : [whitelist]).filter(Boolean).map(String);
  const logical = normSep(target);
  const real = normSep(normalizePath(target));
  const matched = [];
  for (const w of list) {
    if (isUnder(logical, w)) matched.push({ root: w, side: 'logical' });
    if (isUnder(real, normalizePath(w))) matched.push({ root: w, side: 'real' });
  }
  return {
    input: String(target), logical, real, whitelist: list,
    inWhitelist: matched.length > 0, matched,
    crossSide: logical.toLowerCase() !== real.toLowerCase(),
  };
}

/** ② 白名单闸：不给白名单 ⇒ 拒；目标落在白名单外 ⇒ 拒（点名是哪一条）。 */
export function gateWhitelist(o = {}) {
  const targets = (Array.isArray(o.targets) ? o.targets : []).map(normalizeTarget).filter((t) => t.path);
  const whitelist = (Array.isArray(o.whitelist) ? o.whitelist : [o.whitelist]).filter(Boolean).map(String);
  if (!whitelist.length) {
    return {
      ok: false, code: 'need-whitelist', exitCode: DESTRUCTIVE_EXIT.REFUSE, whitelist, checked: [], outside: [], targets,
      reason: [
        `❌ 拒绝：本次没有声明**白名单**（R-065② · fail-closed）。`,
        `   为什么：7 起"演练/清理打到生产"里 5 起的根因是「参数没认出 ⇒ 静默回落默认根」；`,
        `   白名单 = 把"这次到底允许动哪棵树"写死，跑出范围就拒，不给静默回落的余地。`,
        `   怎么给：调用方传 \`whitelist: [<允许的根>]\`（CLI：\`--whitelist "<workspace>\\_tmp\\<夹具>"\`）。`,
      ].join('\n'),
    };
  }
  const checked = targets.map((t) => ({ ...classifyWhitelist(t.path, whitelist), label: t.label }));
  const outside = checked.filter((c) => !c.inWhitelist);
  const base = { whitelist, checked, outside, targets };
  if (outside.length) {
    const lines = [
      `❌ 拒绝：**${outside.length}/${checked.length}** 个目标落在白名单之外（R-065② · fail-closed）。`,
      ...outside.slice(0, 8).map((c) => `   · ${c.label ? `[${c.label}] ` : ''}${c.logical}${c.crossSide ? `（realpath ${c.real}）` : ''} —— 不在 ${whitelist.join(' / ')} 之下`),
      `   白名单：${whitelist.join(' · ')}`,
      `   处置：要么改白名单（显式、留痕），要么把目标改到白名单内（演练请用 %TEMP% 或 _tmp 夹具）。`,
    ];
    return { ...base, ok: false, code: 'outside-whitelist', exitCode: DESTRUCTIVE_EXIT.REFUSE, reason: lines.join('\n') };
  }
  return {
    ...base, ok: true, code: null, exitCode: DESTRUCTIVE_EXIT.OK,
    reason: `✅ 白名单检查通过（${checked.length} 项全在 ${whitelist.join(' / ')} 之下${checked.some((c) => c.crossSide) ? ' · 有跨面目标已标出' : ''}）`,
  };
}

// ───────────────────────────────────────────────────── 7) R-065 ④ 作用域点明

/** 作用域归一：接受 `['file']` / `'file,process'` / `{file:true}`；未知面进 `_unknown`（会被拒）。 */
export function normalizeScope(scope) {
  let list = [];
  if (Array.isArray(scope)) list = scope.map((x) => String(x));
  else if (scope && typeof scope === 'object') list = SCOPE_AREAS.filter((a) => scope[a] === true);
  else if (typeof scope === 'string') list = scope.split(/[,;|]/);
  list = list.map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = { _list: list, _unknown: list.filter((s) => !SCOPE_AREAS.includes(s)) };
  for (const a of SCOPE_AREAS) out[a] = list.includes(a);
  return out;
}

/** 作用域人话渲染。 */
export function describeScope(scope) {
  const n = normalizeScope(scope);
  if (!n._list.length) return '(未声明)';
  return n._list.map((s) => SCOPE_ZH[s] ?? `${s}(未知)`).join(' + ');
}

/**
 * ④ 作用域声明闸：**动作会触及的面 ⊄ 声明的面 ⇒ 拒**（`scope-missing`）；一个都没声明 ⇒ 拒（`scope-undeclared`）。
 * @param {{scope?:any, requires?:any, label?:string}} o
 *        `requires` = 本次动作实际会触及的面（删/搬默认 `['file']`；会杀/起进程要加 `'process'`；会发网络要加 `'network'`）
 */
export function gateScopeDeclaration(o = {}) {
  const label = o.label ?? '本次动作';
  const declared = normalizeScope(o.scope);
  const required = normalizeScope(o.requires ?? ['file'])._list;
  const unknown = [...new Set([...declared._unknown, ...required.filter((r) => !SCOPE_AREAS.includes(r))])];
  if (unknown.length) {
    return {
      ok: false, code: 'scope-unknown', exitCode: DESTRUCTIVE_EXIT.REFUSE, declared, required,
      reason: `❌ 拒绝：作用域名写错 —— ${unknown.join(' ')}（只认 ${SCOPE_AREAS.join(' / ')}）。写错的作用域不算声明。`,
    };
  }
  if (!declared._list.length) {
    return {
      ok: false, code: 'scope-undeclared', exitCode: DESTRUCTIVE_EXIT.REFUSE, declared, required,
      reason: [
        `❌ 拒绝：${label}**没有点明作用域**（R-065④）。`,
        `   为什么：事故 docs\\事故-隔离演练误杀生产dsh-20261016.md 的形态就是"文件面隔离了、进程面没有" ——`,
        `   不写清覆盖哪几个面，就没人能说清"到底隔离了没有"。`,
        `   怎么给：\`scope: ['file']\`（只碰文件）/ \`['file','process']\`（还要杀/起进程）/ 加 \`'network'\`。`,
      ].join('\n'),
    };
  }
  const missing = required.filter((r) => !declared[r]);
  if (missing.length) {
    return {
      ok: false, code: 'scope-missing', exitCode: DESTRUCTIVE_EXIT.REFUSE, declared, required,
      reason: [
        `❌ 拒绝：作用域声明不全（R-065④ · 缺一面即视为未隔离）。`,
        `   本次动作会触及：${required.map((r) => SCOPE_ZH[r]).join(' + ')}`,
        `   但只声明了：${declared._list.map((r) => SCOPE_ZH[r]).join(' + ')}`,
        `   ⇒ 缺：${missing.map((r) => SCOPE_ZH[r]).join(' + ')}`,
        `   处置：要么把缺的面补进 \`scope\`（并真的做隔离），要么把动作裁到已声明的面内。`,
      ].join('\n'),
    };
  }
  return { ok: true, code: null, exitCode: DESTRUCTIVE_EXIT.OK, declared, required, reason: `✅ 作用域声明通过：${required.map((r) => SCOPE_ZH[r]).join(' + ')}` };
}

/**
 * ④b 进程面闸（**dry-run 不豁免** —— 这是本卡的核心洞察）。
 * 判据：杀/起/查进程的操作必须**点明对象**（pid 或 port）；指向生产 pid / 生产端口 / 本进程自己 ⇒ 拒。
 * @param {{ops?:Array<{kind?:string,pid?:number,port?:number}>, prodPids?:number[], prodPorts?:number[],
 *          sandboxPids?:number[], sandboxPorts?:number[]}} o
 */
export function gateProcessScope(o = {}) {
  const ops = (Array.isArray(o.ops) ? o.ops : []).filter(Boolean);
  const prodPids = new Set((o.prodPids ?? []).map(Number).filter(Number.isInteger));
  const prodPorts = new Set((o.prodPorts ?? DEFAULT_PROD_PORTS).map(Number).filter(Number.isInteger));
  const sandboxPids = new Set((o.sandboxPids ?? []).map(Number).filter(Number.isInteger));
  const sandboxPorts = new Set((o.sandboxPorts ?? []).map(Number).filter(Number.isInteger));
  const killLike = /^(kill|stop|taskkill|killtree|restart|start|launch)$/i;
  const hits = [];
  for (const op of ops) {
    const pid = Number.isInteger(op.pid) ? op.pid : null;
    const port = Number.isInteger(op.port) ? op.port : null;
    const kind = String(op.kind ?? 'kill');
    if (pid == null && port == null) {
      hits.push({ op, why: `\`${kind}\` 没点明对象（既没 pid 也没 port）⇒ 不许盲杀/盲起` });
      continue;
    }
    if (pid != null && prodPids.has(pid)) { hits.push({ op, why: `pid ${pid} 是**生产进程**` }); continue; }
    if (port != null && prodPorts.has(port)) { hits.push({ op, why: `端口 ${port} 是**生产端口**` }); continue; }
    if (pid != null && pid === process.pid) { hits.push({ op, why: `pid ${pid} 是**当前进程自己**` }); continue; }
    if (pid != null && sandboxPids.has(pid)) continue;
    if (port != null && sandboxPorts.has(port)) continue;
    if (pid != null && !sandboxPids.size && !prodPids.size) hits.push({ op, why: `pid ${pid} 既不在沙盒名单也不在生产名单 ⇒ 判据不明（fail-closed）` });
    else if (port != null && !sandboxPorts.size && !prodPorts.size) hits.push({ op, why: `端口 ${port} 判据不明（fail-closed）` });
    else if (killLike.test(kind) && pid != null && !sandboxPids.has(pid)) hits.push({ op, why: `pid ${pid} 未列入沙盒白名单` });
    else if (killLike.test(kind) && port != null && !sandboxPorts.has(port)) hits.push({ op, why: `端口 ${port} 未列入沙盒白名单` });
  }
  const base = { ops, prodPids: [...prodPids], prodPorts: [...prodPorts], hits };
  if (hits.length) {
    const lines = [
      `❌ 拒绝：**进程面**未隔离（R-065④ · dry-run 不豁免这一层）。`,
      ...hits.slice(0, 6).map((h) => `   · ${h.why}`),
      `   2026-10-16 的事故就是这个形态：隔离树只隔离了文件，脚本仍按"3080 的 owner"找到并杀掉了生产 dsh。`,
      `   处置：整支跳过进程操作；或改用**假 pid / 沙盒端口**（\`sandboxPids\` / \`sandboxPorts\`）。`,
    ];
    return { ...base, ok: false, code: 'process-scope-hit', exitCode: DESTRUCTIVE_EXIT.REFUSE, reason: lines.join('\n') };
  }
  return { ...base, ok: true, code: null, exitCode: DESTRUCTIVE_EXIT.OK, reason: `✅ 进程面检查通过（${ops.length} 个操作均在沙盒范围 / 无操作）` };
}

// ───────────────────────────────────────────────────── 8) R-065 三件套统一入口

function refuseGate(r, extra = {}) {
  return { ok: false, dryRun: false, code: r.code, exitCode: r.exitCode, reason: r.reason, ...extra };
}

/**
 * **删除 / 搬移三件套统一入口**（R-065）。
 * 门序（顺序本身是设计的一部分）：
 *   ① 作用域声明（`scope ⊇ requires`，含 dry-run）
 *   ② **进程面闸（dry-run 不豁免）**
 *   ③ dry-run 门 ⇒ 只读检查（白名单 / reparse / 生产）并把"真跑会被拒的理由"列进 `blockers`，零动作返回
 *   ④ 白名单 ⑤ reparse ⑥ 生产闸（`--allow-production`）
 * @returns {{ok:boolean, dryRun:boolean, code:string|null, exitCode:number, reason:string,
 *            blockers:string[], checks:object, targets:Array}}
 */
export function gateDestructive(o = {}) {
  const op = o.op ?? '删';
  const dryRun = o.dryRun === true;
  const targets = (Array.isArray(o.targets) ? o.targets : []).map(normalizeTarget).filter((t) => t.path);
  const env = o.env ?? process.env;
  const checks = {};
  const hasProc = Array.isArray(o.processOps) && o.processOps.length > 0;

  if (!destructiveGuardEnabled(env)) {
    // R-067：总开关被关掉是最"静默"的一种绕过（它连一行判定都不做）⇒ 留痕。
    // ⚠️ dry-run 不记：演练跑一遍就写一条，会把台账淹掉（判据 B「不绕过 ⇒ 零新增」的同一精神）。
    if (!dryRun && o.ledgerBypass !== false) {
      recordBypass({
        gate: 'env-destructive-guard',
        reason: o.reason ?? null,
        actor: actorOf(),
        target: targets.map((t) => t.path).slice(0, 6).join(' ; '),
        detail: { env: `${DESTRUCTIVE_ESCAPE_ENV}=off`, op },
      });
    }
    return {
      ok: true, dryRun, code: 'escaped', exitCode: DESTRUCTIVE_EXIT.OK, escaped: true, blockers: [], checks,
      targets,
      reason: `⚠ 逃生舱 ${DESTRUCTIVE_ESCAPE_ENV}=off ⇒ 三件套整体放行（零判定；已在绕过台账留痕）`,
    };
  }

  // ① 作用域声明
  const sc = gateScopeDeclaration({
    scope: o.scope,
    requires: o.requires ?? (hasProc ? ['file', 'process'] : ['file']),
    label: `${op}目标`,
  });
  checks.scope = sc;
  if (!sc.ok) return refuseGate(sc, { checks, targets, blockers: [sc.code] });

  // ② 进程面闸（**刻意放在 dry-run 门之前**）
  if (hasProc || sc.declared.process) {
    const ps = gateProcessScope({
      ops: o.processOps, prodPids: o.prodPids, prodPorts: o.prodPorts,
      sandboxPids: o.sandboxPids, sandboxPorts: o.sandboxPorts,
    });
    checks.process = ps;
    if (!ps.ok) return refuseGate(ps, { checks, targets, blockers: [ps.code] });
  }

  // ③ 只读检查（dry-run 也跑 —— 演练就该提前看到"真跑会被拒"）
  //   ⚠️ R-067：dry-run 时**抑制留痕**（`ledgerBypass:false`）—— 演练不是"绕过"，
  //   否则每跑一次演练就往台账写一条，把真实绕过数淹掉（判据 B 的同一精神）。
  const ledgerBypass = o.ledgerBypass !== false && !dryRun;
  const wl = gateWhitelist({ targets, whitelist: o.whitelist });
  const rp = gateReparse({ targets, allowReparse: o.allowReparse, onScanError: o.onScanError, maxEntries: o.maxEntries, maxDepth: o.maxDepth, reason: o.reason, ledgerBypass });
  const pg = gateProductionWrite({
    targets, allowProduction: o.allowProduction, dryRun: false,
    op, reason: o.reason, exitCode: EXIT.USAGE, pathOpts: o.pathOpts, ledgerBypass,
  });
  checks.whitelist = wl;
  checks.reparse = rp;
  checks.production = pg;
  const blockers = [wl, rp, pg].filter((c) => !c.ok).map((c) => c.code ?? 'blocked');

  if (dryRun) {
    return {
      ok: true, dryRun: true, code: 'dry-run', exitCode: DESTRUCTIVE_EXIT.OK, blockers, checks, targets,
      reason: blockers.length
        ? `· dry-run（零动作）：只读检查跑完，**真跑会被拒 ${blockers.length} 条** ⇒ ${blockers.join(' / ')}`
        : `✅ dry-run（零动作）：只读检查跑完，真跑会通过（作用域 ${describeScope(sc.declared)}）`,
    };
  }

  // ④ 白名单
  if (!wl.ok) return refuseGate(wl, { checks, targets, blockers });
  // ⑤ reparse
  if (!rp.ok) return refuseGate(rp, { checks, targets, blockers });
  // ⑥ 生产闸
  if (!pg.ok) return refuseGate({ ...pg, reason: pg.reason, code: pg.code ?? 'need-allow-production' }, { checks, targets, blockers });

  return {
    ok: true, dryRun: false, code: null, exitCode: DESTRUCTIVE_EXIT.OK, blockers, checks, targets,
    reason: `✅ 三件套全过：作用域 ${describeScope(sc.declared)} · 白名单 ${wl.whitelist.join(' / ')} · reparse 命中 ${rp.hits.length} · 生产判定 ${pg.hits.length} 项`,
  };
}

/**
 * **带 dry-run 真门的执行包装**：dry-run ⇒ 只调 `planOnly`，`apply` 回调**永不进**（R-065③）。
 * 调用方的 `apply` 内部也应把 `if (dryRun) return` 放第一行（双保险）。
 */
export function runDestructive(o = {}) {
  const plan = typeof o.planOnly === 'function' ? o.planOnly() : (o.planOnly ?? null);
  const gate = gateDestructive(o);
  if (!gate.ok) {
    return { ok: false, dryRun: gate.dryRun, code: gate.code, exitCode: gate.exitCode, reason: gate.reason, plan, applied: false, gate };
  }
  if (o.dryRun === true) {
    return { ok: true, dryRun: true, code: 'dry-run', exitCode: DESTRUCTIVE_EXIT.OK, reason: gate.reason, plan, applied: false, blockers: gate.blockers, gate };
  }
  const applied = typeof o.apply === 'function' ? o.apply() : o.apply;
  return { ok: true, dryRun: false, code: null, exitCode: DESTRUCTIVE_EXIT.OK, reason: gate.reason, plan, applied: true, result: applied, blockers: gate.blockers, gate };
}

/** 把 gateDestructive 的结果渲染成人话（报告/日志直接用）。 */
export function renderDestructive(r) {
  const lines = [r.reason ?? '(无说明)'];
  if (r.blockers?.length && r.dryRun) lines.push(`   真跑会被拒的理由：${r.blockers.join(' / ')}`);
  const c = r.checks ?? {};
  if (c.reparse?.scans?.length) {
    for (const s of c.reparse.scans) {
      lines.push(`   · 扫描 ${s.root}：${s.scanned} 条目 / ${s.dirs} 目录${s.truncated ? ' / **被截断**' : ''}${s.missing ? ' / 不存在' : ''}`);
    }
  }
  return lines.join('\n');
}

// ───────────────────────────────────────────────────── 9) R-065 CLI（现跑复现入口）

export const DESTRUCTIVE_CLI_HELP = `production-guard.mjs —— 生产闸（R-060）+ 删除/搬移三件套（R-065）

  node production-guard.mjs destructive --target <路径> [--targets "p1;p2"] --whitelist "<根>" [--whitelists "r1;r2"]
        [--op 删|搬移] [--scope file[,process,network]] [--requires file[,process]] [--reason "…"]
        [--dry-run] [--allow-production] [--allow-reparse] [--on-scan-error refuse|warn]
        [--max-entries N] [--max-depth N] [--prod-pid N] [--prod-port N] [--kill-pid N] [--start-port N] [--json]
  node production-guard.mjs reparse --target <路径> [--max-entries N] [--max-depth N] [--json]
  node production-guard.mjs --selftest

退出码：0 通过 · 2 用法错 / 缺 --allow-production · 3 被拒（reparse / 白名单 / 作用域 / 进程面）
逃生舱：--allow-reparse · --on-scan-error warn · DSH_DESTRUCTIVE_GUARD=off`;

const PG_KNOWN = [
  { flag: '--target', takesValue: true }, { flag: '--targets', takesValue: true },
  { flag: '--whitelist', takesValue: true }, { flag: '--whitelists', takesValue: true },
  { flag: '--op', takesValue: true }, { flag: '--scope', takesValue: true },
  { flag: '--requires', takesValue: true }, { flag: '--reason', takesValue: true },
  { flag: '--allow-reparse', takesValue: false }, { flag: '--on-scan-error', takesValue: true },
  { flag: '--max-entries', takesValue: true }, { flag: '--max-depth', takesValue: true },
  { flag: '--prod-pid', takesValue: true }, { flag: '--prod-port', takesValue: true },
  { flag: '--kill-pid', takesValue: true }, { flag: '--start-port', takesValue: true },
  { flag: '--json', takesValue: false }, { flag: '--help', takesValue: false }, { flag: '-h', takesValue: false },
];

function splitList(v) {
  if (v == null) return [];
  return String(v).split(/[;|]/).map((s) => s.trim()).filter(Boolean);
}

function pgCli(argv) {
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(DESTRUCTIVE_CLI_HELP + '\n');
    return cmd ? DESTRUCTIVE_EXIT.OK : DESTRUCTIVE_EXIT.USAGE;
  }
  const pa = parseProductionArgs(argv.slice(1), PG_KNOWN, { withDryRun: true });
  if (!pa.ok) {
    process.stderr.write(describeUnknown(pa.unknown, PG_KNOWN) + '\n' + DESTRUCTIVE_CLI_HELP + '\n');
    return DESTRUCTIVE_EXIT.USAGE;
  }
  const json = pa.flags['--json'] === true;
  const targets = [...splitList(pa.values['--target']), ...splitList(pa.values['--targets'])];
  const whitelist = [...splitList(pa.values['--whitelist']), ...splitList(pa.values['--whitelists'])];
  const emit = (human, obj) => { process.stdout.write((json ? JSON.stringify(obj, null, 2) : human) + '\n'); };

  if (cmd === 'reparse') {
    if (!targets.length) { process.stderr.write('reparse 需要 --target <路径>\n' + DESTRUCTIVE_CLI_HELP + '\n'); return DESTRUCTIVE_EXIT.USAGE; }
    const scans = targets.map((t) => scanReparsePoints(t, { maxEntries: Number(pa.values['--max-entries'] ?? 0) || undefined, maxDepth: Number(pa.values['--max-depth'] ?? 0) || undefined }));
    const hits = scans.flatMap((s) => s.hits);
    emit(hits.length
      ? `⛔ 命中 ${hits.length} 个 reparse point：\n` + hits.map((h) => `  · ${h.path} → ${h.pointsTo ?? '(读不到)'}`).join('\n')
      : `✅ 未命中 reparse point（扫 ${scans.reduce((a, s) => a + s.scanned, 0)} 条目）`,
      { ok: hits.length === 0, hits, scans });
    return hits.length ? DESTRUCTIVE_EXIT.REFUSE : DESTRUCTIVE_EXIT.OK;
  }

  if (cmd !== 'destructive') {
    process.stderr.write(`未知子命令：${cmd}\n` + DESTRUCTIVE_CLI_HELP + '\n');
    return DESTRUCTIVE_EXIT.USAGE;
  }
  const ops = [];
  for (const v of splitList(pa.values['--kill-pid'])) ops.push({ kind: 'kill', pid: Number(v) });
  for (const v of splitList(pa.values['--start-port'])) ops.push({ kind: 'start', port: Number(v) });
  const r = gateDestructive({
    targets, whitelist,
    op: pa.values['--op'] ?? '删',
    scope: pa.values['--scope'] ?? null,
    requires: pa.values['--requires'] ?? undefined,
    reason: pa.values['--reason'] ?? undefined,
    dryRun: pa.dryRun,
    allowProduction: pa.allowProduction,
    allowReparse: pa.flags['--allow-reparse'] === true,
    onScanError: pa.values['--on-scan-error'] ?? undefined,
    maxEntries: Number(pa.values['--max-entries'] ?? 0) || undefined,
    maxDepth: Number(pa.values['--max-depth'] ?? 0) || undefined,
    processOps: ops,
    prodPids: splitList(pa.values['--prod-pid']).map(Number),
    prodPorts: splitList(pa.values['--prod-port']).map(Number),
  });
  emit(renderDestructive(r), {
    ok: r.ok, dryRun: r.dryRun, code: r.code, exitCode: r.exitCode,
    scope: r.checks?.scope?.declared ?? null, whitelist: r.checks?.whitelist?.whitelist ?? [],
    reparseHits: r.checks?.reparse?.hits?.length ?? 0,
    productionHits: r.checks?.production?.hits?.length ?? 0,
    blockers: r.blockers ?? [], reason: r.reason,
  });
  return r.exitCode;
}

if (process.argv[1] && /production-guard\.mjs$/i.test(process.argv[1]) && ['destructive', 'reparse'].includes(process.argv[2])) {
  try { process.exitCode = pgCli(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`[FATAL] production-guard: ${e?.stack ?? e}\n`); process.exitCode = 1; }
}
