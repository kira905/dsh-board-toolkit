#!/usr/bin/env node
// 只读：dump 指定卡（id 或前缀）的 title/status/line/seq/description/prompt
// 用法：node board-card-dump.mjs <短id> [<短id> ...]
import { cliGuard } from '../lib/cli-args.mjs';

const SPEC = {
  cmd: 'board-card-dump',
  summary: '把指定卡的标题 / 状态 / 主线 / 序号 / description / prompt 原样打出来（只读）。',
  usage: 'board-card-dump <短id> [<短id> ...]',
  positional: [{ name: '<短id>', desc: '卡 id 或唯一前缀，可给多个' }],
  env: [{ name: 'DSH_WEB_URL', desc: '宿主地址，默认 http://localhost:3080' }],
  writes: '什么都不写：只读看板 state。',
  exits: '0 成功（个别 id 没找到只打一行「未找到」） · 2 没给 id 或参数错误',
  examples: ['board-card-dump 1a2b3c4d'],
};

const BASE = process.env.DSH_WEB_URL || 'http://localhost:3080';
const H = { origin: BASE, 'sec-fetch-site': 'same-origin' };

async function main() {
  const ids = cliGuard(SPEC);
  if (!ids.length) { console.error('用法：node board-card-dump.mjs <短id> [<短id> ...]'); return 2; }
  const st = await (await fetch(`${BASE}/api/task-board/state`, { headers: H })).json();
  const tasks = st.tasks ?? [];
  for (const short of ids) {
    const t = tasks.find((x) => x.id.startsWith(short) || x.id === short);
    if (!t) { console.log(`\n### ${short} 未找到`); continue; }
    console.log(`\n================ ${t.title} ================`);
    console.log(`id=${t.id}\nstatus=${t.status} line=${t.line ?? '-'} seq=${t.seq ?? '-'} kind=${t.kind} schedulable=${t.schedule?.enabled ?? false}`);
    console.log(`--- description (${(t.description ?? '').length} chars) ---\n${t.description ?? ''}`);
    console.log(`--- prompt (${(t.prompt ?? '').length} chars) ---\n${t.prompt ?? ''}`);
  }
  return 0;
}

process.exitCode = await main();
