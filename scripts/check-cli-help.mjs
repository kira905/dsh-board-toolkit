// check-cli-help.mjs —— 用户 CLI 的 --help / 未知参数回归夹具（零依赖，纯本地）
//
// 判据（对本仓每个已接入 cli-args 的 bin 逐个跑）：
//   ① `node <bin> --help`                        ⇒ 退出码 0，且输出含「用法」
//   ② `node <bin> --definitely-not-a-real-flag`  ⇒ 退出码 2，且 stderr 含「不认识的参数」
//      （命中这条分支即 process.exit(2)，动作代码根本没被执行 ⇒ 不会真跑）
//
// 未接入 cli-args 的 bin 记 SKIP（本次范围外），不混进 PASS/FAIL 分母。
//
// 用法：node scripts/check-cli-help.mjs [命令名 ...]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const entries = typeof pj.bin === 'string' ? [['(default)', pj.bin]] : Object.entries(pj.bin ?? {});
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const TIMEOUT = 30_000;
// 冻结宿主地址到不可达端口：万一某个 bin 的参数闸漏了，也不会真打到本机在生产跑的实例
const ENV = { ...process.env, DSH_WEB_URL: 'http://127.0.0.1:1', DSH_HOST_API_URL: 'http://127.0.0.1:1' };
const run = (file, arg) => spawnSync(process.execPath, [file, arg], { encoding: 'utf8', timeout: TIMEOUT, env: ENV });

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

for (const [cmd, rel] of entries) {
  if (only.length && !only.includes(cmd)) continue;
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { fail += 1; failures.push(`${cmd}: 入口不存在 ${rel}`); console.log(`FAIL ${cmd}  (入口不存在)`); continue; }
  // 接入判据：源码里出现 cliGuard 调用或对共享参数件的引用（只看其一都会漏掉「用了但没 import」这种）
  if (!/cliGuard|cli-args\.mjs/i.test(fs.readFileSync(file, 'utf8'))) { skip += 1; console.log(`SKIP ${cmd}  (未接入 cli-args)`); continue; }

  const h = run(file, '--help');
  const helpRc = h.status;
  const helpHasUsage = /用法/.test(`${h.stdout ?? ''}${h.stderr ?? ''}`);
  const u = run(file, '--definitely-not-a-real-flag');
  const unknownRc = u.status;
  const unknownSays = /不认识的参数|未知参数|unknown arg|Unrecognized/i.test(`${u.stderr ?? ''}${u.stdout ?? ''}`);

  const ok = helpRc === 0 && helpHasUsage && unknownRc === 2 && unknownSays;
  if (ok) { pass += 1; console.log(`PASS ${cmd.padEnd(28)} help=0/用法 ✓  unknown=2/拒 ✓`); }
  else {
    fail += 1;
    const msg = `${cmd}: help rc=${helpRc} 含用法=${helpHasUsage} · 未知参数 rc=${unknownRc} 提示=${unknownSays}`;
    failures.push(msg);
    console.log(`FAIL ${msg}`);
  }
}

console.log(`\nPASS ${pass} · FAIL ${fail} · SKIP ${skip}`);
if (failures.length) { for (const f of failures) console.log(`  ✖ ${f}`); process.exitCode = 1; }
