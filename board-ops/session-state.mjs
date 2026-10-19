#!/usr/bin/env node
// board-ops / session-state.mjs —— 查若干会话是否还在跑（只读）
//
// 用途：**验收判据②** —— 卡结算成 review 后，必须确认 `executions` 末条 sessionId 对应会话
//        `running === false`，否则是"假结算"（DSH 重启打断在跑的卡时，runner 会批量结算成 review）。
// 用法：
//   node <workspace>\tools\board-ops\session-state.mjs <sid...> [--all] [--find <关键词>] [--base-url URL] [--json]
//   sid 可带或不带 `session-` 前缀。
// 退出码：0 正常 / 1 读不到会话列表 / 2 用法错
//
// 2026-09-24 修「短前缀静默谎报已结束」（卡 55400616 · 主线 大管家 · 全家桶愿景）：
//   匹配语义**未变**（仍是与 `sessionId` 去掉 `session-` 后**全等**比较；把全等改成前缀匹配属方案 A，不在本卡）。
//   改动只在"未命中"的**表述**：不再写「视为已结束 ✓」，改为**弱判据**——
//     · 未命中 ⇒ `MISSING …（未精确命中 · 弱判据：不代表已结束）`。会话表是**窗口制**（当前 200+ 条），
//       早先的会话会掉出窗口；未命中既可能是"老会话"、也可能是"你传的是 8 位短前缀"或写错了 id。
//     · 唯一前缀命中 ⇒ 额外回显完整 sid（可直接复制再跑）。
//     · 多前缀命中 ⇒ 只报候选条数，不逐条刷屏。
//   命中时的既有输出（`RUNNING` / `idle` 行、`会话总数 …` 行）与全等匹配语义一律不变。
//   ⚠️ 判据②方向：**未命中 ≠ 已结束**。要确认"没在跑"，须拿到**完整 sid 且命中**、且该行是 `idle`；
//      只有短前缀时请改用 `board-tools\board-card-status.mjs`，或补全 sid 后再跑本工具。
const HELP = `查会话存活（只读；验收判据②用）

用法：node session-state.mjs <sid...> [选项]
  --all            列出全部会话（含 running=false），默认只详列你指定的
  --find <关键词>  按标题子串过滤后再列
  --base-url <URL> DSH 地址（默认 http://localhost:3080）
  --json           机读输出
  --help           本帮助

判据②口径：卡 status=review **且** 执行会话 running=false（⚠️ 未精确命中是弱判据，**不代表**已结束；会话表为窗口制）`;

import { hostRpc, hostRpcJson } from '../lib/dsh-rpc-client.mjs';
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); process.exitCode = 0; }
else {
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const BASE = val('--base-url', process.env.DSH_WEB_URL?.replace('127.0.0.1', 'localhost') ?? 'http://localhost:3080');
  const H = { origin: BASE, 'sec-fetch-site': 'same-origin' };
  // 取值型长选项：它们的「值」不是位置参数，别当 sid 收进 wants
  //   （2026-10-16 顺手修：卡「生态·A系列卡6」§8 P-1 —— `--find <词>` 的值原先被当 sid
  //    ⇒ 末尾多打一条 `MISSING session-<词>` 噪声行；`--base-url <URL>` 同因）
  const VALUE_OPTS = ['--find', '--base-url'];
  const valueIdx = new Set();
  for (const k of VALUE_OPTS) { const i = argv.indexOf(k); if (i >= 0) valueIdx.add(i + 1); }
  const wants = new Set(argv.filter((a, i) => !a.startsWith('--') && !valueIdx.has(i)).map((s) => s.replace(/^session-/, '')));
  const ALL = argv.includes('--all');
  const FIND = val('--find', null);
  const JSONOUT = argv.includes('--json');

  // 0.1.5 换线（2026-09-22）：适配层（新线 + cookie，旧线自动回落）
  const { status: rpcStatus, body: rpcBody } = await hostRpc(BASE, 'session.list', {}, { timeoutMs: 20_000 });
  if (rpcBody?.result === undefined) { console.error('读不到会话列表：HTTP', rpcStatus); process.exitCode = 1; }
  else {
    const j = rpcBody;
    const items = j?.result?.value?.items ?? j?.result?.items ?? [];
    // 标题三态归一化（2026-10-16 修「0.2.0 标题字段失明」· 卡「生态·A系列卡6」）：
    //   ① `s.title` —— 老格式（1.x）
    //   ② `s.projections.values.title` —— 0.2.0（**现跑取证**：顶层 title 命中 0/105、此路径 103/105）
    //   ③ 都没有 / 为空串 ⇒ `'—'`（无标题会话优雅降级，不崩、不吐 undefined）
    //   ⚠️ 判据用 `typeof === 'string' && length > 0`（不是 `??`）：空串标题同样落到下一态。
    //   ⇒ 下游 `--find` 子串过滤与逐条打印读的都是本字段，**自动受益、无需改动**（故本次只改这一处）。
    const pickTitle = (s) => {
      const direct = s?.title;
      if (typeof direct === 'string' && direct.length > 0) return direct;
      const projected = s?.projections?.values?.title;
      if (typeof projected === 'string' && projected.length > 0) return projected;
      return '—';
    };
    const norm = (s) => ({ sid: String(s.sessionId ?? ''), bare: String(s.sessionId ?? '').replace(/^session-/, ''), running: s.running === true, title: pickTitle(s), updated: s.updatedAt ?? s.lastActivityAt ?? null });
    const all = items.map(norm);
    let picked = all;
    if (FIND) picked = picked.filter((x) => String(x.title).includes(FIND));
    else if (wants.size) picked = picked.filter((x) => wants.has(x.bare));
    else if (!ALL) picked = picked.filter((x) => x.running);
    // 未命中的措辞（弱判据）—— 前缀命中提示只为帮人补全 sid，**不改变全等匹配语义**。
    const missText = (w) => {
      const hits = w.length > 0 ? all.filter((x) => x.bare.startsWith(w)) : [];
      const hint = hits.length === 1 ? `；有唯一前缀匹配 ${hits[0].sid}，请传完整 sid`
        : hits.length > 1 ? `；前缀匹配到 ${hits.length} 条会话，请传完整 sid` : '';
      return `MISSING  session-${w}（未精确命中 · 弱判据：不代表已结束${hint}）`;
    };
    if (JSONOUT) {
      console.log(JSON.stringify(picked, null, 2));
      // 机读面：JSON 形状一律不变；弱判据只写 stderr，不污染 stdout（消费方按原样解析 [] 即可）。
      if (wants.size) {
        const foundJ = new Set(picked.map((x) => x.bare));
        for (const w of wants) if (!foundJ.has(w)) console.error(missText(w));
      }
    } else {
      console.log(`会话总数 ${all.length} · running ${all.filter((x) => x.running).length}`);
      if (picked.length === 0) console.log(wants.size
        ? `⚠️ 未精确命中（弱判据：不代表已结束；会话表为窗口制，当前 ${all.length} 条）`
        : '（无匹配）');
      for (const x of picked) {
        const ts = x.updated ? new Date(Number(x.updated)).toLocaleString('zh-CN', { hour12: false }) : '—';
        console.log(`${x.running ? 'RUNNING' : 'idle   '}  ${x.sid}  updated=${ts}  title=${String(x.title).slice(0, 60)}`);
      }
      if (wants.size) {
        const found = new Set(picked.map((x) => x.bare));
        for (const w of wants) if (!found.has(w)) console.log(missText(w));
      }
    }
    process.exitCode = 0;
  }
}
