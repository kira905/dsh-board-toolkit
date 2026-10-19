#!/usr/bin/env node
// board-ops / board-status.mjs —— 看板总览（只读）
//
// 用途：主会话开工/收尾时一眼看清看板实况（在板/归档/状态分布/主线分组）。
// 用法：
//   node <workspace>\tools\board-ops\board-status.mjs [--line "<主线名>"] [--archived N] [--base-url URL] [--help]
// 退出码：0 正常 / 2 用法或环境错误
const HELP = `看板总览（只读）

用法：node board-status.mjs [选项]
  --line <主线名>   只列该主线（精确匹配；可重复）
  --archived <N>    归档卡列前 N 张（默认 20，0 = 不列）
  --base-url <URL>  DSH 地址（默认 http://localhost:3080）
  --json            机读输出
  --help            本帮助

退出码：0 正常 / 2 用法错 / 1 读不到看板`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); process.exitCode = 0; }
else {
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const lines = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--line') lines.push(argv[i + 1]);
  const BASE = val('--base-url', process.env.DSH_WEB_URL?.replace('127.0.0.1', 'localhost') ?? 'http://localhost:3080');
  const ARCH = Number(val('--archived', '20'));
  const JSONOUT = argv.includes('--json');
  const H = { origin: BASE, 'sec-fetch-site': 'same-origin' };

  const res = await fetch(`${BASE}/api/task-board/state`, { headers: H });
  if (!res.ok) { console.error('读不到看板：HTTP', res.status, '（检查 DSH 是否在跑 / 是否同源栅栏）'); process.exitCode = 1; }
  else {
    const st = await res.json();
    const tasks = st.tasks ?? [];
    const live = tasks.filter((t) => !t.archivedAt);
    const arch = tasks.filter((t) => t.archivedAt);
    let sel = live;
    if (lines.length) sel = live.filter((t) => lines.includes((t.line ?? '').trim()));

    if (JSONOUT) {
      console.log(JSON.stringify({ revision: st.revision, total: tasks.length, live: live.length, archived: arch.length, byStatus: count(live), selected: sel.map(slim) }, null, 2));
    } else {
      console.log(`revision=${st.revision} 全量=${tasks.length} 在板=${live.length} 已归档=${arch.length}`);
      console.log('状态分布:', JSON.stringify(count(live)));
      const groups = {};
      for (const t of sel) { const k = (t.line ?? '').trim() || '(未归线)'; (groups[k] ??= []).push(t); }
      console.log(`\n=== ${lines.length ? '指定主线' : '在板主线'}（${Object.keys(groups).length} 组 / ${sel.length} 张）===`);
      for (const [k, arr] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
        console.log(`\n[${k}] ${arr.length} 张  ${JSON.stringify(count(arr))}`);
        for (const t of arr.slice(0, 40)) console.log(`   - ${String(t.status).padEnd(8)} ${String(t.seq ?? '').padEnd(10)} ${(t.title ?? '').slice(0, 70)}`);
      }
      if (ARCH > 0) {
        console.log(`\n=== 已归档卡（前 ${ARCH} 张 / 共 ${arch.length}）===`);
        for (const t of arch.slice(0, ARCH)) console.log(`   - ${String(t.status).padEnd(6)} ${String(t.line ?? '').padEnd(20)} ${(t.title ?? '').slice(0, 62)}`);
      }
    }
    process.exitCode = 0;
  }
}
function count(arr) { const o = {}; for (const t of arr) o[t.status] = (o[t.status] ?? 0) + 1; return o; }
function slim(t) { return { id: t.id, title: t.title, status: t.status, line: t.line ?? null, seq: t.seq ?? null, archived: Boolean(t.archivedAt) }; }
