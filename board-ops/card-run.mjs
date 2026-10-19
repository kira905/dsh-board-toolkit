#!/usr/bin/env node
// board-ops / card-run.mjs —— 起卡（run：Host 开独立会话跑卡 prompt）
//
// ⚠️ 起卡后**必须紧接着绑定发起会话**（card-note 不管绑定；绑定用 dsh-butler 的 butler-bind-card.mjs），
//    否则 queue 通知会退化到"猜标题"、多个【运行】会话时一次都不投递（静默）。
// 用法：
//   node <workspace>\tools\board-ops\card-run.mjs <taskId> [--rerun] [--apply]
// 默认 dry-run；必须显式 --apply 才真起卡。
// 退出码：0 成功 / 1 失败 / 2 用法错
const HELP = `起卡（run / rerun）

用法：node card-run.mjs <taskId> [--rerun] [--apply] [--base-url URL]
  --rerun          用 rerun 动作（重跑）
  --apply          真提交（缺省 = dry-run 预览）
  --base-url <URL> DSH 地址（默认 http://localhost:3080）

起卡后请立刻绑定发起会话：
  node <workspace>\\tools\\dsh-butler\\butler-bind-card.mjs --card <taskId> --session auto`;
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); process.exitCode = 0; }
else {
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const BASE = val('--base-url', process.env.DSH_WEB_URL?.replace('127.0.0.1', 'localhost') ?? 'http://localhost:3080');
  const H = { 'content-type': 'application/json', origin: BASE, 'sec-fetch-site': 'same-origin' };
  const id = argv.find((a) => /^[0-9a-f-]{36}$/i.test(a));
  const KIND = argv.includes('--rerun') ? 'rerun' : 'run';
  const APPLY = argv.includes('--apply');
  // --requester（2026-10-12 · V2.9收口·窗口活）：把"谁起的卡"写进账本
  // executions[].requestedBy。缺省取当前会话 id；取不到就不带该字段（老行为）。
  const REQUESTER = val('--requester', process.env.DSH_SESSION_ID) ?? '';

  if (!id) { console.error('用法: node card-run.mjs <taskId> [--rerun] [--apply] [--requester <sessionId>]'); process.exitCode = 2; }
  else {
    console.log(`[${APPLY ? 'apply' : 'dry-run'}] ${KIND} 卡 ${id}` + (REQUESTER ? ` · requester=${REQUESTER}` : ' · requester=(未提供，不带该字段)'));
    if (!APPLY) { console.log('（未提交；加 --apply 真起卡）'); process.exitCode = 0; }
    else {
      const actionBody = { kind: KIND, taskId: id };
      if (REQUESTER !== '') actionBody.requester = REQUESTER;
      const res = await fetch(`${BASE}/api/task-board/action`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ requestId: randomUUID(), action: actionBody }),
      });
      const b = await res.json();
      if (!res.ok || b.ok === false) { console.error('FAIL:', JSON.stringify(b).slice(0, 600)); process.exitCode = 1; }
      else {
        const t = (b.tasks ?? b.value?.tasks ?? []).find((x) => x.id === id);
        const last = (t?.executions ?? []).slice(-1)[0] ?? null;
        console.log(`[OK] ${KIND} 已接受 · status=${t?.status ?? '?'} rev=${b.revision ?? b.value?.revision ?? '?'}`);
        console.log('executions 末条:', JSON.stringify(last));
        console.log('\n下一步：立刻绑定发起会话 —— node <workspace>\\tools\\dsh-butler\\butler-bind-card.mjs --card ' + id + ' --session auto');
        process.exitCode = 0;
      }
    }
  }
}
