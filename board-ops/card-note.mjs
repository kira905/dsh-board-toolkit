#!/usr/bin/env node
// board-ops / card-note.mjs —— 把一段文本追加进卡的 description（账本留痕；幂等）
//
// 用途：验收结论 / 主人拍板结论 / 事故记录写回卡（**不走 ledger 手改**，一律 Host API）。
// 幂等：description 里已含 --mark 文本则跳过。
// 用法：
//   node <workspace>\tools\board-ops\card-note.mjs --card <taskId> --mark "<幂等标记>" --file <内容文件> [--apply]
// 默认 dry-run；必须显式 --apply 才真写。
// 退出码：0 成功/跳过 / 1 失败 / 2 用法错
const HELP = `卡 description 追加留痕（幂等，走 Host API）

用法：node card-note.mjs --card <taskId> --mark "<幂等标记>" --file <内容.md> [--apply] [--base-url URL]
  --mark  幂等标记（description 含它 = 已写过，跳过）
  --file  要追加的内容（UTF-8 文本；会自动顶一个空行 + 分隔线前的内容原样追加）
  --apply 真写入（缺省 = dry-run）
  --text  <文本>  代替 --file 直接给短文本`;
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); process.exitCode = 0; }
else {
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const BASE = val('--base-url', process.env.DSH_WEB_URL?.replace('127.0.0.1', 'localhost') ?? 'http://localhost:3080');
  const H = { 'content-type': 'application/json', origin: BASE, 'sec-fetch-site': 'same-origin' };
  const card = val('--card', null);
  const mark = val('--mark', null);
  const file = val('--file', null);
  const textArg = val('--text', null);
  const APPLY = argv.includes('--apply');

  if (!card || !mark || (!file && !textArg)) {
    console.error('用法: node card-note.mjs --card <taskId> --mark "<标记>" (--file <path> | --text <文本>) [--apply]');
    process.exitCode = 2;
  } else if (file && !fs.existsSync(file)) {
    console.error('内容文件不存在:', file); process.exitCode = 1;
  } else {
    const note = textArg ?? fs.readFileSync(file, 'utf8');
    const res = await fetch(`${BASE}/api/task-board/state`, { headers: H });
    if (!res.ok) { console.error('读不到看板：HTTP', res.status); process.exitCode = 1; }
    else {
      const state = await res.json();
      const t = (state.tasks ?? []).find((x) => x.id === card);
      if (!t) { console.error('卡不存在:', card); process.exitCode = 1; }
      else if ((t.description ?? '').includes(mark)) { console.log('已含该标记，跳过（幂等）'); process.exitCode = 0; }
      else {
        const next = `${t.description ?? ''}\n${note}`;
        console.log(`卡「${String(t.title).slice(0, 44)}」 status=${t.status} · 描述 ${(t.description ?? '').length} → ${next.length} 字符`);
        if (!APPLY) { console.log('（未提交；加 --apply 真写入）'); process.exitCode = 0; }
        else {
          const r = await fetch(`${BASE}/api/task-board/action`, {
            method: 'POST', headers: H,
            body: JSON.stringify({ requestId: randomUUID(), action: { kind: 'update', taskId: card, patch: { description: next } } }),
          });
          const b = await r.json();
          if (!r.ok || b.ok === false) { console.error('FAIL:', JSON.stringify(b).slice(0, 500)); process.exitCode = 1; }
          else {
            const after = (b.value?.tasks ?? b.tasks ?? []).find((x) => x.id === card);
            console.log(`[OK] 已追加 · status=${after?.status} rev=${b.value?.revision ?? b.revision ?? '?'}`);
            process.exitCode = 0;
          }
        }
      }
    }
  }
}
