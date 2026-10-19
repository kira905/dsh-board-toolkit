#!/usr/bin/env node
/**
 * board-card.mjs —— DSH 看板卡操作 CLI（一律走 Host HTTP API，绝不手改 ledger-v2.json）
 *
 * 用法：
 *   node <workspace>\tools\board-card.mjs status <cardId>            # 卡状态 + 双判据（含执行会话存活）
 *   node <workspace>\tools\board-card.mjs status --line "主线名"      # 列出该主线全部卡
 *   node <workspace>\tools\board-card.mjs run <cardId>               # 手动执行（Host 开独立会话）
 *   node <workspace>\tools\board-card.mjs confirm <cardId>           # 验收通过（once→done / recurring→todo）
 *   node <workspace>\tools\board-card.mjs reject <cardId> --note "…" # 打回（→todo，附原因）
 *   node <workspace>\tools\board-card.mjs move <cardId> <backlog|todo|done>
 *
 * 门禁（2026-09-16 拷问 1.9 补）：
 *   · `run` / `confirm` / `reject` 发请求**之前**先跑双判据 —— 卡 status=review（①）、末次执行会话
 *     `running === false`（②，会话不存在视为已结束）；不满足 → 拒绝（exit 3），`--force` 显式兜底；
 *     会话列表不可用/为空 → 视为**判据②不可验证**，同样拒（拿不到名单 ≠ 会话已结束）。
 *   · `--dry-run`：只打印将要发送的 action 与判据结论，**不发任何请求**（零副作用）。
 *
 * 说明：
 *   · 双判据 = ①卡 status==='review' ②末次执行的执行会话已 running===false（防"假结算"，见 task-board 技能 §7.4）
 *   · baseUrl 默认 http://localhost:3080（本机口径：一律 localhost，不用 127.0.0.1）
 *   · 只读命令（status）零副作用；写命令走 Host 校验 + requestId 幂等
 */
import process from 'node:process';
import { hostRpc, hostRpcJson } from './lib/dsh-rpc-client.mjs';

const BASE = process.env.DSH_WEB_URL || 'http://localhost:3080';
const H = { 'content-type': 'application/json', origin: BASE, 'sec-fetch-site': 'same-origin' };
const argv = process.argv.slice(2);
const cmd = argv[0];
const pos = argv.slice(1).filter((a) => !a.startsWith('--'));
const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const has = (f) => argv.includes(f);

const c = (s, code) => `\u001b[${code}m${s}\u001b[0m`;

async function post(action) {
  const res = await fetch(`${BASE}/api/task-board/action`, {
    method: 'POST', headers: H, body: JSON.stringify({ requestId: crypto.randomUUID(), action }),
  });
  const b = await res.json();
  if (!res.ok || b.ok === false) throw new Error(JSON.stringify(b).slice(0, 500));
  return b;
}

async function readState() {
  const res = await fetch(`${BASE}/api/task-board/state`, { headers: H });
  if (!res.ok) throw new Error(`state HTTP ${res.status}`);
  return res.json();
}

async function listSessions() {
  // 0.1.5 换线（2026-09-22）：适配层；取不到 → null（与旧「!res.ok → null」同语义）
  const { body: j } = await hostRpc(BASE, 'session.list', {}, { timeoutMs: 20_000 });
  if (j?.result === undefined) return null;
  return j?.result?.value?.items ?? null;
}

const ICON = { backlog: '📋', todo: '🟦', running: '🏃', review: '🔎', done: '✅', failed: '❌', cancelled: '🚫' };

async function showCard(card, sessions) {
  const flag = card.archivedAt ? ' [已归档·只读]' : '';
  console.log(`${ICON[card.status] ?? '•'} ${card.status}${flag}  ${card.id}`);
  console.log(`   ${card.title}`);
  console.log(`   主线: ${card.line ?? '未归线'} ${card.seq ? '/ ' + card.seq : ''} | kind: ${card.kind ?? '-'} | 执行数: ${(card.executions ?? []).length}`);
  const ex = (card.executions ?? []).slice(-1)[0];
  if (ex) {
    console.log(`   末次执行: ${ex.sessionId ?? '(无 sessionId)'} result=${ex.result ?? '-'} endedAt=${ex.endedAt ? new Date(ex.endedAt).toLocaleString('zh-CN', { hour12: false }) : '-'}`);
    if (sessions) {
      const s = sessions.find((i) => i.sessionId === ex.sessionId);
      const alive = s ? s.running === true : false;
      console.log(`   判据② 执行会话: ${s ? (alive ? c('仍在 running ⚠️ 假结算风险', 31) : c('已结束 ✅', 32)) : c('会话不存在（视为已结束）✅', 32)}`);
    }
  }
  if (card.status === 'review') console.log(c('   判据① status=review ✅ → 双判据齐备可验收', 32));
}

/**
 * 【2026-09-16 拷问 1.9】写动作门禁：run / confirm / reject 之前先跑**双判据**（技能 §7.4 明令）。
 *
 * 为什么必须有（现场）：本 CLI 上午刚写出来时 **只**把判据做进了 `status` 的展示里，
 *   写命令一路直发 Host ⇒ 可以直接 `confirm` 掉一张"假结算"卡（执行会话还在跑），
 *   而 Host 侧 `host-ledger.ts` 也不兜底 —— 正是技能明令禁止的动作。
 *
 * 判据（保守：拿不准就拒，`--force` 显式兜底）：
 *   ① `confirm` / `reject`：卡必须 `status === 'review'`；
 *   ② 末次执行的会话**仍在 running** → 拒（假结算风险）；
 *   ③ 会话列表不可用 / 为空（列表不可信）→ 拒（判据②不可验证，与 `lib/queue-watch.mjs`
 *      的 `list-untrusted` 同口径；"拿不到名单"绝不等于"会话已结束"）；
 *   ④ `run`：卡已在 `running` / 已归档 → 拒（防重复起会话）。
 *   卡没有 executions（如待办卡首次 run）→ 判据② 不适用，直接放行。
 * @returns {{ok:boolean, problems:string[], sessionId:string|null, alive:boolean, listTrusted:boolean}}
 */
