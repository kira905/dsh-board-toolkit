#!/usr/bin/env node
/**
 * board-card-add.mjs —— 从文件建看板卡（长文本走文件，避开脚本里的引号/反引号地狱）
 *
 * 由来：2026-09-16 建卡时实测 —— 把含反引号与单引号的长 prompt 直接写成 JS 字符串字面量，
 *       一个 `'` 就让字符串提前闭合（`SyntaxError: Unexpected identifier`），所以统一改成"文本走文件"。
 *
 * 用法：
 *   node <workspace>\tools\board-card-add.mjs --title "【V3·批次N】…" --prompt <prompt.md> --desc <desc.md> \
 *        --line "大管家 · v3 全量开发" [--seq "V3·批次N"] [--status backlog] [--dry-run] \
 *        [--dor] [--dod] [--dor-block <已填块.md>] [--dod-block <已填块.md>]
 *
 * 带勾选块（2026-10-15 起；块格式真源 = 两份口径档，判据 = `tools\rulecheck.mjs dod|dor`）：
 *   · `--dor`  = 把 **DoR 八条闸门骨架** 插到 description **头部**（卡面头部、正文之前）
 *   · `--dod`  = 把 **DoD 十条勾选骨架** 追加到 description **尾部**（收尾段）
 *   · `--dor-block <file>` / `--dod-block <file>` = 插**已填好的**块（文件须含 `<!-- DoR:begin -->`…`<!-- DoR:end -->`）；
 *                结构不合格（缺锚点 / 缺号）**拒建**，不静默建出坏卡
 *   · 骨架**不预勾**（1 / 2 / 5 是必勾条，但工具不代勾）⇒ 建完请填好再 run，用
 *     `node <workspace>\tools\rulecheck.mjs dor --card <卡id>` 复核（observe 档 · 只报告不拦）
 *   · 幂等：description 已有对应锚点 ⇒ 跳过插入，不重复贴
 *
 * 说明：
 *   · 建卡前**必须**先查重：`node <workspace>\tools\board-dup-check.mjs --kw "关键词"`（看板三视图都过滤归档卡，只看板面必然重复建卡）
 *   · `create` 只能落 `todo`；要进「待规划」用 `--status backlog`（脚本内部再发一次 move）
 *   · 一律走 Host HTTP API（`POST /api/task-board/action`），绝不手改 ledger-v2.json
 *   · baseUrl 默认 http://localhost:3080（本机口径：用 localhost，不用 127.0.0.1）
 *   · workspaceId 默认取本机现有卡通用值；换机或换工作区时用 --ws 覆盖
 */
import fs from 'node:fs';
import process from 'node:process';
// 勾选块的项名与判据从 `rulecheck` 的判据库取 —— **单一真源**，本脚本不另抄一份编号/项名清单
import { DOR_ITEMS, DOD_ITEMS, checkDor, checkDod, checklistLine } from './lib/rulecheck-rules.mjs';

const BASE = process.env.DSH_WEB_URL || 'http://localhost:3080';
const WS_DEFAULT = '49ec8c83-1983-48b4-b68d-b5bb3564e468';
const H = { 'content-type': 'application/json', origin: BASE, 'sec-fetch-site': 'same-origin' };
const argv = process.argv.slice(2);
const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const has = (f) => argv.includes(f);

const title = get('--title');
const promptFile = get('--prompt');
const descFile = get('--desc');
const line = get('--line');
const seq = get('--seq');
const status = get('--status');
const ws = get('--ws') ?? WS_DEFAULT;
const dorBlockFile = get('--dor-block');
const dodBlockFile = get('--dod-block');

