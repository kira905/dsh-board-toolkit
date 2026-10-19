#!/usr/bin/env node
// 符号门（2026-09-14）：区分 import type 与运行时 import，判定上游独有依赖在生产主包 0.1.1-rc.2 上的可用性
import fs from "node:fs";
import os from "node:os";
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
// 2026-10-16（卡「0.2.0 升级后遗症收尾 · 复验欠账 #8」）：全局主包闭包位置改由 %APPDATA% 派生。
//   原硬编码 "<home>\\AppData\\Roaming\\..." ⇒ 换到 主机 B（用户 Admin）读不到主包闭包 ⇒ 符号门判错。
const APPDATA_DIR = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const MAIN_DSH = path.join(APPDATA_DIR, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules");
const PKG_ROOT = path.join(MAIN_DSH, "@deepseek-ai");

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : (/\.(ts|tsx)$/.test(e.name) ? [p] : []);
});

/** 解析 import：返回 { module, names[], typeOnly }[] */
function imports(src) {
  const out = [];
  const re = /import\s+(type\s+)?([\s\S]*?)from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const isTypeKw = Boolean(m[1]);
    const clause = m[2].trim();
    const mod = m[3];
    const names = [...clause.matchAll(/[A-Za-z_$][\w$]*/g)].map(x => x[0]).filter(n => n !== "as" && n !== "type" && n !== "default");
    // { type A, type B } 全 type 也算 type-only
    let allTyped = false;
    if (!isTypeKw && clause.startsWith("{")) {
      const parts = clause.replace(/[{}]/g, "").split(",").map(s => s.trim()).filter(Boolean);
      allTyped = parts.length > 0 && parts.every(p => p.startsWith("type "));
    }
    out.push({ module: mod, names, typeOnly: isTypeKw || allTyped });
  }
  return out;
}

const upImports = walk(UP).flatMap(f => imports(fs.readFileSync(f, "utf8")));
const ourImports = walk(OURS).flatMap(f => imports(fs.readFileSync(f, "utf8")));
const ourModules = new Set(ourImports.map(i => i.module));

const isRel = m => m.startsWith(".") || m.startsWith("node:");
const upstreamOnly = new Map();
for (const i of upImports) {
  if (isRel(i.module) || ourModules.has(i.module)) continue;
  const cur = upstreamOnly.get(i.module) ?? { names: new Set(), typeOnly: true, runtime: false };
  i.names.forEach(n => cur.names.add(n));
  if (!i.typeOnly) { cur.runtime = true; cur.typeOnly = false; }
  upstreamOnly.set(i.module, cur);
}

const pkgDir = mod => mod.startsWith("@deepseek-ai/")
  ? path.join(PKG_ROOT, mod.slice("@deepseek-ai/".length).split("/")[0])
  : null;

function symbolHit(dir, name) {
  // 在包内 .d.ts / .js 里粗查符号声明（限深 3）
  const stack = [{ d: dir, depth: 0 }];
  while (stack.length) {
    const { d, depth } = stack.pop();
    if (depth > 3) continue;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") stack.push({ d: p, depth: depth + 1 }); continue; }
      if (!/\.(d\.ts|ts|js|mjs)$/.test(e.name)) continue;
      let txt = "";
      try { txt = fs.readFileSync(p, "utf8"); } catch { continue; }
      if (new RegExp(`(declare (function|const|class|interface|type|namespace)|export (declare )?(function|const|class|interface|type|namespace)?\\s*)${name}\\b`).test(txt)) return true;
      if (new RegExp(`\\b${name}\\b`).test(txt) && /\.d\.ts$/.test(e.name)) return true;
    }
  }
  return false;
}

console.log("===== 上游独有的运行时依赖（移植真正的闸门） =====");
console.log("模块".padEnd(48), "包存在", "缺失符号");
let runtimeCount = 0;
for (const [mod, info] of [...upstreamOnly].sort()) {
  if (!info.runtime) continue;
  runtimeCount++;
  const dir = pkgDir(mod);
  const exists = dir !== null && fs.existsSync(dir);
  let missing = "";
  if (exists) {
    const miss = [...info.names].filter(n => !symbolHit(dir, n));
    missing = miss.length ? miss.join(",") : "（全部命中）";
  }
  console.log(mod.padEnd(48), exists ? "有  " : "★缺 ", missing || (exists ? "" : "整包缺失"));
}
console.log(`\n上游独有 runtime 依赖模块数 = ${runtimeCount}`);

console.log("\n===== 上游独有但仅类型依赖（编译后消失，不影响运行时兼容性） =====");
for (const [mod, info] of [...upstreamOnly].sort()) {
  if (info.runtime) continue;
  console.log("  " + mod + "  符号: " + [...info.names].join(",") + "   包存在=" + (pkgDir(mod) && fs.existsSync(pkgDir(mod)) ? "有" : "缺"));
}
process.exitCode = 0;
