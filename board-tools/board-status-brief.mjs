// 只读：拉看板 state，输出「现役主线」汇总 + 全部非 done 在途卡摘要
// 用法：node board-status-brief.mjs
const BASE = process.env.DSH_WEB_URL || 'http://localhost:3080';
const H = { origin: BASE, 'sec-fetch-site': 'same-origin' };

async function main() {
  const res = await fetch(`${BASE}/api/task-board/state`, { headers: H });
  if (!res.ok) { console.error('state HTTP', res.status); return 2; }
  const st = await res.json();
  const tasks = st.tasks ?? [];
  console.log(`revision=${st.revision} tasks=${tasks.length} 归档=${tasks.filter((t) => t.archivedAt).length}`);

  const live = tasks.filter((t) => !t.archivedAt);
  const byLine = new Map();
  for (const t of live) {
    const k = t.line ?? '(未归线)';
    if (!byLine.has(k)) byLine.set(k, []);
    byLine.get(k).push(t);
  }
  console.log('\n== 现役主线 ==');
  for (const [k, arr] of [...byLine.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const cnt = {};
    for (const t of arr) cnt[t.status] = (cnt[t.status] ?? 0) + 1;
    console.log(`${k}  共${arr.length}  ${Object.entries(cnt).map(([s, n]) => s + ':' + n).join(' ')}`);
  }

  const order = { running: 0, review: 1, todo: 2, backlog: 3, failed: 4, done: 5 };
  const interesting = live.filter((t) => (t.line ?? '').includes('六包') || t.status !== 'done');
  console.log('\n== 六包主线 + 全部非 done 在途卡 ==');
  for (const t of interesting.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || String(a.seq).localeCompare(String(b.seq)))) {
    const ex = (t.executions ?? []).at(-1);
    const exs = ex ? ` | last=${ex.status ?? '?'} sid=${(ex.sessionId ?? '').slice(0, 24)} ended=${ex.endedAt ? new Date(ex.endedAt).toISOString() : '-'}` : ' | 无执行记录';
    console.log(`[${t.status}] ${t.line ?? '(未归线)'} · ${t.seq ?? '-'} | ${t.title} | id=${t.id.slice(0, 8)}${exs}`);
  }
  return 0;
}

process.exitCode = await main();
