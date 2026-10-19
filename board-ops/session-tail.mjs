#!/usr/bin/env node
// board-ops / session-tail.mjs —— 读会话 jsonl.zstd 的尾部（只读；多帧 zstd 逐帧解）
//
// 用途：**排障** —— 卡被判 interrupted/failed 时，通知不会告诉你原因；这里能读到
//       `turn/end` 的真实 reason（如 `{kind:"aborted", reason:{kind:"user"}}`）、最后几条消息、
//       工具调用与报错，用来归因（先例：A1 卡被人工中断判 interrupted，靠本工具翻案）。
// 用法：
//   node <workspace>\tools\board-ops\session-tail.mjs <sessionId|会话目录> [--lines N] [--chars N] [--grep 模式] [--raw]
// 退出码：0 正常 / 1 找不到会话 / 2 用法错
//
// 【修·日志工具世代失明 2026-10-10】两处读侧失明：
//   ① 文件名判据：0.1.5 起 `session.jsonl.zstd` → `session.v3.jsonl.zstd`，写死旧名 = 整条失明。
//      （本节 2026-09-24 「修·V3判据③」已改为消费唯一真源 `../lib/session-file-name.mjs`，本次确认仍在。）
//   ② 会话目录定位：原版只拼 `<home>\sessions\<工作区>\session-<id>` 一个路径找 ⇒ 目录名是裸 `<uuid>`
//      的会话（生产实测 3 例）与归档树里的会话一律「找不到会话」rc=1。现两种目录名形态都试、
//      活跃树 + 归档树都搜，精确不成再退化为唯一前缀命中，且报错文案点明「按新旧两种名搜过 + 搜索根目录」。
const HELP = `读会话尾部（只读）

用法：node session-tail.mjs <sessionId|会话目录> [选项]
  --lines <N>   摘要显示末 N 行（默认 30）
  --chars <N>   每行截断字符数（默认 300）
  --grep <文本> 在全文件里做**子串**过滤（配合 --raw 看原始事件行，例：--grep aborted）
  --raw         打印原始 JSON 行（不解析），排查事件用
  --home <dir>  DSH home（默认 ~\\.dsh）

常用：node session-tail.mjs session-xxxx --grep '"type":"turn/end"' --raw --chars 400
      node session-tail.mjs session-xxxx --grep aborted --raw`;
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { resolveDshHome } from '../lib/dsh-home.mjs';
import { pickSessionFileInDir, SESSION_FILE_NAMES } from '../lib/session-file-name.mjs';
// R-066（2026-10-16）：本件打印的是**会话记录**（人会往里贴密钥）⇒ 输出前按
// 「键名 or 值形态」双判据脱敏（共享件；只影响显示，不改任何逻辑）。
// 「键名 or 值形态」双判据脱敏（共享件；只影响显示，不改任何逻辑）。secretsOnly：打屏场景
// 只脱密钥，保留路径/机器名可读性。
import { createRedactor } from '../lib/redact.mjs';

