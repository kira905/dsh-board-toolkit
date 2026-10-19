#!/usr/bin/env node
// 看板卡动作（走 Host HTTP API，绝不手改账本）
// 用法：node board-act.mjs --card <完整id 或前缀> --kind run|confirm|reject|move [--status todo] [--note "..."]
// 退出码：0 成功 · 2 用法错 · 3 卡未找到/前缀歧义 · 1 动作失败
import { randomUUID } from 'node:crypto';

const BASE = process.env.DSH_WEB_URL || 'http://localhost:3080';
const H = { 'content-type': 'application/json', origin: BASE, 'sec-fetch-site': 'same-origin' };

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name, def = null) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : def;
  };
  const cardArg = arg('--card');
  const kind = arg('--kind', 'run');
  const status = arg('--status');
  const note = arg('--note');
  if (!cardArg) {
    console.error('用法：--card <id|前缀> [--kind run|confirm|reject|move] [--status todo] [--note ...]');
    return 2;
  }
  if (!/^[ -~]+$/.test(cardArg)) { console.error('card id 必须 ASCII'); return 2; }
  if (kind === 'move' && !status) { console.error('move 需要 --status'); return 2; }

  const st = await (await fetch(`${BASE}/api/task-board/state`, { headers: H })).json();
  const matches = (st.tasks ?? []).filter((t) => t.id === cardArg || t.id.startsWith(cardArg));
  if (matches.length === 0) { console.error(`看板上没有匹配 ${cardArg} 的卡`); return 3; }
  if (matches.length > 1) {
    console.error(`前缀 ${cardArg} 命中 ${matches.length} 张卡，请给完整 id：\n` + matches.map((t) => `${t.id}  ${t.title}`).join('\n'));
    return 3;
  }
  const task = matches[0];
  console.log(`目标卡：${task.title}\n  id=${task.id}\n  status=${task.status}  line=${task.line ?? '-'} seq=${task.seq ?? '-'}`);

  const action = { kind, taskId: task.id };
  if (kind === 'move') action.status = status;
  if (kind === 'reject' && note) action.note = note;

  const res = await fetch(`${BASE}/api/task-board/action`, {
    method: 'POST', headers: H, body: JSON.stringify({ requestId: randomUUID(), action }),
  });
  const body = await res.json();
  if (!res.ok || body.ok === false) {
    console.error(`动作 ${kind} 失败 HTTP ${res.status}：` + JSON.stringify(body));
    return 1;
  }
  const after = (body.tasks ?? body.snapshot?.tasks ?? []).find((t) => t.id === task.id);
  console.log(`✅ ${kind} 成功  revision=${body.revision ?? body.snapshot?.revision ?? '?'}  当前 status=${after?.status ?? '?'}`);
  return 0;
}

// 家规：发过 fetch 的脚本禁用 process.exit()（Windows 上会概率性 0xC0000409），一律 exitCode 自然退出。
process.exitCode = await main();
