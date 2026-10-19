#!/usr/bin/env node
// 只读：dump 指定卡（id 或前缀）的 title/status/line/seq/description/prompt
// 用法：node board-card-dump.mjs <短id> [<短id> ...]
const BASE = process.env.DSH_WEB_URL || 'http://localhost:3080';
const H = { origin: BASE, 'sec-fetch-site': 'same-origin' };

async function main() {
  const ids = process.argv.slice(2);
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