const redactOut = createRedactor({ secretsOnly: true }).redactAndCount;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); process.exitCode = 0; }
else {
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  // 带值选项的「值」不能被当成会话 id 目标（例：--home X <id> 里 X 排在 id 前面）
  const VALUED_FLAGS = new Set(['--lines', '--chars', '--grep', '--home']);
  const target = argv.find((a, i) => !a.startsWith('--') && !/^\d+$/.test(a) && !VALUED_FLAGS.has(argv[i - 1]));
  const linesN = Number(val('--lines', '30'));
  const charsN = Number(val('--chars', '300'));
  const grepPat = val('--grep', null);
  const rawMode = argv.includes('--raw');
  // DSH 数据根默认值：口径 BUTLER_DSH_HOME > DSH_HOME > ~/.dsh（2026-09-17 环境边界修复；
  // --home 显式参数仍最高优先）。原为 path.join(os.homedir(), '.dsh')。
  const home = val('--home', resolveDshHome());

  // 搜索根目录：活跃树 + 归档树（归档里的老会话可能仍是旧世代名，原版只搜活跃树）
  const SEARCH_ROOTS = [path.join(home, 'sessions'), path.join(home, '_archived-sessions')];
  // 会话目录名的两种形态（生产实测并存）：`session-<id>` 与裸 `<id>`（3 例）。
  //   【修·日志工具世代失明 2026-10-10】原版只按 `session-<id>` 拼一个路径去找 ⇒ 裸 uuid 目录
  //   一律「找不到会话」rc=1。现在两种形态都试；精确不成再退化为**唯一前缀**命中，多处命中报歧义。
  function findSessionDir(id) {
    const exact = [], prefixed = [];
    for (const root of SEARCH_ROOTS) {
      const stack = [root];
      while (stack.length) {
        const d = stack.pop();
        let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
          if (!e.isDirectory()) continue;
          const p = path.join(d, e.name);
          if (e.name === id || e.name === 'session-' + id) exact.push(p);
          else if (e.name.startsWith(id) || e.name.startsWith('session-' + id)) prefixed.push(p);
          stack.push(p);
        }
      }
    }
    if (exact.length) return { dir: exact[0], how: 'exact' };
    if (prefixed.length === 1) return { dir: prefixed[0], how: 'prefix' };
    if (prefixed.length > 1) return { dir: null, how: 'ambiguous', candidates: prefixed };
    return { dir: null, how: 'none' };
  }

  if (!target) { console.error('用法: node session-tail.mjs <sessionId|会话目录> [--lines N] [--chars N] [--grep 文本] [--raw]'); process.exitCode = 2; }
  else {
    let file = target;
    // 【修·V3判据③ 2026-09-24】会话日志名世代化（0.1.5 起 `session.jsonl.zstd` → `session.v3.jsonl.zstd`）：
    //   定位一律走判据真源（认全世代 + 取"当前那份"），**禁写死文件名**。
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = pickSessionFileInDir(file);
    if (!file || !fs.existsSync(file)) {
      const id = target.replace(/^session-/, '');
      const hit = findSessionDir(id);
      if (!hit.dir) {
        console.error('找不到会话：' + target);
        console.error('  · 已按新旧两种文件名搜过：' + SESSION_FILE_NAMES.join(' / '));
        console.error('  · 实际搜索根目录：');
        for (const r of SEARCH_ROOTS) console.error('      ' + r);
        console.error('  · 会话目录名也试了两种形态：session-' + id + ' / ' + id);
        if (hit.how === 'ambiguous') {
          console.error('  · 该 id 前缀不唯一，命中多个会话目录（请给完整 id）：');
          for (const c of hit.candidates.slice(0, 10)) console.error('      ' + c);
        }
        process.exitCode = 1;
      } else {
        if (hit.how === 'prefix') console.error(`（按前缀唯一命中会话目录）${hit.dir}`);
        file = pickSessionFileInDir(hit.dir);
        if (!file) {
          console.error('找不到会话日志（' + SESSION_FILE_NAMES.join(' 或 ') + '）：' + hit.dir);
          console.error('  · 该会话目录下没有可识别的会话日志文件（判据真源 tools\\lib\\session-file-name.mjs）');
          process.exitCode = 1;
        }
      }
    }
    if (process.exitCode === 1) { /* 已报错，正常收尾 */ }
    else {
      const buf = fs.readFileSync(file);
      const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
      const starts = [];
      for (let i = 0; (i = buf.indexOf(MAGIC, i)) !== -1; i += 4) starts.push(i);
      const parts = [];
      for (let k = 0; k < starts.length; k++) {
        const s = starts[k], e = k + 1 < starts.length ? starts[k + 1] : buf.length;
        try { parts.push(zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8')); }
        catch (err) { parts.push(`\n[帧 ${k} 解压失败: ${String(err.message).slice(0, 80)}]\n`); }
      }
      const all = parts.join('').split(/\r?\n/).filter(Boolean);
      const say = (s) => console.log(redactOut(String(s)));
      say(`file      = ${file}`);
      say(`rawBytes  = ${buf.length}  帧数 = ${starts.length}  解压后行数 = ${all.length}`);
      const rows = grepPat ? all.filter((l) => l.includes(grepPat)) : all.slice(-linesN);
      say(`--- ${grepPat ? `匹配 "${grepPat}"（${rows.length} 行，末 ${linesN} 条）` : `末 ${linesN} 行摘要`} ---`);
      for (const ln of (grepPat ? rows.slice(-linesN) : rows)) {
        if (rawMode) { say('  ' + ln.replace(/\s+/g, ' ').slice(0, charsN)); continue; }
        let o = null;
        try { o = JSON.parse(ln); } catch { say('  [非 JSON] ' + ln.slice(0, charsN)); continue; }
        const bits = [];
        const ts = o.time ?? o.at ?? o.timestamp;
        if (ts) bits.push(new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false }));
        for (const k of ['type', 'kind', 'role', 'reason', 'status']) if (o[k] != null) bits.push(`${k}=${typeof o[k] === 'object' ? JSON.stringify(o[k]).slice(0, 80) : String(o[k]).slice(0, 60)}`);
        const body = o.data?.reason ?? o.data?.message ?? o.data?.text ?? o.text ?? o.content ?? '';
        bits.push((typeof body === 'string' ? body : JSON.stringify(body)).replace(/\s+/g, ' ').slice(0, charsN));
        console.log('  ' + bits.join(' | '));
      }
      process.exitCode = 0;
    }
  }
}
