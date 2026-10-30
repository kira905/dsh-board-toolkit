#!/usr/bin/env node
/**
 * archive-index-export.mjs —— `_archive` 索引导出器（**只收目录级元数据，绝不含内容**）
 *
 * 为什么存在（2026-09-17 · 卡 D5 巡检报告 §6.3-B）：
 *   `_archive` **不进任何仓**（跨机不同步）⇒ 产物在对端机时，本机无从核对，只能靠变更流水 +
 *   第三方验收间接推断；遇到流水也没写的就只剩「无法判定」。实测案例：`S3·[11b-prep]`（`1fcaf8a7`）
 *   的候选包在 主机 B 侧 `_archive\p8-11b-prep-20260911-2233\`（20 项），本机零产物 ⇒ 下游卡只好重做一遍。
 *   本脚本把「_archive 一级目录的清单」落成一个小 JSON（随仓3 同步），对端 pull 后即可判
 *   「卡里声称的产物在对端确实存在」。
 *
 * 口径（与巡检报告 §6.3-B 一致）：
 *   - 只记：目录名 / 文件数 / 字节数 / mtime / 是否含 manifest.json / 是否含 restore 脚本 / 顶层文件名（截断到 N）；
 *   - **不算 sha**（3.6 万文件全量算 sha 太慢且无必要，目录名 + 文件数 + 时间已足够判存在性）；
 *   - 内容（文件本体）**永远不同步**；本索引只是"有哪些桶、桶里几个东西"的目录页。
 *
 * 用法：
 *   node archive-index-export.mjs [--archive <dir>] [--out <file>] [--top 20] [--dry-run] [--json]
 *   默认 --archive <workspace>\_archive · --out <workspace>\docs\archive-index-<host>.json
 *
 * 退出码：0 成功 / 1 采集异常 / 2 用法或前置错误
 * 安全：源目录**只读**；只写 --out 指定文件（默认在 docs/ 内，随仓3 既有白名单采集）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { hostTag } from './lib/host-tag.mjs';
import { ARCHIVE_DIR, DOCS_DIR } from './lib/workspace.mjs';
import { cliGuard } from './lib/cli-args.mjs';

const SPEC = {
  cmd: 'archive-index-export',
  summary: '导出归档目录的一级清单（只有目录名 / 文件数 / 字节数 / mtime，绝不含内容），对端据此判「卡里声称的产物到底在不在」。',
  usage: 'archive-index-export [--archive <目录>] [--out <文件>] [--top 20] [--dry-run] [--json]',
  flags: [
    { name: '--archive', arg: '目录', desc: '要建索引的归档根目录' },
    { name: '--out', arg: '文件', desc: '索引 JSON 落点（缺省落在 docs/ 下）' },
    { name: '--top', arg: 'N', desc: '每个桶记前 N 个顶层文件名，默认 20' },
    { name: '--host', arg: '标签', desc: '主机标签（写进文件名）' },
    { name: '--dry-run', desc: '只打印将要写什么，不落盘' },
    { name: '--json', desc: '只吐 JSON，不打人读日志' },
  ],
  writes: '源目录只读；只写 --out 指定的那一份索引 JSON（不写内容、不算 sha）。--dry-run 时连这份也不写。',
  dryRun: '加 --dry-run 只打印计划，不落盘。',
  exits: '0 成功 · 1 采集异常 · 2 用法或前置错误',
  examples: ['archive-index-export', 'archive-index-export --top 5 --dry-run'],
};
const argv = cliGuard(SPEC);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 ? (argv[i + 1] ?? d) : d; };

const HOST = hostTag({ host: val('--host', undefined) });
const ARCHIVE = path.resolve(val('--archive', ARCHIVE_DIR));
const OUT = path.resolve(val('--out', path.join(DOCS_DIR, `archive-index-${HOST}.json`)));
const TOP = Math.max(0, Number(val('--top', '20')) || 0);
const DRY = has('--dry-run');
const AS_JSON = has('--json');

const log = (m) => { if (!AS_JSON) console.log(m); };

/** 目录项是不是 reparse point（junction/符号链接）—— 内容 reparse point 不穿透（照 tidy-walk 口径）。 */
function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** 递归统计（不穿透链接）；返回 { files, bytes, truncated }。 */
function walk(dir, budget = { files: 0, bytes: 0 }) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return budget; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (isLink(p)) { budget.files += 0; budget.linked = (budget.linked ?? 0) + 1; continue; }
      walk(p, budget);
    } else if (e.isFile()) {
      budget.files++;
      try { budget.bytes += fs.statSync(p).size; } catch { /* 统计失败不阻断 */ }
    }
  }
  return budget;
}

