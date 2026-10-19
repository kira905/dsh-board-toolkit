#!/usr/bin/env node
// board-ops / card-state.mjs —— 查单张卡状态 + 交付报告（只读）
//
// 用途：验收第一步——看 status / executions 末条（sid、started、ended、result）/ description 里的交付报告。
// ⚠️ 判据②（执行会话是否真结束）这里只给 sessionId，**必须**再用 session-state.mjs 查 running。
// 用法：
//   node <workspace>\tools\board-ops\card-state.mjs <taskId> [--report N] [--base-url URL] [--json]
// 退出码：0 找到 / 1 未找到或读不到 / 2 用法错
const HELP = `查单张卡状态 + 交付报告（只读）

用法：node card-state.mjs <taskId> [选项]
  --report <N>      交付报告显示末 N 字符（默认 3000，0 = 不显示）
  --full            description 全文（慎用，可能很长）
  --base-url <URL>  DSH 地址（默认 http://localhost:3080）
  --json            机读输出
  --help            本帮助`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); process.exitCode = 0; }
else {
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const id = argv.find((a) => /^[0-9a-f-]{36}$/i.test(a));
  const BASE = val('--base-url', process.env.DSH_WEB_URL?.replace('127.0.0.1', 'localhost') ?? 'http://localhost:3080');
  const H = { origin: BASE, 'sec-fetch-site': 'same-origin' };
  const REPORT = Number(val('--report', '3000'));
  const FULL = argv.includes('--full');
  const JSONOUT = argv.includes('--json');

  if (!id) { console.error('用法: node card-state.mjs <taskId> [--report N] [--full] [--json]'); process.exitCode = 2; }
  else {
    const res = await fetch(`${BASE}/api/task-board/state`, { headers: H });
    if (!res.ok) { console.error('读不到看板：HTTP', res.status); process.exitCode = 1; }
    else {
      const st = await res.json();
      const t = (st.tasks ?? []).find((x) => x.id === id);
      if (!t) { console.log('未找到卡', id); process.exitCode = 1; }
      else {
        const execs = (t.executions ?? []).slice(-2).map((e) => ({ sid: e.sessionId, started: e.startedAt, ended: e.endedAt ?? null, result: e.result ?? null, error: e.error ?? null }));
        if (JSONOUT) console.log(JSON.stringify({ id, title: t.title, kind: t.kind, status: t.status, line: t.line ?? null, seq: t.seq ?? null, archivedAt: t.archivedAt ?? null, descriptionChars: (t.description ?? '').length, lastExecutions: execs }, null, 2));
        else {
          console.log(`title   = ${t.title}`);
          console.log(`kind    = ${t.kind ?? '—'}  status = ${t.status}  line=${t.line ?? '—'} seq=${t.seq ?? '—'}  archivedAt=${t.archivedAt ?? '无'}`);
          console.log('executions (末 2 条):');
          for (const e of execs) console.log('  ' + JSON.stringify(e));
          console.log(`description 长度 = ${(t.description ?? '').length}`);
          if (FULL) { console.log('--- description 全文 ---'); console.log(t.description ?? ''); }
          else if (REPORT > 0) {
            const d = t.description ?? '';
            const i = d.lastIndexOf('交付报告');
            if (i >= 0) { console.log(`--- 交付报告（末 ${REPORT} 字符）---`); console.log(d.slice(-REPORT)); }
            else console.log('（description 里暂无「交付报告」段）');
          }
        }
        if (t.status !== 'review') console.log('\n提示：卡不在 review 列 —— 验收前先确认它是否被中断结算（核对 executions 末条的 result/error + 执行会话 running）');
        process.exitCode = 0;
      }
    }
  }
}
