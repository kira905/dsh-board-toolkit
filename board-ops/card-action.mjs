#!/usr/bin/env node
// board-ops / card-action.mjs —— 卡的动作（confirm / reject / move / archive / restore / delete）
//
// 账本铁律：一律走 Host HTTP API，**绝不直接编辑 ledger-v2.json**。
// 语义提醒：
//   · confirm 仅对 review 卡有效（once→done，recurring→todo）
//   · reject 仅对 review 卡有效（→todo，note 追加进 description）
//   · move 只能到 MANUAL_STATUSES = backlog / todo / done（review 不能手移，会报 invalid manual status）
//   · archive 仅 done/failed 可归档，归档后整卡只读
// 用法：
//   node <workspace>\tools\board-ops\card-action.mjs <taskId> <confirm|reject|move|archive|restore|delete> [--status backlog|todo|done] [--note "..."] [--apply]
// 默认 dry-run；必须显式 --apply 才真提交。
// 退出码：0 成功 / 1 失败 / 2 用法错
const HELP = `卡的动作

用法：node card-action.mjs <taskId> <动作> [选项]
  动作：confirm | reject | move | archive | restore | delete
  --status <backlog|todo|done>  move 的目标列（必填于 move）
  --note "<文本>"               reject 的打回原因（追加进 description）；其他动作静默忽略
  --apply                      真提交（缺省 = dry-run）
  --base-url <URL>              DSH 地址（默认 http://localhost:3080）`;
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); process.exitCode = 0; }
else {
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const BASE = val('--base-url', process.env.DSH_WEB_URL?.replace('127.0.0.1', 'localhost') ?? 'http://localhost:3080');
  const H = { 'content-type': 'application/json', origin: BASE, 'sec-fetch-site': 'same-origin' };
  const KINDS = ['confirm', 'reject', 'move', 'archive', 'restore', 'delete'];
  const id = argv.find((a) => /^[0-9a-f-]{36}$/i.test(a));
  const kind = argv.find((a) => KINDS.includes(a));
  const APPLY = argv.includes('--apply');
  const note = val('--note', undefined);
  const status = val('--status', undefined);

  if (!id || !kind) { console.error('用法: node card-action.mjs <taskId> <confirm|reject|move|archive|restore|delete> [--status ...] [--note ...] [--apply]'); process.exitCode = 2; }
  else if (kind === 'move' && !['backlog', 'todo', 'done'].includes(status)) {
    console.error('move 需要 --status backlog|todo|done（review 不能手移，请用 confirm/reject）');
    process.exitCode = 2;
  } else {
    const action = { kind, taskId: id };
    // note 只随 reject 提交：Host 侧 protocol.ts 对 confirm 走 exactKeys(['kind','taskId']) 严格校验
    // ⇒ confirm / move / archive / restore / delete 带 note 一律判非法（invalid-action，整条动作被拒）。
    // 故非 reject 动作即便传了 --note 也**静默忽略**（不提交、不报错）——避免"多带一个 note 反而整条失败"。
    // （reject 分支才认 note，Host 会把它追加进 description。）
    if (note && kind === 'reject') action.note = note;
    if (status) action.status = status;
    console.log(`[${APPLY ? 'apply' : 'dry-run'}] action = ${JSON.stringify(action)}`);
    if (note && kind !== 'reject') console.log(`（提示：--note 仅对 reject 生效，本次 ${kind} 已忽略该 note）`);
    if (!APPLY) { console.log('（未提交；加 --apply 真提交）'); process.exitCode = 0; }
    else {
      const res = await fetch(`${BASE}/api/task-board/action`, {
        method: 'POST', headers: H, body: JSON.stringify({ requestId: randomUUID(), action }),
      });
      const b = await res.json();
      if (!res.ok || b.ok === false) { console.error('FAIL:', JSON.stringify(b).slice(0, 500)); process.exitCode = 1; }
      else {
        const t = (b.tasks ?? b.value?.tasks ?? []).find((x) => x.id === id);
        console.log(`[OK] status=${t?.status ?? '?'} archivedAt=${t?.archivedAt ?? '无'} rev=${b.revision ?? b.value?.revision ?? '?'}`);
        process.exitCode = 0;
      }
    }
  }
}
