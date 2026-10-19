// 量化"自研程度"：我们的 src 与上游 0.3.22 同名文件逐行比对（2026-09-14）
import fs from "node:fs";
import path from "node:path";

// 两棵树都由环境变量注入（本发行版不内置任何本机路径）：
//   BOARD_UPSTREAM_SRC = 上游看板包解包后的 src 目录
//   BOARD_PLUGIN_SRC   = 本仓/本地看板插件的 src 目录
const UP = process.env.BOARD_UPSTREAM_SRC || "";
const OURS = process.env.BOARD_PLUGIN_SRC || "";
if (!UP || !OURS) {
  console.error("need env BOARD_UPSTREAM_SRC and BOARD_PLUGIN_SRC (directories to compare)");
  process.exit(2);
}

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
const rel = (root, p) => p.slice(root.length + 1);
const upFiles = new Map(walk(UP).map(p => [rel(UP, p), p]));
const ourFiles = new Map(walk(OURS).map(p => [rel(OURS, p), p]));

const lines = p => fs.readFileSync(p, "utf8").split(/\r?\n/);
/** 多集差：返回 [仅在A的行数, 仅在B的行数, 共有行数] */
function diff(aLines, bLines) {
  const ca = new Map(), cb = new Map();
  for (const l of aLines) ca.set(l, (ca.get(l) ?? 0) + 1);
  for (const l of bLines) cb.set(l, (cb.get(l) ?? 0) + 1);
  let onlyA = 0, onlyB = 0, both = 0;
  for (const [l, n] of ca) { const m = cb.get(l) ?? 0; const common = Math.min(n, m); both += common; onlyA += n - common; }
  for (const [l, n] of cb) { const m = ca.get(l) ?? 0; onlyB += Math.max(0, n - m); }
  return [onlyA, onlyB, both];
}

const rows = [];
let identical = 0, ourTotal = 0, upTotal = 0, ourOnlyLines = 0, sharedLines = 0;
const identicalFiles = [];
for (const [r, ourPath] of ourFiles) {
  const a = lines(ourPath); ourTotal += a.length;
  const upPath = upFiles.get(r);
  if (upPath === undefined) { rows.push({ r, kind: "我们独有", our: a.length, up: 0, sim: 0 }); ourOnlyLines += a.length; continue; }
  const b = lines(upPath); upTotal += b.length;
  const [onlyOurs, onlyUp, both] = diff(a, b) // diff(a=我们, b=上游) 返回 [仅我们, 仅上游, 共有];
  sharedLines += both; ourOnlyLines += onlyOurs;
  const sim = both === 0 ? 0 : both / Math.max(a.length, b.length);
  if (onlyUp === 0 && onlyOurs === 0) { identical++; identicalFiles.push(r); }
  rows.push({ r, kind: "同名", our: a.length, up: b.length, sim, onlyUp, onlyOurs });
}

console.log(`我们 src：${ourFiles.size} 文件 / ${ourTotal} 行`);
console.log(`上游 src：${upFiles.size} 文件 / ${upTotal} 行`);
console.log(`同名文件：${rows.filter(x => x.kind === "同名").length}　我们独有：${rows.filter(x => x.kind === "我们独有").length}　上游独有（未采用）：${[...upFiles.keys()].filter(k => !ourFiles.has(k)).length}`);
console.log(`\n完全相同（逐行一致）的文件：${identical} 个`);
for (const f of identicalFiles) console.log("   =" + f);
console.log(`\n我们代码里"与上游逐行相同的行"  ≈ ${sharedLines} 行（占我们 ${(sharedLines / ourTotal * 100).toFixed(1)}%）`);
console.log(`我们代码里"上游没有的行"（新增/改写/自建）≈ ${ourOnlyLines} 行（占 ${(ourOnlyLines / ourTotal * 100).toFixed(1)}%）`);

console.log("\n改动最大的 12 个同名文件（按相似度升序）：");
for (const x of rows.filter(r => r.kind === "同名").sort((p, q) => p.sim - q.sim).slice(0, 12)) {
  console.log(`  ${(x.sim * 100).toFixed(0).padStart(3)}% 相似  我们 ${String(x.our).padStart(4)} 行 / 上游 ${String(x.up).padStart(4)} 行   改写 ${String(x.onlyOurs).padStart(4)} 行    ${x.r}`);
}
console.log("\n最接近上游的 10 个同名文件（相似度降序前 10，含完全相同）：");
for (const x of rows.filter(r => r.kind === "同名").sort((p, q) => q.sim - p.sim).slice(0, 10)) {
  console.log(`  ${(x.sim * 100).toFixed(0).padStart(3)}% 相似  我们 ${String(x.our).padStart(4)} 行    ${x.r}`);
}
process.exitCode = 0;
