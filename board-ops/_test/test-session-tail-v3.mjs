#!/usr/bin/env node
// ============================================================================
// test-session-tail-v3.mjs —— 卡「修·V3判据③」单测：session-tail.mjs 认 v3 世代日志名
//
// 被测口径：主包 0.1.5 起会话日志 `session.jsonl.zstd` → `session.v3.jsonl.zstd`；
//   session-tail.mjs 原来两处**精确名拼路径**（L44 传目录 / L50 按 id 找目录），
//   v3 世代恒判"找不到会话"（exit 1）。本测要求：只放 `session.v3.jsonl.zstd` 时也要认到。
//
// 夹具四态（隔离在 os.tmpdir()，绝不碰生产 ~\.dsh）：
//   A 只有 v3 名 ／ B 只有旧名（回归） ／ C 两代并存（取最新那份） ／ D 什么都没有
//
// 跑法：node <workspace>\tools\board-ops\_test\test-session-tail-v3.mjs   （退出码 0 = 全绿）
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'session-tail.mjs');
const V3 = 'session.v3.jsonl.zstd';
const LEGACY = 'session.jsonl.zstd';

let pass = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? `  [${detail}]` : ''}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tail-v3-'));
const HOME = path.join(TMP, 'home');
const WS = path.join(HOME, 'sessions', '--D-DSH--');

/** 写一个多帧 zstd 会话文件（每帧一行 JSON）。 */
function writeSession(dir, fileName, events, frames = events.length) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e));
  const per = Math.max(1, Math.ceil(lines.length / frames));
  const parts = [];
  for (let i = 0; i < lines.length; i += per) {
    parts.push(zlib.zstdCompressSync(Buffer.from(lines.slice(i, i + per).join('\n') + '\n', 'utf8')));
  }
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}

const ID_A = '11111111-1111-1111-1111-111111111111';
const ID_B = '22222222-2222-2222-2222-222222222222';
const ID_C = '33333333-3333-3333-3333-333333333333';
const ID_D = '44444444-4444-4444-4444-444444444444';
const ev = (type, seq, extra = {}) => ({ type, seq, time: 1758000000000 + seq * 1000, data: extra });

writeSession(path.join(WS, `session-${ID_A}`), V3,
  [ev('session', 0), ev('turn/start', 1), ev('turn/end', 2, { reason: { kind: 'aborted' } })], 2);
writeSession(path.join(WS, `session-${ID_B}`), LEGACY, [ev('session', 0), ev('turn/end', 1)], 1);
const dirC = path.join(WS, `session-${ID_C}`);
writeSession(dirC, LEGACY, [ev('session', 0), ev('legacy-only', 1)], 1);
writeSession(dirC, V3, [ev('session', 0), ev('v3-newest', 1)], 1);
// 让 C 的 v3 那份 mtime 更新（验证"同族取最新那份"）
fs.utimesSync(path.join(dirC, V3), new Date(), new Date());
fs.mkdirSync(path.join(WS, `session-${ID_D}`), { recursive: true });
fs.writeFileSync(path.join(WS, `session-${ID_D}`, 'notes.txt'), 'not a session\n');

function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--home', HOME], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  if (r.error) return { code: -1, out: '', err: String(r.error.message ?? r.error) };
  return { code: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
}

console.log(`夹具根: ${TMP}\nCLI: ${CLI}\n`);

try {
  // ---------------------------------------------------------------- ① v3-only（本卡主判据）
  console.log('① 只有 session.v3.jsonl.zstd（按会话 id 定位）');
  {
    const r = runCli([`session-${ID_A}`, '--lines', '5']);
    check('退出码 0（改前 = 1「找不到会话」）', r.code === 0, `code=${r.code} err=${r.err.trim().slice(0, 120)}`);
    check('读到的就是 v3 文件本身', r.out.includes(V3), r.out.split('\n')[0] ?? '');
    check('多帧 zstd 逐帧解（帧数 = 2）', r.out.includes('帧数 = 2'), (r.out.match(/帧数 = \d+/) ?? [''])[0]);
    check('尾部事件可读（type=turn/end）', r.out.includes('turn/end'), '');
    check('reason 可见（aborted）', r.out.includes('aborted'), '');
  }

  // ---------------------------------------------------------------- ② 传目录形式
  console.log('\n② 直接传会话目录（L44 分支）');
  {
    const dir = path.join(WS, `session-${ID_A}`);
    const r = runCli([dir, '--lines', '3']);
    check('传目录也要认到 v3（退出码 0）', r.code === 0, `code=${r.code}`);
    check('读到的就是 v3 文件本身', r.out.includes(V3), '');
  }

  // ---------------------------------------------------------------- ③ 旧名回归
  console.log('\n③ 旧名会话仍可读（回归）');
  {
    const r = runCli([`session-${ID_B}`, '--lines', '3']);
    check('退出码 0', r.code === 0, `code=${r.code}`);
    check('读的是旧名文件', r.out.includes(LEGACY) && !r.out.includes(V3), '');
  }

  // ---------------------------------------------------------------- ④ 两代并存取最新
  console.log('\n④ 两代并存 → 取"当前那份"（mtime 最新）');
  {
    const r = runCli([`session-${ID_C}`, '--lines', '3']);
    check('退出码 0', r.code === 0, `code=${r.code}`);
    check('取到的是 v3（mtime 更新那份）', r.out.includes(V3), r.out.split('\n')[0] ?? '');
  }

  // ---------------------------------------------------------------- ⑤ 负样例
  console.log('\n⑤ 负样例（不许把"真没有"变成假成功）');
  {
    const r = runCli([`session-${ID_D}`, '--lines', '3']);
    check('目录里没有会话文件 → 退出码 1', r.code === 1, `code=${r.code}`);
    const r2 = runCli(['99999999-9999-9999-9999-999999999999', '--lines', '3']);
    check('会话不存在 → 退出码 1', r2.code === 1, `code=${r2.code}`);
  }
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n════ test-session-tail-v3：通过 ${pass} / 失败 ${fails.length} ════`);
if (fails.length) console.log('失败项：\n  - ' + fails.join('\n  - '));
process.exitCode = fails.length ? 1 : 0;
