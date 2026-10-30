#!/usr/bin/env node
// board-ops / card-prompt.mjs —— 打印单张卡的 title / status / description / prompt（只读）
//
// 为什么存在（2026-10 起）：
//   `card-state.mjs` 只给 status / executions / description，**不给 prompt**；
//   而验收/落卡前提核对（skill task-board §0「run 卡前先核本机口径」、§7.4「逐条对照卡 prompt 里写的验收项实测」）
//   都必须读卡面 prompt。此前只能拿全量 `GET /state`（~9 MB）自己翻，本工具把它收敛成一条命令。
//
// 用法：
//   node <workspace>\tools\board-ops\card-prompt.mjs <taskId>
//   node <workspace>\tools\board-ops\card-prompt.mjs <taskId> --prompt-only
//   node <workspace>\tools\board-ops\card-prompt.mjs <taskId> --desc-only
//   node <workspace>\tools\board-ops\card-prompt.mjs <taskId> --base-url http://localhost:3080
// 退出码：0 找到 / 1 未找到或读不到 / 2 用法错
//
// ⚠️ 只读：不提交任何 action，不改状态、不改 description（要写回用 card-note.mjs）。
// ⚠️ 本机一律用 localhost:3080（主机 A 实测 127.0.0.1 会连不上；见 skill task-board §0）。
// R-066（2026-10-16）：本件打印**卡面 description / prompt**（自由文本，卡里贴过明文口令的事有先例）
// ⇒ 输出前按「键名 or 值形态」双判据脱敏（共享件；只影响显示，不改任何逻辑）。
import { createRedactor } from '../lib/redact.mjs';

const redactOut = createRedactor({ secretsOnly: true }).redactAndCount;

const HELP = `打印单张卡的 title / status / description / prompt（只读）

用法：node card-prompt.mjs <taskId> [选项]
  --prompt-only    只打印 prompt
  --desc-only      只打印 description
  --base-url <URL>  DSH 地址（默认 http://localhost:3080）
  --help            本帮助`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP);
  process.exitCode = 0;
} else {
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const id = argv.find((a) => /^[0-9a-f-]{36}$/i.test(a));
  const BASE = val('--base-url', process.env.DSH_WEB_URL?.replace('127.0.0.1', 'localhost') ?? 'http://localhost:3080');
  const H = { origin: BASE, 'sec-fetch-site': 'same-origin' };
  const onlyPrompt = argv.includes('--prompt-only');
  const onlyDesc = argv.includes('--desc-only');

  if (!id) {
    console.error('用法: node card-prompt.mjs <taskId> [--prompt-only] [--desc-only] [--base-url URL]');
    process.exitCode = 2;
  } else {
    const res = await fetch(`${BASE}/api/task-board/state`, { headers: H });
    if (!res.ok) {
      console.error('读不到看板：HTTP', res.status);
      process.exitCode = 1;
    } else {
      const st = await res.json();
      const t = (st.tasks ?? []).find((x) => x.id === id);
      if (!t) {
        console.log('未找到卡', id);
        process.exitCode = 1;
      } else {
        const say = (s) => console.log(redactOut(String(s)));
        if (!onlyPrompt && !onlyDesc) {
          say(`title  = ${t.title}`);
          say(`status = ${t.status} | line = ${t.line ?? '—'} | seq = ${t.seq ?? '—'} | permission = ${t.permission ?? '—'}`);
        }
        if (!onlyPrompt) {
          say('--- description ---');
          say(t.description ?? '(空)');
        }
        if (!onlyDesc) {
          say('--- prompt ---');
          say(t.prompt ?? '(无 prompt)');
        }
      }
    }
  }
}
