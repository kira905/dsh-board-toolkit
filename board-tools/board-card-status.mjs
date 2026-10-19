// 只读：核一张卡的 status + 最后两条 executions + 执行会话是否在跑（起卡后一次性核对，别轮询）
// 用法：node board-card-status.mjs <卡id或前缀>
//
// 2026-09-24 修「验收判据②恒假绿」（交办档 docs\交办-看板卡状态判据假绿-20260924.md）：
//   ① 会话索引键 i.id → i.sessionId：0.1.5 会话表实测 210/210 项**没有 id 字段**，旧写法 Map 只有
//      一个 undefined 键 ⇒ 查找恒落空 ⇒ 永远打印「会话不在列表」，把**正在跑**的卡显示成"已结束、可验收"。
//   ② 数据面自检：items 非空却没有一项带 sessionId ⇒ 打印「会话数据面异常（字段名疑似变更）」+ exit 3，
//      不退化写成「会话不在列表」。
//   ③ 两种"查不到"分开：会话表是窗口制（当前约 210 条）⇒ 不在列表写成 `false（列表窗口外/已归档 · 弱判据）`，
//      不让人读成"已结束"。
//   ④ fail-safe：会话表不可得 / 为空 / 执行记录无 sessionId / running 非布尔 ⇒ 判 `unknown`，
//      **绝不**默认按"已结束、可验收"处理。
//   ⑤ 单测注入（只读）：`BOARD_CARD_STATUS_SESSIONS_FILE=<json 路径>` 时改读该文件的 session.list 响应；
//      不设该变量时行为与旧版一致，既有 CLI 调用方式与主要输出行格式不变。
import fs from 'node:fs';
const BASE = process.env.DSH_WEB_URL || 'http://localhost:3080';
import { hostRpc, hostRpcJson } from '../lib/dsh-rpc-client.mjs';
const H = { origin: BASE, 'sec-fetch-site': 'same-origin' };

/**
 * 取会话表。返回 `{ ok:true, items, source }` 或 `{ ok:false, reason }`。
 * fail-safe：任何"拿不到 / 形状不对"一律 ok:false（调用方据此判 unknown），**绝不**退化成空数组当"没在跑"。
 */
async function loadSessions() {
  const fixture = process.env.BOARD_CARD_STATUS_SESSIONS_FILE;
  if (fixture) {
    try {
      const j = JSON.parse(fs.readFileSync(fixture, 'utf8'));
      const items = j?.result?.value?.items ?? j?.items;
      if (!Array.isArray(items)) return { ok: false, reason: `注入夹具形状不可识别（无 result.value.items / items 数组）：${fixture}` };
      return { ok: true, items, source: `fixture:${fixture}` };
    } catch (e) { return { ok: false, reason: `注入夹具读取失败：${String(e?.message ?? e)}` }; }
  }
  try {
    const j = await hostRpcJson(BASE, 'session.list', {}, { timeoutMs: 20_000 });
    if (j?.result?.ok === false) {
      const err = j.result.error;
      return { ok: false, reason: `session.list 返回错误：${`${err?.code ?? ''} ${err?.message ?? ''}`.trim()}` };
    }
    const items = j?.result?.value?.items;
    if (!Array.isArray(items)) return { ok: false, reason: `session.list 响应形状不可识别（无 result.value.items）：${JSON.stringify(j ?? null)?.slice(0, 160)}` };
    return { ok: true, items, source: 'rpc' };
  } catch (e) {
    return { ok: false, reason: `session.list 调用失败：${String(e?.message ?? e)}` };
  }
}

/**
 * 建会话索引 + 数据面自检。
 * items 非空却没有一项带 sessionId ⇒ `{ ok:false, reason }`（调用方打印异常并 exit 3）。
 */
function indexSessions(items) {
  const keyed = items.filter((i) => i && typeof i.sessionId === 'string' && i.sessionId.length > 0);
  if (items.length > 0 && keyed.length === 0) {
    return { ok: false, reason: `items=${items.length} 项，无一项带 sessionId；首项字段名=${Object.keys(items[0] ?? {}).join(',') || '（空对象）'}` };
  }
  return { ok: true, byId: new Map(keyed.map((i) => [i.sessionId, i])), empty: items.length === 0 };
}

/** 会话存活判据文案：`true` / `false（…弱判据）` / `unknown（…）` —— 拿不准一律 unknown，不按"已结束"处理。 */
function runningText(entry, s, ctx) {
  if (ctx.weak) return `unknown（${ctx.weak} · 弱判据，不按"已结束"处理）`;
  if (!entry.sessionId) return 'unknown（执行记录无 sessionId · 弱判据）';
  if (s === undefined) return 'false（列表窗口外/已归档 · 弱判据）';
  if (s.running === true) return 'true';
  if (s.running === false) return 'false';
  return `unknown（会话项 running 非布尔：${JSON.stringify(s.running ?? null)} · 弱判据）`;
}

async function main() {
  const short = process.argv[2];
  if (!short) { console.error('用法：node board-card-status.mjs <卡id或前缀>'); return 2; }
  const st = await (await fetch(`${BASE}/api/task-board/state`, { headers: H })).json();
  const list = (st.tasks ?? []).filter((t) => t.id.startsWith(short));
  if (!list.length) { console.error('未找到卡 ' + short); return 3; }
  // 0.1.5 换线（2026-09-22）：适配层
  const ses = await loadSessions();
  let byId = null;
  let weak = null;
  if (!ses.ok) {
    weak = `会话表不可得：${ses.reason}`;
  } else {
    const idx = indexSessions(ses.items);
    if (!idx.ok) { console.error('会话数据面异常（字段名疑似变更）：' + idx.reason); return 3; }
    byId = idx.byId;
    if (idx.empty) weak = '会话表为空（列表窗口为空）';
  }
  const ctx = { byId, weak };
  for (const t of list) {
    console.log(`卡：${t.title}\n  id=${t.id}\n  status=${t.status}  line=${t.line ?? '-'} seq=${t.seq ?? '-'}  rev=${st.revision}`);
    const ex = (t.executions ?? []).slice(-2);
    if (!ex.length) console.log('  executions: 无');
    for (const e of ex) {
      const s = e.sessionId ? byId?.get(e.sessionId) : undefined;
      const when = e.startedAt ? new Date(e.startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '-';
      const end = e.endedAt ? new Date(e.endedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '-';
      console.log(`  exec: status=${e.status ?? '?'} sid=${e.sessionId ?? '-'}\n        起=${when} 结=${end} 会话running=${runningText(e, s, ctx)}`);
      if (s?.title) console.log(`        会话标题=${s.title}`);
    }
  }
  return 0;
}

process.exitCode = await main();