if (!fs.existsSync(ARCHIVE)) {
  log(`XX 源目录不存在：${ARCHIVE}`);
  if (AS_JSON) console.log(JSON.stringify({ ok: false, reason: `archive not found: ${ARCHIVE}` }));
  process.exitCode = 2;
} else {
  const dirs = [];
  let totalFiles = 0;
  let totalBytes = 0;
  const bad = [];
  const top = fs.readdirSync(ARCHIVE, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  for (const name of top) {
    const full = path.join(ARCHIVE, name);
    if (isLink(full)) { dirs.push({ name, link: true, files: 0, bytes: 0, mtime: null }); continue; }
    try {
      const st = fs.statSync(full);
      const agg = walk(full);
      let manifest = null;
      let restore = [];
      try {
        const inner = fs.readdirSync(full).filter((n) => n !== '.' && n !== '..');
        const mf = inner.find((n) => /^manifest\.json$/i.test(n));
        if (mf) {
          const raw = fs.readFileSync(path.join(full, mf), 'utf8');
          const j = JSON.parse(raw);
          const arr = Array.isArray(j) ? j : (Array.isArray(j.files) ? j.files : (Array.isArray(j.items) ? j.items : null));
          manifest = { file: mf, entries: arr ? arr.length : null, names: arr ? arr.slice(0, TOP).map((x) => (typeof x === 'string' ? x : (x?.name ?? x?.original ?? JSON.stringify(x)?.slice(0, 80)))) : null };
        }
        restore = inner.filter((n) => /^restore.*\.(mjs|cmd|ps1)$/i.test(n)).slice(0, 5);
      } catch { /* manifest 读不动就只记计数 */ }
      dirs.push({
        name,
        files: agg.files,
        bytes: agg.bytes,
        mtime: st.mtime.toISOString(),
        ...(agg.linked ? { linkedSubdirs: agg.linked } : {}),
        ...(manifest ? { manifest } : {}),
        ...(restore.length ? { restore } : {}),
      });
      totalFiles += agg.files;
      totalBytes += agg.bytes;
    } catch (e) {
      bad.push({ name, error: String(e?.message ?? e) });
    }
  }

  const out = {
    schemaVersion: 1,
    kind: 'archive-index',
    host: HOST,
    generatedAt: new Date().toISOString(),
    archiveRoot: ARCHIVE,
    note: '只记目录级元数据（名/文件数/字节/时间/manifest 摘要/restore 脚本名），不含内容；用于跨机核对"产物在对端是否存在"',
    totals: { dirs: dirs.length, files: totalFiles, bytes: totalBytes },
    dirs,
    ...(bad.length ? { errors: bad } : {}),
  };
  const text = JSON.stringify(out, null, 2) + '\n';

  if (DRY) {
    log(`（dry-run）将写 ${OUT}：${dirs.length} 个一级目录 · ${totalFiles} 文件 · ${(totalBytes / 1048576).toFixed(1)}MB`);
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, text, 'utf8');
    log(`✅ 已写 ${OUT}（${dirs.length} 目录 · ${totalFiles} 文件 · ${(totalBytes / 1048576).toFixed(1)}MB · ${text.length} 字符）`);
  }
  if (AS_JSON) console.log(JSON.stringify({ ok: bad.length === 0, dirs: dirs.length, files: totalFiles, bytes: totalBytes, out: DRY ? null : OUT, errors: bad.length }));
  process.exitCode = bad.length ? 1 : 0;
}