// ============================================================================
//  勾选块（DoR / DoD）—— 让"开工就绪自查 / 工程轨自签"在建卡这一步就带上载体
//  --------------------------------------------------------------------------
//  格式真源（只定"写在哪 · 长什么样"，条目内容归它们）：
//    · DoR 八条 → `docs\口径-工程链条规则总纲-20261014.md` §9（条目内容 = §2）
//    · DoD 十条 → `docs\口径-验收两轨制与DoD十条-20261014.md` §10（条目内容 = §2）
//  机器判据：`node <workspace>\tools\rulecheck.mjs dor|dod`（observe 档 · 只报告不拦）
//  ⚠️ 编号与项名 import 自 `lib\rulecheck-rules.mjs`（**单一真源**）；下面两张"填写提示"
//     是照口径档样板写的人读提示 —— 口径档样板改了要同步这里（只影响提示语，不影响判据）。
// ============================================================================
const DOR_HINT = {
  1: '做完长什么样：<一句人能读的「…」>（**必勾**）',
  2: '不做什么：<范围边界>（**必勾**）',
  3: '真源：<档路径 / 现跑读数>',
  4: '等谁 / 等什么：无前置',
  5: '产物：<路径>；怎么验：<命令 / 判据>（**必勾**）',
  6: '备份 <路径>；一行回滚：<命令>',
  7: '甲档（可回滚 / 不花钱 / 不出机器 / 不碰别人东西）',
  8: '干活量 ≈ <n>；闸门 <n> 次（要主人拍几次）',
};
const DOD_HINT = {
  1: '真跑：<命令 + 结论>',
  2: '<夹具 / 隔离目录>',
  3: '回滚点 <路径>；演练 <命令 + 结论>',
  4: '<路径>',
  5: '<日期段第 N 条>',
  6: '未涉及 / 审计凭证',
  7: '处置表 <路径 / 小节>',
  8: '四问自查：可回滚 / 不花钱 / 不出机器 / 不碰别人东西',
  9: '命令：<当次命令原文>（**不许减项**）',
  10: '<未查证项 / 「无」>',
};

/** 生成骨架块（未勾 · 待填；锚点必在位 ⇒ 机器一定解析得到，不会"缺块"） */
function buildBlock(kind) {
  const isDor = kind === 'DoR';
  const items = isDor ? DOR_ITEMS : DOD_ITEMS;
  const hint = isDor ? DOR_HINT : DOD_HINT;
  const head = isDor
    ? '### DoR 八条闸门（开工就绪 · 缺 1 / 2 / 5 不许开工）'
    : '### 工程轨自签 · DoD 十条（本鱼自签 · 不阻塞需求轨）';
  const tip = isDor
    ? '> 建卡时逐条填：**1 / 2 / 5 三条必勾**（连"减项"都不许写）；其余未勾须写明哪几条 + 为什么。指南 = `docs\\口径-工程链条规则总纲-20261014.md` §2 / §9。'
    : '> 收尾时逐条勾、把证据填进说明；未勾必须写「减项」+ 为什么（第 9 条不许减项）。指南 = `docs\\口径-验收两轨制与DoD十条-20261014.md` §2 / §10。';
  const lines = [`<!-- ${kind}:begin -->`, head, tip];
  for (const it of items) lines.push(`- [ ] ${it.no} ${it.name} —— ${hint[it.no] ?? '<待填>'}`);
  lines.push(`<!-- ${kind}:end -->`);
  return lines.join('\n');
}

/**
 * 把块带进 description。返回**新文本**；结构不合格返回 `null`（调用方据此拒建）。
 * @param {string} desc 原 description
 * @param {'DoR'|'DoD'} kind 块类型
 * @param {string|undefined} file 已填块文件（给了就用文件内容，否则用骨架）
 * @param {string[]} notes 过程说明（dry-run / 建卡后打印）
 */
function wireBlock(desc, kind, file, notes) {
  if (desc.includes(`<!-- ${kind}:begin -->`)) {
    notes.push(`${kind} 块：description 里已有锚点 ⇒ 跳过插入（幂等，未改动）`);
    return desc;
  }
  let block;
  if (file) {
    if (!fs.existsSync(file)) { console.error(`❌ ${kind} 块文件不存在：${file}`); return null; }
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
    const res = kind === 'DoR' ? checkDor(text) : checkDod(text);
    const tag = kind === 'DoR' ? 'R1' : 'T1';
    const hard = res.issues.filter((i) => i.id === tag && i.level === '🔴');
    if (hard.length) {
      console.error(`❌ ${kind} 块文件结构不合格 ⇒ 拒建：`);
      for (const h of hard) console.error(`   · ${h.id} ${h.msg}`);
      return null;
    }
    block = text;
    notes.push(`${kind} 块：取自文件（${block.split('\n').length} 行 · ${Buffer.byteLength(block)} B · ${checklistLine(res, kind === 'DoR' ? DOR_ITEMS : DOD_ITEMS)}）`);
  } else {
    block = buildBlock(kind);
    notes.push(`${kind} 块：骨架 ${block.split('\n').length} 行（**待填** · 工具不代勾）`);
  }
  if (kind === 'DoR') return `${block}\n\n${desc}`;              // DoR 落卡面头部（正文之前）
  return `${desc.replace(/\s*$/, '')}\n\n${block}\n`;            // DoD 落卡面尾部（收尾段）
}

