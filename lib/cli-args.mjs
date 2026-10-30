// cli-args.mjs —— 用户 CLI 公共参数件（零依赖）
//
// 三条纪律（本仓所有 bin 共用）：
//   1. `-h` / `--help` ⇒ 打印用法、退出码 0，**绝不执行动作**；
//   2. 出现不认识的参数 ⇒ 打印错误、退出码 2，**绝不继续执行**；
//   3. 用法文本必须写清「这个命令会写什么」，用户得知道有没有副作用。
//
// 接入方式（bin 顶部）：
//   import { cliGuard } from '../lib/cli-args.mjs';
//   const argv = cliGuard(spec);            // 默认取 process.argv.slice(2)
//
// spec 字段（都可选，但 summary / usage / writes / exits 建议必填）：
//   cmd, summary, usage,
//   commands: [{ name, desc }],
//   flags:    [{ name, alias: ['-x'], arg: 'N', desc }],
//   positional: [{ name, desc }],
//   env:      [{ name, desc }],
//   writes, dryRun, exits, examples: [], notes: []

import fs from 'node:fs';

export const EXIT_USAGE = 2;

// 同步写 fd：`process.stdout` 在管道下是异步流，若随后同步 process.exit() 会把内容截断；
// 而 `--help` 必须「打印完立刻退出、后面一行都不许跑」⇒ 一律用 writeSync 写原始字节。
function writeSyncFd(fd, text) {
  try { fs.writeSync(fd, text); } catch { (fd === 1 ? process.stdout : process.stderr).write(text); }
}

/** 取 token 的「参数名」部分：`--hours=6` → `--hours`；非 `-` 开头返回 null */
function tokenName(a) {
  if (typeof a !== 'string' || !a.startsWith('-')) return null;
  const eq = a.indexOf('=');
  return eq > 0 ? a.slice(0, eq) : a;
}

const dashless = (n) => n.replace(/^-+/, '');

function knownSet(spec) {
  const s = new Set(['-h', '--help']);
  for (const f of spec.flags ?? []) {
    if (f.name) s.add(f.name);
    for (const a of f.alias ?? []) s.add(a);
  }
  return s;
}

function valueSet(spec) {
  const s = new Set();
  for (const f of spec.flags ?? []) {
    if (!f.arg) continue;
    if (f.name) s.add(f.name);
    for (const a of f.alias ?? []) s.add(a);
  }
  return s;
}

/** 识别帮助：`hasFlag(argv, '-h', '--help')` */
export function hasFlag(argv, ...names) {
  for (const a of argv ?? []) {
    const n = tokenName(a);
    if (n !== null && names.includes(n)) return true;
  }
  return false;
}

/** 渲染用法文本（纯函数，便于测试） */
export function renderHelp(spec = {}) {
  const L = [];
  L.push('用法');
  L.push(`  ${spec.usage ?? spec.cmd ?? '<命令>'}`);

  if (spec.summary) L.push('', spec.summary);

  if (spec.commands?.length) {
    L.push('', '子命令');
    for (const c of spec.commands) L.push(`  ${c.name}    ${c.desc}`);
  }

  L.push('', '选项');
  for (const f of spec.flags ?? []) {
    const head = [f.name, ...(f.alias ?? [])].join(', ') + (f.arg ? ` <${f.arg}>` : '');
    L.push(`  ${head}`);
    if (f.desc) L.push(`      ${f.desc}`);
  }
  L.push('  -h, --help');
  L.push('      打印本用法并退出（退出码 0），不执行任何动作');

  if (spec.positional?.length) {
    L.push('', '位置参数');
    for (const p of spec.positional) L.push(`  ${p.name}`);
    for (const p of spec.positional) if (p.desc) L.push(`      ${p.name}    ${p.desc}`);
  }

  if (spec.writes) L.push('', '写什么', `  ${spec.writes}`);
  if (spec.dryRun) L.push('', '干跑', `  ${spec.dryRun}`);
  if (spec.env?.length) {
    L.push('', '环境变量');
    for (const e of spec.env) L.push(`  ${e.name}    ${e.desc ?? ''}`);
  }
  if (spec.exits) L.push('', '退出码', `  ${spec.exits}`);
  if (spec.examples?.length) {
    L.push('', '示例');
    for (const e of spec.examples) L.push(`  ${e}`);
  }
  if (spec.notes?.length) {
    L.push('', '注意');
    for (const n of spec.notes) L.push(`  ${n}`);
  }
  return L.join('\n') + '\n';
}

/** 打印用法并按需以指定码退出（默认 rc=0）：同步写 + 同步退出，保证后续代码一行都不跑 */
export function printHelp(spec = {}, { exit = true, exitCode = 0 } = {}) {
  const text = renderHelp(spec);
  if (!exit) { process.stdout.write(text); return text; }
  writeSyncFd(1, text);
  process.exit(exitCode);
  return text;
}

/** 未知参数：打印错误并 rc=2 退出（同步写 + 同步退出，绝不继续执行） */
export function usageError(spec = {}, arg) {
  const cmd = spec.cmd ? `${spec.cmd} --help` : '--help';
  writeSyncFd(2, `错误：不认识的参数 ${arg}\n（运行 \`${cmd}\` 看用法）\n`);
  process.exit(EXIT_USAGE);
}

/** 列出 argv 里不认识的参数（不含数值形如 -1 的取值、不含 `--` 之后的内容） */
export function findUnknown(argv = [], spec = {}) {
  const known = knownSet(spec);
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (/^-\d/.test(a)) continue; // 负数取值，不是参数名
    const n = tokenName(a);
    if (n === null) continue;
    if (!known.has(n)) out.push(a);
  }
  return out;
}

/**
 * 解析参数。遇到不认识的参数 ⇒ 打印错误 + rc=2 退出（绝不继续执行）。
 * 返回 `{ flags, positional }`；`--x=1` 与 `--x 1` 都归一成 `flags.x`。
 */
export function parseArgs(argv = [], spec = {}) {
  const known = knownSet(spec);
  const valued = valueSet(spec);
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (/^-\d/.test(a)) { positional.push(a); continue; }
    const n = tokenName(a);
    if (n === null) { positional.push(a); continue; }
    if (!known.has(n)) usageError(spec, a);
    const key = dashless(n);
    const eq = a.indexOf('=');
    if (eq > 0) { flags[key] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (valued.has(n) && next !== undefined && tokenName(next) === null) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positional };
}

/**
 * 一道闸：先认 `-h/--help`，再拦未知参数，通过则把 argv 原样交回。
 * 用法（改动最小的接法）：`const argv = cliGuard(SPEC, process.argv.slice(2));`
 */
export function cliGuard(spec = {}, argv = process.argv.slice(2)) {
  if (hasFlag(argv, '-h', '--help')) printHelp(spec);
  const unknown = findUnknown(argv, spec);
  if (unknown.length) usageError(spec, unknown[0]);
  return argv;
}