function gateCheck(cmd, card, sessions) {
  const ex = (card.executions ?? []).slice(-1)[0] ?? null;
  const sessionId = ex?.sessionId ?? null;
  const listTrusted = Array.isArray(sessions) && sessions.length > 0;
  const s = (sessionId && listTrusted) ? sessions.find((i) => i.sessionId === sessionId) : null;
  const alive = s ? s.running === true : false;
  const problems = [];
  if (cmd === 'confirm' || cmd === 'reject') {
    if (card.status !== 'review') problems.push(`判据① 不成立：卡 status=${card.status}（confirm/reject 需 status=review）`);
  }
  if (cmd === 'run') {
    if (card.status === 'running') problems.push('卡已在 running（防重复开执行会话）');
    if (card.archivedAt) problems.push('卡已归档（归档卡只读）');
  }
  if (sessionId) {
    if (!listTrusted) problems.push('判据② 不可验证：会话列表不可用或为空（列表不可信 ≠ 会话已结束）');
    else if (alive) problems.push(`判据② 不成立：执行会话 ${sessionId} 仍在 running（假结算风险，见技能 §7.4）`);
  }
  return { ok: problems.length === 0, problems, sessionId, alive, listTrusted };
}

try {
  if (cmd === 'status') {
    const st = await readState();
    if (get('--line')) {
      const line = get('--line');
      const list = st.tasks.filter((t) => t.line === line);
      console.log(`主线「${line}」共 ${list.length} 张（revision ${st.revision}）\n`);
      for (const t of list) console.log(`${ICON[t.status] ?? '•'} ${t.status.padEnd(8)} ${(t.seq ?? '-').padEnd(14)} ${t.title.slice(0, 70)}`);
    } else if (pos[0]) {
      const card = st.tasks.find((t) => t.id === pos[0]);
      if (!card) { console.error('未找到卡', pos[0]); process.exitCode = 2; }
      else {
        await showCard(card, await listSessions());
        if (has('--desc')) {
          const d = card.description ?? '';
          const lim = Number(get('--desc')) || d.length;
          console.log(`\n=== description ${lim < d.length ? `尾部 ${lim} 字符` : '全文'}（共 ${d.length} 字符）===`);
          console.log(d.slice(-lim));
        }
      }
    } else { console.error('用法: status <cardId> | --line "主线"'); process.exitCode = 2; }
  } else if (cmd === 'run' || cmd === 'confirm' || cmd === 'reject' || cmd === 'move') {
    const id = pos[0];
    if (!id) { console.error('缺 cardId'); process.exitCode = 2; }
    else {
      const action = cmd === 'move'
        ? { kind: 'move', taskId: id, status: pos[1] }
        : cmd === 'reject'
          ? { kind: 'reject', taskId: id, note: get('--note') }
          : { kind: cmd, taskId: id };
      if (cmd === 'move' && !pos[1]) { console.error('move 需要目标状态'); process.exitCode = 2; }
      else {
        const dryRun = has('--dry-run');
        const force = has('--force');
        const st = await readState();
        const card = st.tasks.find((t) => t.id === id);
        if (!card) { console.error('未找到卡', id); process.exitCode = 2; }
        else {
          // 【拷问 1.9】move 只改列，不判执行会话；run/confirm/reject 走双判据门禁
          const g = cmd === 'move' ? { ok: true, problems: [], sessionId: null, alive: false, listTrusted: true } : gateCheck(cmd, card, await listSessions());
          if (!g.ok && !force) {
            console.error(`⛔ ${cmd} 被门禁拒绝（${card.title.slice(0, 50)}）：`);
            for (const p of g.problems) console.error(`   - ${p}`);
            console.error('   复核无误后加 --force 兜底（技能 §7.4 双判据）；只读复查用 status <cardId>');
            process.exitCode = 3;
          } else {
            if (!g.ok && force) console.error(`⚠️ --force 覆盖门禁：${g.problems.join('；')}`);
            if (dryRun) {
              console.log(`[dry-run] 卡 ${id}（${card.status}）→ 将发送 action：${JSON.stringify(action)}`);
              console.log(`[dry-run] 判据②：执行会话 ${g.sessionId ?? '(无)'} · ${g.listTrusted ? (g.alive ? 'running（危险）' : '已结束 / 不存在 ✅') : '列表不可信'} · 未发送任何请求 ✅`);
            } else {
              await post(action);
              const st2 = await readState();
              const card2 = st2.tasks.find((t) => t.id === id);
              console.log(`✅ ${cmd} 完成 → status = ${card2?.status} (revision ${st2.revision})`);
              if (card2) await showCard(card2, await listSessions());
            }
          }
        }
      }
    }
  } else {
    console.log('用法：status <cardId> | status --line "主线" | run|confirm|reject|move <cardId> [--note "…"] [--dry-run] [--force]');
    process.exitCode = 2;
  }
} catch (e) {
  console.error('失败:', e?.message ?? e);
  process.exitCode = 2;
}