const blockNotes = [];
let description = null;
let blockError = null;
if (title && promptFile && descFile && line) {
  description = fs.readFileSync(descFile, 'utf8');
  if (has('--dor') || dorBlockFile) {
    const r = wireBlock(description, 'DoR', dorBlockFile, blockNotes);
    if (r === null) blockError = '❌ DoR 块组装失败 ⇒ 未建卡';
    else description = r;
  }
  if (!blockError && (has('--dod') || dodBlockFile)) {
    const r = wireBlock(description, 'DoD', dodBlockFile, blockNotes);
    if (r === null) blockError = '❌ DoD 块组装失败 ⇒ 未建卡';
    else description = r;
  }
}

if (!title || !promptFile || !descFile || !line) {
  console.error('用法: board-card-add.mjs --title "…" --prompt <file> --desc <file> --line "主线" [--seq S] [--status backlog] [--dry-run] [--dor] [--dod] [--dor-block <f>] [--dod-block <f>]');
  process.exitCode = 2;
} else if (blockError) {
  console.error(blockError);
  process.exitCode = 2;
} else {
  const prompt = fs.readFileSync(promptFile, 'utf8');
  const input = { title, description, prompt, workspaceId: ws, permission: 'danger-full-access', kind: 'once', line, seq };

  const post = async (action) => {
    const res = await fetch(`${BASE}/api/task-board/action`, {
      method: 'POST', headers: H, body: JSON.stringify({ requestId: crypto.randomUUID(), action }),
    });
    const b = await res.json();
    if (!res.ok || b.ok === false) throw new Error(JSON.stringify(b).slice(0, 600));
    return b;
  };

  if (has('--dry-run')) {
    const body = Buffer.byteLength(JSON.stringify({ requestId: 'x'.repeat(36), action: { kind: 'create', id: 'y'.repeat(36), input } }));
    console.log('[dry-run] title:', title);
    console.log('  prompt', prompt.length, 'chars |', Buffer.byteLength(prompt), 'B');
    console.log('  desc  ', description.length, 'chars |', Buffer.byteLength(description), 'B');
    for (const n of blockNotes) console.log('  ·', n);
    for (const kind of ['DoR', 'DoD']) {
      if (!description.includes(`<!-- ${kind}:begin -->`)) continue;
      const r = kind === 'DoR' ? checkDor(description) : checkDod(description);
      const red = r.issues.filter((i) => i.level === '🔴').length;
      console.log(`  ${kind} 自检：${checklistLine(r, kind === 'DoR' ? DOR_ITEMS : DOD_ITEMS)} · 🔴 ${red}${red ? `（骨架未填 ⇒ 属预期；填好后用 \`rulecheck ${kind.toLowerCase()} --card <id>\` 复核）` : ' ✅'}`);
    }
    console.log('  line/seq:', line, '/', seq, '| ws:', ws);
    console.log('  body', body, 'B', body <= 65536 ? '✅ (≤64KiB)' : '❌ 超 64KiB');
  } else {
    try {
      const id = crypto.randomUUID();
      const snap = await post({ kind: 'create', id, input });
      console.log('created', id, '| revision', snap.revision);
      for (const n of blockNotes) console.log('  ·', n);
      if (description.includes('<!-- DoR:begin -->')) console.log(`  ⚠️ DoR 1 / 2 / 5 三条必勾（缺一不许开工）—— 填好后用 \`node <workspace>\\tools\\rulecheck.mjs dor --card ${id}\` 复核`);
      if (status) { await post({ kind: 'move', taskId: id, status }); console.log('moved →', status); }
      const st = await (await fetch(`${BASE}/api/task-board/state`, { headers: H })).json();
      const c = st.tasks.find((t) => t.id === id);
      console.log('回读:', c ? `status=${c.status} line=${c.line} seq=${c.seq}` : '❌ 未找到（create 可能失败）');
      if (c && !c.line) console.log('⚠️ 注意：line 为空 = 落进「未归线」桶，立刻用 update 补上');
      console.log('CARD_ID=' + id);
    } catch (e) {
      console.error('建卡失败:', e?.message ?? e);
      process.exitCode = 2;
    }
  }
}
