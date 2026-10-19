#!/usr/bin/env node
// ============================================================================
// DSH / tools/dsh-session-mirror.mjs —— 会话与附件的「异地镜像」主轨（主机 A → mirror-host）
//
// 为什么需要（2026-09-20 主人拍板「主推 mirror-host，仓2 瘦身」）：
//   Gitee 仓2（免费私有仓 1 GB 配额）装不下会话全量 —— 实测日增 ~150 MB、2.7 天触线，
//   09-16 已因超配额被拒推一次。本脚本把 **会话（活跃 + 归档）+ 附件实体** 增量镜像到
//   mirror-host（7×24 常驻宿主，本地盘空闲 237 GB）；仓2 则瘦身为「近 3 天 + 关键小件」的轻量异地轨。
//
// 设计要点：
//   · 目标目录与生产**相对路径完全对齐**（sessions/…、_archived-sessions/…、attachments/…）
//     ⇒ 恢复时一条 robocopy 即可回灌，无需换算
//   · **只增不删**：远端永不 purge（防「本地误删被同步过去」）；本地也绝不删任何源文件
//   · 增量判据 = (size, mtimeMs) 变化；状态文件 ~/.dsh/butler-session-mirror.json
//   · **推送前空壳守卫（M3 · R4）**：源会话判空壳（AT2 三判据）**且**远端那份是完整版（更大）
//     ⇒ **拒绝覆盖 + 记账**（推送结果里给出 skipped 原因 + 状态文件 lastRun.shellGuard + 审计流水）。
//     判据**唯一来源** = `dsh-butler\lib\shell-session-watch.mjs`（与仓2 侧同源），本脚本不自造口径；
//     远端大小探测失败/未知 ⇒ 保守拒绝（宁可少覆盖、不可丢内容）。
//   · 传输 = 分批 tar + scp 一次往返（**不用 PowerShell 管道传二进制** —— PS 会把字节流当文本处理而损坏文件）
//   · 对端不可达 ⇒ 退出码 3（benign，供 tickd job 记 deferred、不刷红）
//
//   · **通道择路（2026-10-12 卡「镜像通道根治」）**：「**局域网优先 → VPS 中继隧道回落**」，
//     与 `tools\multi-host-status.mjs` / `tools\tuf-up.mjs` **同源同口径**。取值优先级（方案 §5.2 唯一口径）：
//     env `DSH_MIRROR_HOST`（**调试覆盖**）> 统一开关文件 `mirror.host`（**唯一权威源**）> 脚本默认。
//     通道候选 = ① host 原样（家里可解析 ⇒ 走局域网）② 由 `~/.ssh/config` **派生**的隧道别名
//     （判据 = 段 `HostName` 为环回地址、且 `HostKeyAlias`/段名 == 目标机器名，大小写不敏感）
//     ⇒ **本文件不写死任何具体别名或地址**；派生不到 ⇒ 只剩 ①（= 旧行为，不更坏）。
//     选定后**本轮锁定**（`HOST` 改为选中目标）⇒ 后续 scp / tar / ssh 全走同一条。
//
//   · **不可达要出声（2026-10-12 · 方案 §6.5-D8 选项①）**：连续不可达 ≥ N（默认 3）⇒ 调**既有**
//     `alert()` 通道（`~/.dsh/butler-alert.log` + stderr）出声一次；同一段断线每 12 轮最多再提醒一次；
//     **恢复即清记录**（⇒ 下次断线到阈还能再报）。🔴 **不动** `lib\tickd-health.mjs` 的取值口径（那是 D8 选项②）。
//
//   · **健康判据面（M4 · 2026-09-27）** —— 状态文件自写 + 连续不可达计数：
//       `~\.dsh\butler-session-mirror.json` 的 `lastResult`（ok / unreachable / partial / verify-failed）
//       + **`consecutiveUnreachable`**（不可达 ⇒ +1；可达 ⇒ 归零，含"无需传输"与"全被守卫拒绝"两路）。
//     ⚠️ **为什么必须自写**：本 job 走 `lockRunner` 包装层（`lib\tick-job-runner.mjs` L212 `exitCode = RUNNER_EXIT.OK`
//       起、L218 `await import()` 不抛即恒 OK，L267 `process.exitCode = await main()` 又把脚本自己设的
//       `process.exitCode = 3` **覆盖掉**）⇒ `~\.dsh\butler-tickd\state.json` 里 `session-mirror` 行的
//       `lastStatus` / `benignExits` / `consecutiveBenign` **健康语义已知失真**（2026-09-23 实测 runs=59、
//       `consecutiveBenign` 恒 0、`lastStatus` 恒 ok，而实际 `lastResult=unreachable`）——
//       **禁止**再拿 tickd state 那几项当本 job 的健康判据（§5.5 [N5] / §6 表1）。
//       **真源 = 本脚本写的状态文件**；读取方 = `dsh-butler\lib\tickd-health.mjs`（**同源**：默认路径与
//       env 覆盖口径两边一致，禁止一边读 tickd state、一边读 json）。
//   · 状态文件路径**可注入**：env `DSH_SESSION_MIRROR_STATE`（默认 `~\.dsh\butler-session-mirror.json`）。
//     用途 = 隔离 / 沙箱 e2e —— 本脚本只看 `USERPROFILE`、**不看 `DSH_HOME`** ⇒ 隔离实例里跑本脚本
//     默认仍会写**生产**状态文件（方案 §15.5 [N2] 点名的坑）。
//
// 用法：
//   node dsh-session-mirror.mjs [--dry-run] [--full] [--limit <n>] [--batch-mb <n>]
//        [--verify <n>] [--status] [--json] [--quiet]
//
//   node dsh-session-mirror.mjs --fetch <sid 或 glob> --to <dir> [--apply]
//        [--into-production --confirm-production=<sid>] [--allow-nonempty]
//     —— M1 · 阶段 0a「会话救援取回」（仓2 退役后的救命源）：按 sid / glob 从镜像取回会话到本地目录。
//        默认 dry-run（**一个字节都不写**、不建目录）；`--apply` 才写盘；同名文件永不覆盖。
//        **边界规则（黑名单 / 例外通道 / 三态 / 判定顺序 / 退出码）的唯一权威表述**
//        = 方案 §5.0a-1「M1 `--fetch` 边界规则判定表」（v6）：
//          <workspace>\docs\同步拓扑重构-仓2退役与mirror-host中枢-方案-20260923.md
//
//   环境变量覆盖（默认值即生产）：
//     DSH_MIRROR_HOST  主机写法（**调试覆盖**；缺省 = 读统一开关文件 `mirror.host`，再缺才用脚本默认
//                      mirror@example-host）—— 方案 §5.2 优先级：env > 开关文件 > 脚本默认
//     DSH_MIRROR_ROOT  镜像根（同上优先级；缺省 <mirror-root>/.dsh）
//     DSH_MIRROR_KEY   默认 ~\.ssh\id_ed25519_mirror
//     DSH_MIRROR_CHANNEL        '' | lan | tunnel —— **强制单通道**（调试/演练用；缺省 = lan 优先、隧道回落）
//     DSH_MIRROR_HOST_TUNNEL    隧道候选主机（调试覆盖；缺省 = 由 ~/.ssh/config 自动派生）
//     DSH_MIRROR_UNREACHABLE_ALERT_N      连续不可达出声阈值（默认 3 · 达阈出声一次）
//     DSH_MIRROR_UNREACHABLE_ALERT_EVERY  同一段断线的重报间隔（轮 · 默认 12 · 0 = 只报一次不重报）
//     DSH_SESSION_MIRROR_STATE  状态文件路径（M4 新增 · 默认 ~\.dsh\butler-session-mirror.json）
//                               —— 判据面读取方 `lib\tickd-health.mjs` **同源**读同一个 env
//     DSH_MIRROR_FETCH_CHANNEL  --fetch 取回通道：auto（默认，探测远端 tar）/ tar / scp
//                               （实现细节，非判定口径；供 e2e 强制走某条通道）
//
// 退出码：
//   镜像推送：0 完成 · 3 对端不可达（让路）· 1 失败 · 2 用法错
//   --fetch ：0 成功（dry-run 同码）· 1 取回过程失败（写盘/传输/盘满/无权限/远端读取）
//             2 用法错 · 3 对端不可达 / 让路（抢不到 session-mirror 锁）· 4 非空闸 fail-closed
//             5 黑名单 fail-closed · 6 例外通道材料不全 / <sid> 不匹配 · 7 远端未命中
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DSH_WORKSPACE } from './lib/workspace.mjs';

// M3 · 镜像侧「空壳不得覆盖完整版」守卫（R4）。
//   判据实现**唯一来源** = dsh-butler\lib\shell-session-watch.mjs（与仓2 侧同源，AT2 卡 8fd47fe1 定案）；
//   本守卫模块只做「候选筛选 + 薄封装 + 记账渲染」，不复制任何判据（复制 = 下次口径漂移的种子）。
import { guardShellOverwrite, renderShellGuardLines } from './lib/session-mirror-shell-guard.mjs';

// 【S3 · 跨机骨架第二柱】远端盘"取盘 / 判级 / 告警决策"的**唯一实现**（纯函数、零 IO）——
//   两处取样点（推送路径 + `--audit-remote`）共用它 ⇒ 结构上不允许出现第二份取盘逻辑（复审 §7.3-S3④）。
import {
  parseFreeBytes, levelOf, fmtGiB, decideRemoteSpaceAlerts, buildRemoteSpaceField,
} from './lib/remote-space.mjs';
// 统一开关文件**唯一读取器**（S1 交付）：阈值取 `remoteSpace`（§3.3）；缺配置 ⇒ fail-closed 内置默认 20/10 GiB（§5.2）。
import { readTopology, resolveRemoteSpace, resolveMirror } from './lib/sync-topology.mjs';
// 【R9 · 2026-10-14】「传输类 job 的通道自查 + 按需短租」**共用件**（判据不在此处复制）：
//   lan → tunnel 两条候选都探不通时，按需 `relay-cli enable + up`，收尾 `down`（**只关自己开的**）。
//   为什么需要：择路只解决"走哪条"，不解决"没人把隧道开起来" —— 本机在公司有线网（lan 不可达 +
//   隧道默认关）时，本脚本每轮必然让路（2026-10-14 实测：断链 28 小时 / consecutiveUnreachable=14）。
//   一键关回：`--no-tunnel-rent` ／ env `DSH_PEER_SHORT_RENT=off` ／ `node <workspace>\tools\peer-channel-cli.mjs off --apply`。
import { ensurePeerChannel, releasePeerChannel } from './lib/peer-channel.mjs';
// R-065 删除面三件套（2026-10-16 · 卡「V3机器锁14 · 批 A」接入）：
//   本脚本的**唯一本机删除口** = 下面的 `rmGuarded()`（第一道门就是 dry-run，随后过 `gateDestructive`）。
import { gateDestructive } from './lib/production-guard.mjs';

const HOME = process.env.USERPROFILE || os.homedir();
const DSH = path.join(HOME, '.dsh');
// 【M4 · N2①】状态文件路径**可注入**（隔离/沙箱 e2e 用；默认值 = 生产路径 ⇒ 日常行为一字不变）。
//   同名 env 由 `dsh-butler\lib\tickd-health.mjs` **同源**读取（两边一个口径，防"脚本写 A、判据读 B"）。
const STATE = process.env.DSH_SESSION_MIRROR_STATE || path.join(DSH, 'butler-session-mirror.json');
const TMP = path.join(os.tmpdir(), 'dsh-session-mirror');
const KEY = process.env.DSH_MIRROR_KEY || path.join(HOME, '.ssh', 'id_ed25519_mirror');
const HOST_DEFAULT = process.env.DSH_MIRROR_HOST || 'mirror@example-host';
const REMOTE_ROOT_DEFAULT = process.env.DSH_MIRROR_ROOT || path.join(os.homedir(), 'dsh-session-mirror', 'local', '.dsh');

// ---- 目标 host / root 的取值来源：env（调试覆盖）> 统一开关文件（**唯一权威源**）> 脚本默认 -----
//   ⚠️ 口径见文件头「通道择路」段；notices 攒起来、等 log() 可用后打印一次（顶层此刻 log 还没定义）。
const MIRROR_TGT = resolveMirrorTarget();
let HOST = MIRROR_TGT.host;          // ← 择路成功后会被**本轮锁定**为选中通道的目标（见 ensureChannel）
const REMOTE_ROOT = MIRROR_TGT.root;
let TGT_NOTICES_PRINTED = false;
/** 开关文件"读不到 / 缺字段"必须打印（方案 §5.2：怕的是"静默变行为"）。 */
function printMirrorTargetNotices() {
  if (TGT_NOTICES_PRINTED) return;
  TGT_NOTICES_PRINTED = true;
  for (const n of MIRROR_TGT.notices) log('  · ' + n);
}
/**
 * §5.2 取值：env > 开关文件 > 脚本默认（读取器与 `remoteSpace` 段**同一个** `readTopology` / `resolveMirror`）。
 * 缺文件 / 缺键 ⇒ fail-open 按脚本现值执行 + 打印（**不改变既有行为**）。
 */
function resolveMirrorTarget() {
  const notices = [];
  let t = { source: 'missing', ok: false, data: null, notices: [] };
  try { t = readTopology({ path: process.env.DSH_SYNC_TOPOLOGY || undefined }); }
  catch (e) { notices.push('同步拓扑开关文件读取异常 ⇒ 按脚本默认继续：' + (e?.message ?? e)); }
  for (const n of (t.notices ?? [])) notices.push(n);
  const m = resolveMirror(t);
  for (const n of (m.notices ?? [])) notices.push(n);
  const envHost = String(process.env.DSH_MIRROR_HOST ?? '').trim();
  const envRoot = String(process.env.DSH_MIRROR_ROOT ?? '').trim();
  return {
    host: envHost || m.host || HOST_DEFAULT,
    root: String(envRoot || m.root || REMOTE_ROOT_DEFAULT).replace(/\\/g, '/'),
    notices, source: t.source ?? 'missing',
  };
}
const SOURCES = ['sessions', '_archived-sessions', 'attachments'];

const USAGE = [
  'dsh-session-mirror —— 会话/附件异地镜像（主机 A → mirror-host，增量、只增不删）',
  '',
  '  node dsh-session-mirror.mjs [--dry-run] [--full] [--limit <n>] [--batch-mb <n>]',
  '       [--verify <n>] [--status] [--json] [--quiet]',
  '',
  '  node dsh-session-mirror.mjs --fetch <sid 或 glob> --to <dir> [--apply]',
  '       [--into-production --confirm-production=<sid>] [--allow-nonempty]',
  '       （M1 · 会话救援取回：默认 dry-run 一个字节都不写；--apply 才写盘；同名永不覆盖）',
  '  node dsh-session-mirror.mjs --audit-remote [--audit-limit <n>] [--out <dir|file>]',
  '       [--report-md <dir|file>] [--json]',
  '       （第一柱 · 远端清单核对：只读远端、只读本机状态文件、不写状态文件）',
  '',
  '  退出码：镜像推送 0 完成 | 3 对端不可达（让路）| 1 失败 | 2 用法错',
  '          --fetch  0 成功 | 1 取回过程失败 | 2 用法错 | 3 对端不可达 / 让路',
  '                   4 非空闸 | 5 黑名单 | 6 例外材料不全 / sid 不匹配 | 7 远端未命中',
  '',
  '  通道：lan 优先 → VPS 中继隧道回落（host 取自开关文件；env DSH_MIRROR_HOST 为调试覆盖）',
  '        —— 两条都不通时**按需短租**（relay-cli enable+up，收尾立刻 down）；--no-tunnel-rent 关回',
  '  出声：连续不可达 ≥ N（默认 3 · env DSH_MIRROR_UNREACHABLE_ALERT_N）轮 ⇒ 落 alert.log 一次',
].join('\n');

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
function arg(name, def = null) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
}
const OPT = {
  dryRun: argv.includes('--dry-run'),
  full: argv.includes('--full'),
  json: argv.includes('--json'),
  quiet: argv.includes('--quiet'),
  status: argv.includes('--status'),
  limit: Number(arg('--limit', 0)) || 0,
  batchMb: Number(arg('--batch-mb', 100)) || 100,
  verify: Number(arg('--verify', 0)) || 0,
};
// M1（--fetch）新增参数：--fetch / --to / --apply / --into-production / --confirm-production / --allow-nonempty
const KNOWN_ARGS = ['--dry-run', '--full', '--json', '--quiet', '--status', '--limit', '--batch-mb', '--verify',
  '--fetch', '--to', '--apply', '--into-production', '--confirm-production', '--allow-nonempty', '--help', '-h',
  '--audit-remote', '--audit-limit', '--out', '--report-md', '--no-tunnel-rent'];   // 末 5 项 = 第一柱（方案 §2.1）+ R9 短租关回
const argKeyOf = (a) => { const i = a.indexOf('='); return i >= 0 ? a.slice(0, i) : a; };
let badArgs = null;
for (const a of argv) {
  // ⚠️ 支持 `--confirm-production=<sid>` 内联取值形态（方案 §5.0a-1 表 M1-B 行 5–8 的写法）
  if (a.startsWith('--') && !KNOWN_ARGS.includes(a) && !KNOWN_ARGS.includes(argKeyOf(a))) { badArgs = a; break; }
}
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(USAGE + '\n');
  process.exitCode = 0;
} else if (badArgs) {
  process.stderr.write(`unknown arg: ${badArgs}\n${USAGE}\n`);
  process.exitCode = 2;
}

const OUT = { lines: [] };
const log = (m = '') => { OUT.lines.push(m); if (!OPT.quiet) process.stdout.write(m + '\n'); };
const MB = (n) => n / 1048576;

// ---------------------------------------------------------------- 工具
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 600_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return { ok: r.status === 0, code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
const sshBase = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', '-i', KEY];
// 【R9 · 夹具注入点】ssh 可执行文件 / 前置参数 —— **只供隔离演练**（缺省 = 系统 `ssh` ⇒ 生产行为一字不变）：
//   本卡的"断言脚本真的自己把隧道开起来"必须在**不碰生产隧道**的前提下做 ⇒ 演练时用假 ssh
//   （`node <夹具>\fake-ssh.mjs`）替换掉所有**会连网**的 ssh 调用（`ssh -G` 解析 config 那条**不替换**：只读本机文件、不连网）。
const SSH_EXE = String(process.env.DSH_MIRROR_SSH_EXE || 'ssh');
const SSH_PREFIX = process.env.DSH_MIRROR_SSH_PREFIX ? [String(process.env.DSH_MIRROR_SSH_PREFIX)] : [];
const sshRun = (args, opts = {}) => run(SSH_EXE, [...SSH_PREFIX, ...args], opts);

// ============================================================ 通道择路（局域网优先 → 隧道回落）
//
// 【为什么】旧版 host 只从 env / 脚本默认取，且两者都是**机器名**（该名字只在家里局域网可解析）
//   ⇒ 一离开家网，镜像目标就不可达（2026-10-12 实测静默断线 9 轮 / 约 9 小时）。
// 【怎么做】候选 = ① host 原样（在家 ⇒ 局域网直连）② 由 `~/.ssh/config` **派生**的隧道别名
//   （离网 ⇒ 回落 VPS 中继隧道）。派生判据**只认 ssh config 事实、不写死任何别名/地址**：
//   段 `HostName` 是环回地址 且（`HostKeyAlias` 或段名）与目标机器名大小写不敏感相等。
//   派生不到 ⇒ 只剩 ①（= 旧行为，不更坏）。
// 【调试抓手】`DSH_MIRROR_CHANNEL=lan|tunnel` 强制单通道（演练用）；`DSH_MIRROR_HOST_TUNNEL` 直接指定隧道候选。
const CHANNEL_PROBE_TIMEOUT_MS = 20_000;   // ssh 自身 ConnectTimeout=10 ⇒ 进程超时留 2×
const LOOPBACK_RE = /^(?:127(?:\.\d+){3}|localhost|::1)$/i;
let CHOSEN = null;                          // 本轮锁定的通道 {channel, target}
let RENT_LEASE = null;                      // 【R9】本轮"按需短租"的租约（非空 ⇒ 收尾要归还；**只关自己开的**）
const sshTarget = () => CHOSEN?.target ?? HOST;

/** 解析 `~/.ssh/config` 的 Host 段（**只读**；不处理 Include —— 本机 config 是单文件、无 Include）。 */
function readSshConfigHosts(file = path.join(HOME, '.ssh', 'config')) {
  const blocks = [];
  let cur = null;
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return blocks; }
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const h = /^Host\s+(.+)$/i.exec(line);
    if (h) { cur = { host: h[1].trim(), props: {} }; blocks.push(cur); continue; }
    const kv = /^(\S+)\s+(.+)$/.exec(line);
    if (kv && cur) cur.props[kv[1].toLowerCase()] = kv[2].trim();
  }
  return blocks;
}

/** `ssh -G <spec>` 解析出的真实机器名（= config 生效后的 HostName；取不到退回 spec 的字面 host 段）。 */
function sshResolvedHostName(spec) {
  const literal = String(spec).replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  const r = run('ssh', ['-G', spec], { timeout: 10_000 });
  const m = /^\s*hostname\s+(\S+)\s*$/im.exec(String(r.out ?? ''));
  return String(m ? m[1] : literal).trim().toLowerCase();
}

/** 隧道候选：ssh config 里"环回 + 与目标机器名匹配"的别名（找不到 ⇒ 不回落，返回 null）。 */
function tunnelCandidate(targetHost) {
  const env = String(process.env.DSH_MIRROR_HOST_TUNNEL ?? '').trim();
  if (env) return { channel: 'tunnel', target: env, via: 'env' };
  const name = sshResolvedHostName(targetHost);
  if (!name) return null;
  const literal = String(targetHost).replace(/^[^@]*@/, '');
  for (const b of readSshConfigHosts()) {
    const hn = String(b.props.hostname ?? '').trim();
    if (!LOOPBACK_RE.test(hn)) continue;                  // 隧道别名 = 指向本机端口转发的那些
    const alias = b.host.split(/\s+/)[0];
    const keyAlias = String(b.props.hostkeyalias ?? '').trim().toLowerCase();
    if (keyAlias === name || alias.toLowerCase() === name) {
      if (alias.toLowerCase() === literal.toLowerCase()) continue;   // 与目标同一串 ⇒ 不算"另一条通道"
      return { channel: 'tunnel', target: alias, via: 'ssh-config' };
    }
  }
  return null;
}

/** 通道候选（lan 优先）。`DSH_MIRROR_CHANNEL` 可强制单通道（调试/演练；缺省 = 两段式回落）。 */
function channelCandidates() {
  const lan = { channel: 'lan', target: HOST };
  const tun = tunnelCandidate(HOST);
  const force = String(process.env.DSH_MIRROR_CHANNEL ?? '').trim().toLowerCase();
  if (force === 'lan') return [lan];
  if (force === 'tunnel') return tun ? [tun] : [];
  return tun && tun.target !== lan.target ? [lan, tun] : [lan];
}

/**
 * 单个候选的探活（命令固定 `echo mirror-probe-ok` —— 推送主流程 / `--audit-remote` / `--fetch` 三处**同一判据**）。
 * 【R9】抽成函数是为了把它**注入**共用件 `ensurePeerChannel`（判据仍在本脚本，模块只负责"开的动作"）。
 */
function probeCandidate(c) {
  const r = sshRun([...sshBase, c.target, 'echo mirror-probe-ok'], { timeout: CHANNEL_PROBE_TIMEOUT_MS });
  return {
    ok: r.ok && String(r.out).includes('mirror-probe-ok'),
    err: String(r.err || r.out || ('rc=' + r.code)).split(/\r?\n/)[0].slice(0, 180),
  };
}

/**
 * 探活并**锁定本轮通道**（进程内只择一次）。返回 `{ok, channel, target, via, tried[], rented?, rent?}`。
 * ⚠️ 探活判据：lan → tunnel 依次试，全部失败 ⇒（R9）**按需短租** —— 调共用件 `ensurePeerChannel`
 *   （`tools/lib/peer-channel.mjs`：enable + up 后重试候选；租约记在 `RENT_LEASE`，由 `main()` 的
 *   `finally` 统一归还，**只关"本来 enabled=false、本次由我开起来"的那次**）。
 */
function ensureChannel() {
  if (CHOSEN) return { ok: true, channel: CHOSEN.channel, target: CHOSEN.target, via: CHOSEN.via ?? null, tried: [] };
  const cands = channelCandidates();
  if (!cands.length) return { ok: false, channel: null, target: HOST, via: null, tried: [] };
  // ⚠️ 演练语义：本轮"不写任何东西"时**绝不开隧道**（`--dry-run` 全程；`--fetch` 不带 `--apply` 也是 dry-run）
  const rentDryRun = OPT.dryRun || (FETCH.present && !FETCH.apply);
  // ⚠️ **只在显式关回时才传 `allowRent`**：缺省必须留给模块去读**总开关**（env / 开关文件）——
  //    传 `allowRent:true` 会把总开关整个绕过（2026-10-14 夹具演练 B5 实测踩到：一键关回失效）。
  const noRent = argv.includes('--no-tunnel-rent');
  const res = ensurePeerChannel({
    candidates: cands,
    probe: probeCandidate,
    owner: AUDIT.present ? 'mirror-audit' : (FETCH.present ? 'mirror-fetch' : 'session-mirror'),
    ...(noRent ? { allowRent: false } : {}),   // 单次关回（`--no-tunnel-rent`）
    dryRun: rentDryRun,
    log,
  });
  if (res.ok) {
    CHOSEN = { channel: res.channel, target: res.target, via: res.via ?? null };
    if (res.channel === 'tunnel') HOST = res.target;    // 锁定：后续 scp / tar / ssh 全走隧道
    RENT_LEASE = res.lease ?? null;
    return { ok: true, channel: res.channel, target: res.target, via: res.via ?? null, tried: res.tried, rented: res.rented, rent: res.rent ?? null };
  }
  return { ok: false, channel: null, target: HOST, via: null, tried: res.tried, rented: res.rented, rent: res.rent ?? null };
}

function ssh(remoteCmd, timeout = 120_000) {
  return sshRun([...sshBase, sshTarget(), remoteCmd], { timeout });
}

// ---- M3 · 远端那份的只读大小探测（供空壳守卫用；候选极少 ⇒ 每个最多 2 条 ssh）
//   返回 {ok, exists, bytes, error}：ok=false / bytes=null ⇒ 守卫侧按"探测失败/未知"**保守拒绝**。
//   ⚠️ 只读（`if exist` + `for %~zI`），不写远端任何东西。
function probeRemoteSessionSize(rel) {
  const win = `${REMOTE_ROOT.replace(/\//g, '\\')}\\${String(rel).replace(/\//g, '\\')}`;
  const ex = ssh(`if exist "${win}" echo mirror-guard-exists`, 60_000);
  if (!ex.ok) return { ok: false, exists: false, bytes: null, error: `存在性探测失败 rc=${ex.code}：${String(ex.err || ex.out).slice(0, 120)}` };
  if (!String(ex.out).includes('mirror-guard-exists')) return { ok: true, exists: false, bytes: null, error: null };
  const sz = ssh(`for %I in ("${win}") do @echo mirror-guard-size=%~zI`, 60_000);
  if (!sz.ok) return { ok: false, exists: true, bytes: null, error: `大小探测失败 rc=${sz.code}：${String(sz.err || sz.out).slice(0, 120)}` };
  const m = /mirror-guard-size=(\d+)/.exec(String(sz.out));
  if (!m) return { ok: true, exists: true, bytes: null, error: null };
  return { ok: true, exists: true, bytes: Number(m[1]), error: null };
}

function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    return j && typeof j === 'object' ? j : { schemaVersion: 1, files: {} };
  } catch {
    return { schemaVersion: 1, files: {} };
  }
}

// ============================================================ §4.5 单写口 · 核对报告合并
//
// 【S4 · 跨机骨架第三柱】方案真源 = `docs\方案-跨机骨架三柱与统一开关-20261010-v2.md` §4.5。
//
// 问题：核对 job（`--audit-remote`）本身**不写**状态文件（§2.6）；而推送 job 用
//   `writeStateAtomic` **整对象覆盖**同一份文件 ⇒ 若核对自己写 `#lastAudit`，就是"两写者、
//   两把锁、同一文件"⇒ 丢更新 / 账本键回退。
// 定死（v2.1 按源码事实）：核对只产报告（JSON + md）；`#lastAudit` / `remoteSpace` 由**推送 job
//   的下一轮**读"最新一份 `mirror-audit-*.json`"合并进本次 state，再一次性原子写。
//
// ⚠️ 位点铁律：合并是**唯一写口内部的第一步**（在 `writeStateAtomic()` 里），**不得**只挂在
//   "推送路径结尾"那一个出口 —— "本轮无待推文件"的静默轮（下面 main() 里那个 `!todo.length`
//   分支）在镜像安静期是常态（一天里大多数轮），挂在推送尾 = 那些轮**永不合并**，
//   且会误触发本方案自己新增的 8 天新鲜度判据（它读的正是 `#lastAudit.at`）。
// ⚠️ 只动 `lastAudit` / `remoteSpace` 两个键，**绝不碰 `files` 账本**（最坏后果 = 覆盖推送账本）。
// ⚠️ 幂等：候选 `asOf` **严格新于**现值才覆盖 ⇒ 重复执行结果一致。
// ⚠️ 失败一律吞掉：合并是附属步骤，绝不许阻断推送主流程（读不到 / 坏 JSON / 权限 ⇒ 跳过）。
//
// 🔴【S4 打回修正 · 2026-10-11 · round2】**读侧默认目录必须与写侧同一实体**。
//   旧写法默认落 `path.join(DSH, 'docs','管家报告')`，而本文件里 `DSH = ~\.dsh`
//   （= 会话源根，见 L77）⇒ 默认读的是 `<home>\.dsh\docs\管家报告`（**生产上不存在**）；
//   而写侧是 job（`butler-tickd.mjs` JOBS 的 mirror-audit 行）用 `--out` / `--report-md` 指的
//   `<workspace>\docs\管家报告`（由该文件 `const DSH = '<workspace>'`（L75）拼出）。
//   ⇒ 两侧不是同一目录 ⇒ `latestAuditReport()` 的 `readdirSync` 抛 ENOENT 被 catch 吞掉
//   ⇒ `mergeLatestAudit()` 恒返「无候选报告」⇒ **`#lastAudit` 在生产静默永不写入**（判据③⑤ 因此
//   被打回）。夹具之所以"通过"，是因为夹具用 env 把读写两侧都指到夹具目录 ⇒ 夹具自洽、生产不自洽。
//   ⇒ 口径：默认 = **与 tickd 的 `DSH` 同一个根**（本脚本既有的工具根字面量同族：下方 `DSH_ROOT_RAW`）。
//     ⚠️ 三处同源（`butler-tickd.mjs` 的 `const DSH` / 本文件 `DSH_ROOT_RAW` / 这里）——
//     改一处必须同批改三处；漏改由 `mainAuditRemote()` 开头的**写读同口径运行时自检**当场喊出来。
//   env `DSH_SESSION_MIRROR_AUDIT_DIR` 仍是**最高优先**的演练/隔离抓手（夹具用；与
//     `DSH_SESSION_MIRROR_STATE` 同族），语义不变。
const AUDIT_TOOL_ROOT = DSH_WORKSPACE;
const AUDIT_DEFAULT_REPORT_DIR = path.join(AUDIT_TOOL_ROOT, 'docs', '管家报告');
const AUDIT_REPORT_DIR = process.env.DSH_SESSION_MIRROR_AUDIT_DIR || AUDIT_DEFAULT_REPORT_DIR;
// 兼容旧默认目录：历史产物若落在 `~\.dsh\docs\管家报告`，仍能被读到（不留"旧报告读不到"
//   的静默坑）。仅当它**存在**且与主目录**不同**时才作第二候选（不存在 = 零成本跳过）。
const AUDIT_LEGACY_REPORT_DIR = path.join(DSH, 'docs', '管家报告');
const AUDIT_STALE_DAYS = 8;               // §4.3 新鲜度阈值：now - lastAudit.at > 8 天 ⇒ 🟡

/** 读侧候选目录（主 → 兼容旧目录；去重、只留真实存在的第二个）。 */
function auditReportDirs() {
  const dirs = [AUDIT_REPORT_DIR];
  try {
    if (path.resolve(AUDIT_LEGACY_REPORT_DIR).toLowerCase() !== path.resolve(AUDIT_REPORT_DIR).toLowerCase()
      && fs.existsSync(AUDIT_LEGACY_REPORT_DIR)) dirs.push(AUDIT_LEGACY_REPORT_DIR);
  } catch { /* 探测失败 ⇒ 只用主目录 */ }
  return dirs;
}

/** 目录里"最新一份"核对报告（按 `asOf` 取最新；读不动 / 坏件 / 缺 asOf 一律跳过）。
 *  【S4 打回修正】扫 `auditReportDirs()` 的**全部候选目录**（主目录 + 兼容旧目录），跨目录按 asOf 取最新。 */
function latestAuditReport() {
  let best = null;
  for (const dir of auditReportDirs()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }   // 该候选缺失/不可读 ⇒ 跳它，继续下一个
    for (const n of names) {
      if (!/^mirror-audit-.*\.json$/.test(n)) continue;
      const p = path.join(dir, n);
      let j = null;
      try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
      if (!j || typeof j !== 'object' || typeof j.asOf !== 'string' || !j.asOf) continue;
      if (!best || String(j.asOf) > String(best.asOf)) { best = j; best.__path = p; }   // ISO 字典序 == 时间序
    }
  }
  return best;
}

/**
 * 把"比 `#lastAudit.at` 更新的那份核对报告"合并进 state（就地改 `obj`）。
 * @returns {{merged:boolean, at?:string, why?:string}}
 */
function mergeLatestAudit(obj) {
  try {
    if (!obj || typeof obj !== 'object') return { merged: false, why: 'state 非法' };
    const r = latestAuditReport();
    if (!r) return { merged: false, why: '无候选报告' };
    const cur = obj.lastAudit && typeof obj.lastAudit === 'object' ? String(obj.lastAudit.at ?? '') : '';
    if (cur && String(r.asOf) <= cur) return { merged: false, why: '候选不比现值新（幂等跳过）' };
    const mdPath = String(r.__path).replace(/\.json$/, '.md');
    obj.lastAudit = {
      at: r.asOf,
      counts: r.counts ?? null,
      remoteSpace: r.remoteSpace ?? null,
      alerts: Array.isArray(r.alerts) ? r.alerts : [],
      degraded: r.degraded ?? null,
      reportPath: r.__path,
      reportMdPath: fs.existsSync(mdPath) ? mdPath : null,
      invokedBy: r.invokedBy ?? null,
    };
    // remoteSpace 同批落（§4.4：面板/日报不必再 ssh）；报告里取不到时保留现值，绝不清空
    if (r.remoteSpace && typeof r.remoteSpace === 'object') obj.remoteSpace = r.remoteSpace;
    else if (!obj.remoteSpace) obj.remoteSpace = null;
    return { merged: true, at: r.asOf };
  } catch (e) {
    return { merged: false, why: String(e?.message ?? e) };
  }
}

/** §4.3/§4.4 新鲜度读数（**只读** state；首跑 = 无记录，不得渲染成 ✅）。 */
function auditFreshness() {
  let at = null;
  try { const s = readState(); at = s?.lastAudit?.at ?? null; } catch { at = null; }
  if (!at) return { known: false, at: null, days: null, stale: false, text: '上次核对：无记录（首跑）' };
  const t = Date.parse(String(at));
  if (!Number.isFinite(t)) return { known: false, at, days: null, stale: false, text: '上次核对：' + at + '（时间戳不可解析 ⇒ 按未知处理）' };
  const days = (Date.now() - t) / 86_400_000;
  const stale = days > AUDIT_STALE_DAYS;
  return {
    known: true, at, days, stale,
    text: '上次核对：' + at + '（距今 ' + days.toFixed(1) + ' 天）'
      + (stale ? ' 🟡 超过 ' + AUDIT_STALE_DAYS + ' 天阈值 —— 可能 job 被关 / 报告写不出去 / 对端长期不可达' : ''),
  };
}

function writeStateAtomic(obj) {
  // 【S4 §4.5】唯一写口的第一道内部步骤：合并最新的核对报告（幂等；失败静默、绝不阻断推送）
  const mg = mergeLatestAudit(obj);
  if (mg.merged) log(`  ↳ 已合并核对报告进状态文件（#lastAudit.at=${mg.at}）`);
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, STATE);
}

// ============================================================ §3 第二柱 · 远端盘阈值 + 告警
//
// 【S3 · 跨机骨架第二柱】方案真源 = `docs\方案-跨机骨架三柱与统一开关-20261010-v2.md` §3
//   （§3.2 两处取样 + 解析判据 · §3.3 阈值存统一开关文件 · §3.4 告警走既有通道 + 去重/冷却）。
// 🔴 卡面约束（复审 §7.3 的 S3 行）：② **未新增任何推送面**（只有 `alert()` + 状态文件字段 + 本段取盘）
//   ③ 解析只依赖括号数值 ④ 与 S2 取样点**去重** ⇒ 本文件只做"调 ssh + 落字段 + 调 alert()"，
//   判定与解析一律调 `lib\remote-space.mjs`（唯一判据来源，可白盒单测）。
//
// 两处取样点（§3.2）：
//   ① 推送路径（有推送的轮）—— 既有位置，由"只 log 一个字符串"升级为结构化 + 判 level + 阈值告警；
//   ② `--audit-remote` 内**必取一次**（不管有没有待推文件）⇒ 周核对保证每周至少 1 个读数。
//
// ⚠️ 与 S2 的关系（复审 §7.3-S3④ 要求写清）：S2 在 `--audit-remote` 里内联过一段取盘 + 临时阈值
//   （`<10 GiB=low / <50 GiB=warn`）；本卡把那段**整段删掉**、两处取样点改为共用 `sampleRemoteSpace()`。
//   ⇒ 全库只剩**一份** fsutil 解析与一份阈值判定（`remote-space.mjs`），不会出现"两套判据各自掩护"。

/** §3.3：阈值来源 = 统一开关文件（唯一权威源）；缺配置 ⇒ fail-closed 到内置默认（20/10 GiB）+ 打印。 */
function remoteSpaceConfig(volume) {
  let t = { ok: false, source: 'missing', data: null };
  try {
    // env 抓手 `DSH_SYNC_TOPOLOGY` 与 `DSH_SESSION_MIRROR_STATE` 同族：**演习/关回演练**用，
    //   生产缺省 = 真实开关文件（`~/.dsh/butler-sync-topology.json`，路径由读取器写死）。
    t = readTopology({ path: process.env.DSH_SYNC_TOPOLOGY || undefined });
  } catch (e) {
    log('  ⚠️ 同步拓扑开关文件读取异常（按内置默认阈值继续）：' + (e?.message ?? e));
  }
  const rs = resolveRemoteSpace(t);
  for (const n of rs.notices) log('  · ' + n);   // §5.2：读不到 / 缺配置**必须打印**（怕的是"静默变行为"）
  const norm = (v) => String(v ?? '').replace(/:$/, '').toUpperCase();
  const target = rs.targets.find((x) => norm(x.volume) === norm(volume)) || rs.targets[0];
  return {
    enabled: rs.enabled, fallback: rs.fallback, source: t.source ?? 'missing',
    volume: target.volume, warnFreeBytes: target.warnFreeBytes, alertFreeBytes: target.alertFreeBytes,
  };
}

/**
 * **唯一一份**取盘逻辑：一次 ssh 读 `fsutil` → 解析（括号数值定行）→ 判 level → 出告警决策 → 组状态字段。
 * @param {string} volume 卷（如 `D:`）
 * @param {{prev: object|null, now: number}} o `prev` = 上一轮 `remoteSpace` 字段（首跑传 null）
 * @returns {{cfg:object, field:object, decision:object, sshOk:boolean}}
 */
function sampleRemoteSpace(volume, o = {}) {
  const cfg = remoteSpaceConfig(volume);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const sp = ssh('fsutil volume diskfree ' + volume, AUDIT_SSH_TIMEOUT_MS);   // 只读查询；无 CIM / 无 PS / 无管道
  const freeBytes = sp.ok ? parseFreeBytes(sp.out) : null;                    // 取不到 ⇒ null ⇒ level=unknown
  const level = levelOf(freeBytes, cfg);
  const decision = decideRemoteSpaceAlerts({
    prev: o.prev ?? null, next: level, now, enabled: cfg.enabled, volume,
    freeBytes, warnFreeBytes: cfg.warnFreeBytes, alertFreeBytes: cfg.alertFreeBytes,
  });
  const field = buildRemoteSpaceField({
    volume, freeBytes, level, checkedAt: new Date(now).toISOString(),
    unknownStreak: decision.unknownStreak, enabled: cfg.enabled,
    warnFreeBytes: cfg.warnFreeBytes, alertFreeBytes: cfg.alertFreeBytes,
  });
  return { cfg, field, decision, sshOk: !!sp.ok };
}

/** §3.4 通道①（**唯一新增的对外调用**）：把决策出的那一条落 `alert.log` + stderr；失败绝不阻断主流程。 */
async function emitSpaceAlert(escalate) {
  if (!escalate) return;
  try {
    const { alert } = await import('./lib/alert.mjs');
    // 显式传 home=DSH（= USERPROFILE/.dsh）⇒ 隔离夹具下自动落到夹具，**不污染生产 alert.log**
    alert({ level: escalate.level, source: 'session-mirror', message: escalate.message, detail: { code: escalate.code } },
      { home: DSH, silent: true });
    log('  ⚠️ 远端盘告警已落 alert.log：' + escalate.message);
  } catch (e) {
    log('  ⚠️ 远端盘告警写入 alert.log 失败（**不改变退出码**；一级可见面仍是周报 md）：' + (e?.message ?? e));
  }
}

// ---- 【M4】连续不可达计数（**判据面真源** · 语义只写在这里；读取方 tickd-health 只消费、不复算）
//   不可达 ⇒ +1；可达 ⇒ 归零（可达 = 除"探活失败"外的**全部**结局：无需传输 / 已推送 / 批失败 partial /
//   全被空壳守卫拒绝 / verify-failed —— 这些都证明"对端是通的"）。
//   ⚠️ 判据**只用** consecutiveUnreachable；lastUnreachableAt 是给人看的辅助信息（供日报说"最后一次不可达在何时"），
//   不得拿它当阈值判据（时间戳口径会随轮次间移动，作判据会产生"陈旧不可达"的假红）。
const UNREACHABLE_KEY = 'consecutiveUnreachable';
const LAST_UNREACHABLE_AT_KEY = 'lastUnreachableAt';

// ---- 【B 段】"断线要出声"（2026-10-12 · 方案 §6.5-D8 **选项①**）-------------------------------
//   口径见文件头；🔴 只写**同一个** state 对象（由唯一写口 `writeStateAtomic` 落盘）⇒ **不新增写者**。
const UNREACHABLE_ALERT_KEY = 'unreachableAlert';
const numEnv = (name, def, min) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min ? Math.floor(v) : def;
};
/** 出声阈值（连续不可达轮数 ≥ 该值 ⇒ 出声一次）。可配：env `DSH_MIRROR_UNREACHABLE_ALERT_N`。 */
const ALERT_N = numEnv('DSH_MIRROR_UNREACHABLE_ALERT_N', 3, 1);
/** 同一段断线的重报间隔（轮；0 = 只报一次）。可配：env `DSH_MIRROR_UNREACHABLE_ALERT_EVERY`。 */
const ALERT_EVERY = numEnv('DSH_MIRROR_UNREACHABLE_ALERT_EVERY', 12, 0);

/** 本轮对端不可达 ⇒ 计数 +1（脏值 / 缺字段按 0 起算，绝不产生 NaN）。返回新计数。 */
function bumpUnreachable(state, at = new Date().toISOString()) {
  const prev = Number(state?.[UNREACHABLE_KEY]);
  const base = Number.isFinite(prev) && prev > 0 ? Math.floor(prev) : 0;
  state[UNREACHABLE_KEY] = base + 1;
  state[LAST_UNREACHABLE_AT_KEY] = at;
  return state[UNREACHABLE_KEY];
}

/** 本轮对端可达 ⇒ 计数归零（**保留** lastUnreachableAt 作历史痕迹）+ 清"已出声"记录（⇒ 下次断线到阈还能再报）。 */
function clearUnreachable(state) {
  state[UNREACHABLE_KEY] = 0;
  if (state[UNREACHABLE_ALERT_KEY]) delete state[UNREACHABLE_ALERT_KEY];
  return 0;
}

/**
 * 【卡·通道根治】把本轮通道落进 state（**所有"可达"出口**共用 —— 出口有多个：
 * 无需传输 / 全被守卫拒绝 / 推送尾）：漏记会让"这轮走的哪条路"无从取证（演练当场抓到过一次）。
 */
function markChannel(state) {
  state.channel = CHOSEN?.channel ?? null;
  state.channelVia = CHOSEN?.via ?? null;
}

/**
 * 【B 段】连续不可达达阈 ⇒ 出声一次（返回：是否真写进 alert.log）。
 * 纯内存改 `state`（落盘交给调用方**既有的唯一写口** `writeStateAtomic` —— §4.5 单写口约束）。
 * @param {object} state 本轮 state（必须是传给 writeStateAtomic 的**同一个对象**）
 * @param {number} n 本轮 bump 之后的连续不可达轮数
 * @param {Array<{channel:string,target:string,err:string}>} tried 本轮试过的通道（只把**通道名**写进 detail，不写地址）
 */
async function checkUnreachableAlert(state, n, tried = []) {
  if (!Number.isFinite(n) || n < ALERT_N) return false;
  const prev = state[UNREACHABLE_ALERT_KEY];
  const lastStreak = Number(prev?.streakAtAlert);
  if (Number.isFinite(lastStreak) && ALERT_EVERY > 0 && n - lastStreak < ALERT_EVERY) return false;   // 降噪：同一段断线不刷屏
  if (OPT.dryRun) return false;                       // 与"dry-run 不记账"同口径：不落盘 ⇒ 不出声
  const message = `会话异地镜像：对端连续 ${n} 轮不可达（阈值 ${ALERT_N}）⇒ 镜像停摆`
    + `（判据真源 butler-session-mirror.json#${UNREACHABLE_KEY}）`;
  let ok = false;
  try {
    const { alert } = await import('./lib/alert.mjs');
    // 显式传 home=DSH（= USERPROFILE/.dsh）⇒ 隔离夹具下自动落到夹具、**不污染生产 alert.log**（同远端盘告警口径）
    const r = alert({ level: 'warn', source: 'session-mirror', message,
      detail: { consecutiveUnreachable: n, threshold: ALERT_N, channelsTried: tried.map((t) => t.channel) } },
      { home: DSH, silent: true });
    ok = r?.ok === true;
  } catch (e) {
    log('  ⚠️ 不可达告警写入 alert.log 失败（不改变退出码）：' + (e?.message ?? e));
  }
  // 写失败 ⇒ **不记 streak**（下轮还会重试，避免"无声地哑掉"）；写成功 ⇒ 记 streak 供降噪判据
  state[UNREACHABLE_ALERT_KEY] = ok
    ? { at: new Date().toISOString(), streakAtAlert: n, threshold: ALERT_N, count: Number(prev?.count ?? 0) + 1 }
    : { at: new Date().toISOString(), failed: true, count: Number(prev?.count ?? 0) + 1 };
  log(`  🔊 已出声（既有 alert 通道 · source=session-mirror）：连续不可达 ${n} 轮 ≥ 阈值 ${ALERT_N}`
    + (ok ? '' : '｜⚠️ 但写 alert.log 失败，见上'));
  return ok;
}

/** 递归列出文件（相对 DSH 根、正斜杠分隔） */
function scan() {
  const out = [];
  const stack = [];
  for (const s of SOURCES) {
    const root = path.join(DSH, s);
    if (fs.existsSync(root)) stack.push({ root, dir: root });
  }
  while (stack.length) {
    const { root, dir } = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push({ root, dir: p }); continue; }
      if (!e.isFile()) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      out.push({
        rel: path.relative(DSH, p).split(path.sep).join('/'),
        abs: p,
        size: st.size,
        mtimeMs: Math.floor(st.mtimeMs),
      });
    }
  }
  return out;
}

function sha16(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

// ============================================================ --fetch（M1 · 阶段 0a 救命源）
//
// 边界规则的**唯一权威表述** = 方案 §5.0a-1「M1 `--fetch` 边界规则判定表」（v6）：
//   <workspace>\docs\同步拓扑重构-仓2退役与mirror-host中枢-方案-20260923.md
//
// 判定顺序（写死 · 短路式）：
//   用法校验(2) → 例外通道材料校验(6) → 黑名单(5) → 三态(4 / 写) → 对端可达性(3) → 远端命中(7) → 写盘 / dry-run(0)
//   **前一闸短路后，后续闸一律"不评估"。**
// 终值转判：本地闸（前四闸）阶段值 ≠ 0 ⇒ 该值即终值；阶段值 = 0 ⇒ 终值 = 可达 3 / 远端未命中 7 / 成功 0。
// 运行期失败（写盘失败 / 传输中断 / 盘满 / 无权限 / 远端读取失败）⇒ exit 1；半截件**不回滚**。
//
// ⚠️ 本段必须与「方案 §5.0a-1 判定表」「M1 卡面」**三处一致** —— 改这里必须同批核那两处。

const TOOLS_DIR = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));   // realpath 后再拼（junction 防双拼）
const DSH_ROOT_RAW = DSH_WORKSPACE;

/** 注 f：L3 核心启动链「文件级清单 26 项」（与 `<workspace>\tools\dsh-wrapup.ps1` 的 `$allowedFiles` 同步维护） */
const L3_CLIST = [
  'dsh-desktop.cmd', 'dsh-desktop.ps1', 'dsh-guard-ctl.ps1', 'dsh-guard.cmd', 'dsh-guard.ps1', 'dsh-plugin.cmd',
  'dsh-restart.cmd', 'dsh-restart.ps1', 'dsh-see-image.ps1', 'dsh-shutdown.cmd', 'dsh-shutdown.ps1', 'dsh-start.cmd',
  'dsh-start.ps1', 'fix-workspace-local.mjs', 'guard-core.mjs', 'guard-ctl.mjs', 'guard-http.mjs', 'guard-launcher.mjs',
  'guard-switch.mjs', 'guard.mjs', 'knowledge.mjs', 'l2-actions.mjs', 'llm-client.mjs', 'migrate-session-cwd.mjs',
  'repair-ctl.mjs', 'repair.mjs',
];
/** 注 f：通配族 —— 仅 `<workspace>` 根下**一层**、**不递归**（根下新增同族文件自动入列） */
const L3_GLOBS = [/^dsh-.*\.(cmd|ps1)$/, /^guard.*\.mjs$/, /^repair.*\.mjs$/];
/** 注 h：`--to` 是目录路径、**一律不得含 glob 元字符** ⇒ 违反 = 表 M1-B 行 26（exit 2） */
const GLOB_META = /[*?[\]]/;

const FETCH_LOCK_NAME = 'session-mirror';        // 注 j：与 tickd 的 session-mirror job 共用同一把锁
const FETCH_LOCK_TTL_MS = 30 * 60 * 1000;        // 注 j：lockRunner ttl 1800000
const SCP_CONNECT_TIMEOUT_S = 10;                // 注 k：scp 连接超时 10 s
const SPAWN_TIMEOUT_MS = 600_000;                // 注 k：单文件传输 / 远端读取 spawnSync timeout = 10 min
const REMOTE_TMP_SUBDIR = '_tmp';

/** 取值（支持 `--name value` 与 `--name=value` 两种形态） */
function optRaw(name) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === name) return { found: true, value: argv[i + 1] ?? null };
    if (a.startsWith(name + '=')) return { found: true, value: a.slice(name.length + 1) };
  }
  return { found: false, value: null };
}
const _fSpec = optRaw('--fetch');
const _fTo = optRaw('--to');
const _fConfirm = optRaw('--confirm-production');
const FETCH = {
  present: _fSpec.found,
  spec: _fSpec.value,
  to: _fTo.value,
  confirmProduction: _fConfirm.value,
  apply: argv.includes('--apply'),
  intoProduction: argv.includes('--into-production'),
  allowNonempty: argv.includes('--allow-nonempty'),
};

// ---- 归一化与判定（注 a：禁列各项与 `--to` 必须**同源归一** —— 同取 `HOME`/`USERPROFILE`）--------
/** 实际文件操作用的绝对路径（保留原大小写） */
function absPath(p) {
  let s = String(p ?? '').trim();
  s = s.replace(/^~(?=[\\/]|$)/, HOME);
  s = s.replace(/%USERPROFILE%/gi, HOME);
  return path.resolve(s);
}
/** 判定用的归一化路径（展开 `~` / `~`、分隔符与去尾分隔符、Windows 语义大小写不敏感、不做 glob 展开） */
function normPath(p) {
  let s = String(p ?? '').trim();
  s = s.replace(/^~(?=[\\/]|$)/, HOME);
  s = s.replace(/%USERPROFILE%/gi, HOME);
  s = s.replace(/\//g, '\\');
  if (!/^[a-z]:\\/i.test(s) && !/^\\\\/.test(s)) s = path.resolve(s).replace(/\//g, '\\');
  s = s.replace(/\\+$/, '');
  return s.toLowerCase();
}
const isDriveRoot = (n) => /^[a-z]:$/.test(n);
function isAncestorOf(a, b) {
  const A = normPath(a), B = normPath(b);
  if (A === B) return false;
  if (isDriveRoot(A)) return /^[a-z]:/.test(B) && B.startsWith(A + '\\');
  return B.startsWith(A + '\\');
}
/** L3 · 核心启动链（v5 起移出例外层）：清单项 / 通配族自身等于；或是其父目录（`<workspace>` 根 ⇒ 同时命中 L1） */
function l3Hit(n) {
  const D = normPath(DSH_ROOT_RAW);
  if (n === D) return true;
  const name = n.split('\\').pop();
  const parent = n.slice(0, n.length - name.length - 1);
  if (parent !== D) return false;                      // 仅 `<workspace>` 根下**一层**（注 f：不递归）
  return L3_CLIST.includes(name) || L3_GLOBS.some((r) => r.test(name));
}
function l2List() {
  return ['sessions', '_archived-sessions', 'attachments', 'profiles'].map((s) => normPath(path.join(DSH, s)));
}
/** L2 · 生产目录（可作例外目标）：自身等于 / 位于其下（后代，含间接）/ 是父目录（该情形已被 L1 覆盖） */
function l2Hit(n) { return l2List().some((x) => x === n || isAncestorOf(x, n)); }
/** L1 · 上位目录（永不可作目标）：自身等于 / 是禁列某项的父目录（含间接祖先）/ 位于其下（**仅 `~\.dsh` 与 `<workspace>` 根两项**） */
function l1Hit(n) {
  const selfs = [normPath(DSH), normPath(HOME), normPath(DSH_ROOT_RAW)];
  if (selfs.some((x) => x === n)) return true;
  if (isDriveRoot(n)) return true;
  if (selfs.some((x) => isAncestorOf(n, x))) return true;
  if ([normPath(DSH), normPath(DSH_ROOT_RAW)].some((x) => isAncestorOf(x, n))) return true;   // 注 b
  return false;
}
/** 层优先级（v6 写死）：L3（核心启动链）→ L2（生产目录）→ L1（上位目录）→ L0（不命中） */
function layerOf(p) { const n = normPath(p); return l3Hit(n) ? 'L3' : l2Hit(n) ? 'L2' : l1Hit(n) ? 'L1' : 'L0'; }
/** 合法 DSH 会话目录名（sid 叶子）的**名字判据**（M1-R1 · 2026-09-27 修正）：
 *  · 真实形态 = `session-<uuid>`（8-4-4-4-12 小写十六进制 · **含连字符**）—— 本机只读实测：
 *    活跃树 `sessions\<工作段>\` 下 **49/49** 全为此形态；归档树 `_archived-sessions\` 下 **1181** 个（旧批次直挂）
 *    + **40** 个（`cards\<批次>\` 下）。
 *  · **保留** v5 起的两代形态（`session-<hex≥6>` / `<hex≥8>`）以免回归（e2e A4 / H / K / N 用例即人造无连字符名）。
 *  · ⚠️ 仍**不得**放宽到"任意目录名"：`sub` / `node_modules` / `workspace` 一律不命中 ⇒ 多层级后代
 *    仍由 `except4()` 的 `parts.length <= 2` 拦下（表 M1-B 行 22 ⇒ exit 5）。
 *  ⚠️ 与 `tools\lib\session-file-name.mjs` 的关系：那个模块是**会话日志文件名**（`session*.jsonl.zstd`）的单一真源，
 *    **不含目录名判据** ⇒ 无同源可 import（本判据独立；不复制任何别的模块的私有正则）。
 *  ⚠️ 大小写：`except4()` 入参已 `normPath()`（小写）；此处仍带 `i`，免调用方变化时静默失配。
 *  ⚠️ **未覆盖（如实登记 · 待拍板）**：旧归档形态的**裸 uuid** 目录名（`_archived-sessions\<批次>\<uuid>`，
 *    实测 **188 个**（`_archived-sessions\<批次>\<uuid>` 形态的旧归档目录；同层另有 13 个 `session-permverify-*` 夹具名
 *    与归档批次目录名，二者本就不属 sid 叶子）—— 本卡只认 `session-<uuid>`；是否纳入见交付报告"待拍板"。 */
const SID_LEAF_RE = /^(?:session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|session-[0-9a-f]{6,}|[0-9a-f]{8,})$/i;

// ---------------------------------------------------------------- 第一柱 · 远端清单核对（--audit-remote）
//   真源 = docs\方案-跨机骨架三柱与统一开关-20261010-v2.md §2（L175 起，逐条照抄，禁自造口径）
//
//   §2.1 参数面：--audit-remote / --audit-limit <n>（默认 50）/ --out <dir|file> / --report-md <dir|file>
//   §2.2 取远端清单：一次 ssh + 远端 node 只读遍历输出 TSV；remoteCmd 必须是**一个 argv 元素**、
//        内部双引号包脚本、**脚本内只用单引号**；禁 CIM/wmic；禁管道 |；默认 shell = cmd.exe；
//        超时 60 s；**禁硬编码远端根**（由 REMOTE_ROOT 推导）；_tmp/ 前缀条目一律剔除
//   §2.3 三源（A 本机生产集 scan() / B 本机登记集 state.files / C 远端实测集）→ 三类结论
//        missing（唯一影响 rc / 判据 rel∈B 且 rel∈A 且 rel∉C）/ extra（rel∈C 且 rel∉B）
//        / orphan（rel∈B 且 rel∉A）/ neverMirrored（rel∈A 且 rel∉B，只计数）
//   §2.4 输出：默认人读；--json 沿用「文本流末尾追加 ---JSON--- 再出 JSON」（非纯 JSON）；
//        --out 落盘原子写、同日重跑同名覆盖；--report-md 与 JSON **同一份内存数据**渲染
//        invokedBy（R1-4）= cli / cli:--out / tickd:<jobId> / cli:<参数摘要>
//   §2.5 退出码：0 missing=0 · 1 missing>0 · 2 用法错 · 3 对端不可达(让路)
//        · 4 远端清单不可解析/明显截断 · 5 本机状态文件缺失/损坏(fail-closed)
//   §2.6 边界：只读远端；**本机侧不写状态文件**（R2-2：只读 butler-session-mirror.json）；
//        lastAudit / remoteSpace 由**单写口**写（§4.5）⇒ 本模式**不写**它；
//        唯一本机可能写 = ssh 首连陌生主机追加 ~/.ssh/known_hosts（诚实写明 R2-8）；
//        _tmp 剔除；timeout 60 s 超时不重试 ⇒ rc 3；DSH_SESSION_MIRROR_STATE 可注入（隔离抓手）
//
//   ⚠️ 审计只读探针（orphan 新增/存量）路径**独立于状态文件**（状态文件严禁被本模式写）：
//      默认 ~\.dsh\butler-session-mirror-audit.json
//      env DSH_SESSION_MIRROR_AUDIT_STATE 可注入（缺省路径按开/关两态推导，与 DSH_SESSION_MIRROR_STATE 同族）
const AUDIT_STATE = process.env.DSH_SESSION_MIRROR_AUDIT_STATE
  || (process.env.DSH_SESSION_MIRROR_STATE
    ? process.env.DSH_SESSION_MIRROR_STATE + '.audit.json'
    : path.join(DSH, 'butler-session-mirror-audit.json'));
const AUDIT_ORPHAN_HARD_LIMIT = 10;   // §2.4 止噪：orphan 明细最多 10 条（--audit-limit 对 orphan 不生效）
const AUDIT_SSH_TIMEOUT_MS = 60_000;  // §2.2：实测冷 6.1 s，富余 ~10×
const AUDIT_TMP_PREFIX = '_tmp/';     // §2.2：_tmp/ 前缀条目一律剔除
const AUDIT_EXTRA_DETAIL_LIMIT = 200; // §2.4：extra 明细列条数上限（人读面别爆行）

const _aRemote = optRaw('--audit-remote');
const _aLimit = optRaw('--audit-limit');
const _aOut = optRaw('--out');
const _aReportMd = optRaw('--report-md');
const AUDIT = {
  present: _aRemote.found,
  limit: Math.max(1, Math.min(10_000, Math.floor(Number(_aLimit.value ?? 50)) || 50)),
  out: _aOut.value,
  reportMd: _aReportMd.value,
};

/** §2.4：invokedBy（R1-4）—— cli（裸跑）/ cli:--out / tickd:<jobId> / cli:<参数摘要> */
function auditInvokedBy() {
  const job = process.env.DSH_JOB_ID;
  if (job) return 'tickd:' + job;
  if (AUDIT.out || AUDIT.reportMd) return 'cli:--out';
  if (argv.includes('--json') || argv.includes('--quiet') || AUDIT.limit !== 50) {
    return ('cli:' + argv.filter((a) => a !== '--audit-remote').join(' ')).trim();
  }
  return 'cli';
}
const pad2 = (n) => String(n).padStart(2, '0');
function auditDateStamp(d = new Date()) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
/** --out / --report-md 的落点解析（§2.4：传目录则按 <dir>\mirror-audit-<YYYY-MM-DD>.<ext>） */
function auditDestPath(spec, ext) {
  const abs = absPath(spec);
  return isDirSpec(spec) ? path.join(abs, 'mirror-audit-' + auditDateStamp() + '.' + ext) : abs;
}
/** 该 spec 是否被当作**目录**（§2.4 判据的唯一实现；auditDestPath / auditDestDir 共用，防两份语义漂移）。 */
function isDirSpec(spec) {
  const abs = absPath(spec);
  try {
    if (fs.existsSync(abs)) return fs.statSync(abs).isDirectory();
  } catch { return false; }
  return /[\\/]$/.test(String(spec));     // 目录尚不存在 ⇒ 按结尾斜杠判定（与旧行为逐字等价）
}
/** 【S4 打回修正 · round2】落点所在**目录**（写读同口径自检用）。 */
function auditDestDir(spec) {
  const abs = absPath(spec);
  return isDirSpec(spec) ? abs : path.dirname(abs);
}
/** 原子写（.tmp + rename；§2.4）。⚠️ Windows 下 rename 到已存在文件会 EPERM ⇒ 先删目标后重试一次。 */
function writeTextAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  try { fs.renameSync(tmp, file); }
  catch {
    try { fs.rmSync(file, { force: true }); } catch { }
    fs.renameSync(tmp, file);
  }
}
/** 严格读状态文件（§2.5 rc 5：缺失 / 损坏 ⇒ 基准不可信，fail-closed） */
function readStateStrict() {
  if (!fs.existsSync(STATE)) return { ok: false, why: '状态文件不存在：' + STATE };
  let raw = '';
  try { raw = fs.readFileSync(STATE, 'utf8'); }
  catch (e) { return { ok: false, why: '状态文件读不到：' + (e?.message ?? e) }; }
  let j = null;
  try { j = JSON.parse(raw); }
  catch (e) { return { ok: false, why: '状态文件不是合法 JSON：' + String(e?.message ?? e).slice(0, 160) }; }
  if (!j || typeof j !== 'object' || Array.isArray(j) || !j.files || typeof j.files !== 'object') {
    return { ok: false, why: '状态文件结构异常（缺 files 对象）' };
  }
  return { ok: true, state: j };
}
/** orphan 新增/存量探针（独立文件，绝不写状态文件） */
function readAuditFeature() {
  try {
    const j = JSON.parse(fs.readFileSync(AUDIT_STATE, 'utf8'));
    if (j && typeof j === 'object' && Array.isArray(j.orphans)) return { orphans: new Set(j.orphans.map(String)) };
  } catch { }
  return { orphans: new Set() };
}

/** 例外通道第 4 条：`--to` **精确等于** L2 某项**本身**，**或**其下**单个 sid 叶子目录** `~\.dsh\sessions\<…>\<sid>` */
function except4(p) {
  const n = normPath(p);
  for (const x of l2List()) {
    if (x === n) return { ok: true, why: '精确等于 L2 某项本身' };
    if (!isAncestorOf(x, n)) continue;
    const parts = n.slice(x.length + 1).split('\\').filter(Boolean);
    const last = parts[parts.length - 1] ?? '';
    const sidLike = SID_LEAF_RE.test(last);
    if (sidLike && parts.length <= 2) return { ok: true, why: `其下 ${parts.length} 层的 sid 叶子目录` };
  }
  return { ok: false, why: '既非 L2 某项本身、亦非其下单个 sid 叶子目录（多层级后代）' };
}
/** 三态（注 e：不写死实况计数）；读不了按"非空"保守处置 */
function targetStateOf(abs) {
  if (!fs.existsSync(abs)) return 'none';
  let st;
  try { st = fs.statSync(abs); } catch { return 'none'; }
  if (!st.isDirectory()) return 'file';
  try { return fs.readdirSync(abs).length ? 'nonempty' : 'empty'; } catch { return 'nonempty'; }
}
/** `--fetch` 取值允许 glob（`*` / `?`）⇒ 按**目录末段**（sid 段）匹配 */
function globToRe(spec) {
  const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = '';
  for (const c of String(spec)) {
    if (c === '*') out += '[^\\\\]*';
    else if (c === '?') out += '[^\\\\]';
    else out += esc(c);
  }
  return new RegExp('^' + out + '$', 'i');
}

// ---- 远端（只读探测 + 取回通道）--------------------------------------------------------------
const remoteRootWin = () => REMOTE_ROOT.replace(/\//g, '\\');
function relFromRootLine(line) {
  const root = remoteRootWin();
  const l = String(line ?? '').trim().replace(/\//g, '\\');
  if (!l || l.length <= root.length + 1) return null;
  if (l.slice(0, root.length).toLowerCase() !== root.toLowerCase()) return null;
  if (l[root.length] !== '\\') return null;
  return l.slice(root.length + 1).split('\\').filter(Boolean).join('/');
}
function listRemoteDirsUnder(sub) {
  const r = ssh(`dir /b /s /ad "${remoteRootWin()}\\${sub}"`, SPAWN_TIMEOUT_MS);
  const out = [];
  for (const line of String(r.out).split(/\r?\n/)) { const rel = relFromRootLine(line); if (rel) out.push(rel); }
  return out;
}
function listRemoteFilesUnder(relDir) {
  const r = ssh(`dir /b /s /a-d "${remoteRootWin()}\\${relDir.replace(/\//g, '\\')}"`, SPAWN_TIMEOUT_MS);
  const out = [];
  for (const line of String(r.out).split(/\r?\n/)) { const rel = relFromRootLine(line); if (rel) out.push(rel); }
  return out;
}
function chunkRels(list, maxCount = 16, maxLen = 5000) {
  const out = []; let cur = [], len = 0;
  for (const r of list) {
    if (cur.length && (cur.length >= maxCount || len + r.length + 3 > maxLen)) { out.push(cur); cur = []; len = 0; }
    cur.push(r); len += r.length + 3;
  }
  if (cur.length) out.push(cur);
  return out;
}
function walkFiles(root) {
  const out = []; const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  }
  return out.sort();
}
function sha256Of(f) { return createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }

// ───────────────────────── R-065 删除面守卫（锁14 批 A 接入） ─────────────────────────
// 本脚本本机删除面**全部**落在 `TMP`（`%TEMP%\dsh-session-mirror`）之下：
//   · `cleanupLocal()` —— --fetch 取回的本地临时目录
//   · 打包时逐批删掉本地 tar
//   · 推送收尾整棵删掉 TMP
// ⇒ 白名单 = `[TMP]`；目标不在其下 = 拒（fail-closed，绝不静默回落）。
//
// 🔴 **本机三件套接不上的两类点（如实登记，见交付报告 §逐件接入 第 2 行）**：
//   ① **远端删除点**（L~1009 / L~1798 的 `ssh(\`del /q "…"\`)`）：命令在 **mirror-host 上**由 cmd.exe 执行，
//      本机 node 进程的闸门管不到对端 ⇒ 结构性接不上。替代 = 只清本脚本自己刚落到远端
//      `_tmp` 的通配临时 tar（`batch-*.tar` / `fetch-*-*.tar`），不动镜像内容；且**本卡不跨机**（红线）。
//   ② **同目录原子写改名**（`writeStateAtomic` 的 `renameSync(tmp, STATE)`；`writeTextAtomic` 的
//      `renameSync` 与其 Windows 回落 `rmSync(file)` + 再 `renameSync`）：
//      同目录内临时文件改名**覆盖**，且只在"目标已存在"时才走到那个 rm —— 删掉的正是**马上要被覆盖的
//      同一个目标文件**（rename 本身也会覆盖它）⇒ 破坏力**不超过**它要干的那件事，不递归、不跨树、
//      不跟链接（Windows rename 是元数据操作）。接闸收益 ≈ 0，代价是每次写都留一条"生产放行"痕迹、
//      把真绕过数淹掉（与共享件"dry-run 不记"同一精神）。⇒ **判定不接**；三个"可达"出口本来就有
//      `if (!OPT.dryRun) writeStateAtomic(...)` 短路。
//
// @param {string} target 删除目标（必须落在 TMP 之下）
// @param {{label?:string, reason?:string, recursive?:boolean, dryRun?:boolean}} [o]
// @returns {boolean} 真删了 ⇒ true；dry-run 或**被闸拒绝** ⇒ false（拒时打印点名原因，绝不静默）
//   · 夹具可测性：本函数 **export** 出来（行为一字未改），供锁14 批 A 的夹具演练
//     在隔离 TEMP 下直接调它验"reparse 拒删 / 白名单拒跑 / dry-run 零写"。
export function rmGuarded(target, o = {}) {
  const recursive = o.recursive !== false;
  const dryRun = o.dryRun ?? OPT.dryRun;
  if (dryRun) { log(`  (dry-run) 将${recursive ? '递归删除' : '删除'} ${target}`); return false; }   // ← 第一道门（函数内）
  const g = gateDestructive({
    targets: [{ path: target, label: o.label ?? path.basename(target) }],
    whitelist: [TMP],
    op: recursive ? '删' : '删文件',
    scope: ['file'], requires: ['file'],
    dryRun: false,
    allowProduction: false,          // 目标是本机 %TEMP%，本就不该命中生产树；命中即说明有东西跑偏 ⇒ 让它拒
    allowReparse: false,             // 逃生舱不留：临时目录里有 junction 就说明这棵不能删（跟删高危）
    reason: o.reason ?? 'session-mirror 清理本地临时件',
  });
  if (!g.ok) {
    log(`  ❌ R-065 删除面闸拒绝（${g.code}）· ${o.reason ?? ''} —— ${String(g.reason).split('\n')[1]?.trim() ?? ''}`);
    return false;
  }
  if (recursive) fs.rmSync(target, { recursive: true, force: true });
  else fs.rmSync(target, { force: true });
  return true;
}

function cleanupLocal(dir) { try { if (dir) rmGuarded(dir, { label: 'fetch-tmp', reason: '--fetch 取回收尾：清本地临时目录' }); } catch { } }

/** 取回通道 A：远端 tar 打包 → scp → 本地解包（mirror-host `tar` 已实测可用 = bsdtar 3.5.2 @ C:\Windows\system32\tar.exe） */
function fetchViaRemoteTar(memberRels) {
  const stamp = `${Date.now()}-${process.pid}`;
  const localTmp = path.join(TMP, `fetch-${stamp}`);
  fs.mkdirSync(localTmp, { recursive: true });
  const batches = chunkRels(memberRels);
  const remoteTmpWin = `${remoteRootWin()}\\${REMOTE_TMP_SUBDIR}`;
  for (let i = 0; i < batches.length; i++) {
    const name = `fetch-${stamp}-${i}.tar`;
    const remoteTarWin = `${remoteTmpWin}\\${name}`;
    const remoteTarPosix = `${REMOTE_ROOT}/${REMOTE_TMP_SUBDIR}/${name}`;
    const members = batches[i].map((r) => `"${r.replace(/\//g, '\\')}"`).join(' ');
    const t = ssh(`tar -cf "${remoteTarWin}" -C "${remoteRootWin()}" ${members}`, SPAWN_TIMEOUT_MS);
    if (!t.ok) return { error: `远端打包失败（批 ${i + 1}/${batches.length}）：${String(t.err || t.out).slice(0, 300)}`, extractRoot: localTmp };
    const localTar = path.join(localTmp, name);
    const up = run('scp', ['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=' + SCP_CONNECT_TIMEOUT_S, '-i', KEY, `${HOST}:${remoteTarPosix}`, localTar], { timeout: SPAWN_TIMEOUT_MS });
    if (!up.ok) return { error: `取回失败（批 ${i + 1}/${batches.length}）：${String(up.err || up.out).slice(0, 300)}`, extractRoot: localTmp };
    const ex = run('tar', ['-xf', localTar, '-C', localTmp], { timeout: SPAWN_TIMEOUT_MS });
    if (!ex.ok) return { error: `本地解包失败（批 ${i + 1}/${batches.length}）：${String(ex.err || ex.out).slice(0, 300)}`, extractRoot: localTmp };
    try { rmGuarded(localTar, { recursive: false, label: 'batch-tar', reason: '解包完成后删本批本地 tar' }); } catch { }
  }
  ssh(`del /q "${remoteTmpWin}\\fetch-${stamp}-*.tar"`, 60_000);   // 只清本轮临时 tar，不动镜像内容
  return { extractRoot: localTmp };
}
/** 取回通道 B：`scp` 单文件直取、不经远端 tar（远端 tar 不可用时的分支） */
function fetchViaScp(relFiles) {
  const stamp = `${Date.now()}-${process.pid}`;
  const localTmp = path.join(TMP, `fetch-scp-${stamp}`);
  fs.mkdirSync(localTmp, { recursive: true });
  for (const rel of relFiles) {
    const dst = path.join(localTmp, ...rel.split('/'));
    try { fs.mkdirSync(path.dirname(dst), { recursive: true }); }
    catch (e) { return { error: `本地临时目录准备失败：${e?.message ?? e}`, extractRoot: localTmp }; }
    const up = run('scp', ['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=' + SCP_CONNECT_TIMEOUT_S, '-i', KEY, `${HOST}:${REMOTE_ROOT}/${rel}`, dst], { timeout: SPAWN_TIMEOUT_MS });
    if (!up.ok) return { error: `scp 取回失败（${rel}）：${String(up.err || up.out).slice(0, 300)}`, extractRoot: localTmp };
  }
  return { extractRoot: localTmp };
}

/** 写入目标：**只建目标这一层**（不递归建到盘根）+ **同名文件永不覆盖**（表 M1-B 行 4 / 8 / 20） */
function writeInto(toAbs, extractRoot, relFiles) {
  const written = [], skipped = [];
  if (!fs.existsSync(toAbs)) fs.mkdirSync(toAbs);    // recursive:false ⇒ 父不存在即抛 ⇒ 运行期失败 ⇒ exit 1
  for (const rel of relFiles) {
    const dst = path.join(toAbs, ...rel.split('/'));
    if (fs.existsSync(dst)) { skipped.push(rel); continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(extractRoot, ...rel.split('/')), dst);
    written.push(rel);
  }
  return { written, skipped };
}

let _butlerLib = null;
async function loadButlerLib() {
  if (!_butlerLib) {
    const base = path.join(TOOLS_DIR, 'dsh-butler', 'lib');
    const [store, audit] = await Promise.all([
      import(pathToFileURL(path.join(base, 'store.mjs')).href),
      import(pathToFileURL(path.join(base, 'audit.mjs')).href),
    ]);
    _butlerLib = { acquireTickLock: store.acquireTickLock, appendAudit: audit.appendAudit };
  }
  return _butlerLib;
}

async function mainFetch() {
  const startedAt = Date.now();
  const specRaw = FETCH.spec;
  const toRaw = FETCH.to;
  const specBad = !specRaw || String(specRaw).trim() === '' || String(specRaw).startsWith('--');
  const toBad = !toRaw || String(toRaw).trim() === '' || String(toRaw).startsWith('--');

  // ---------- 闸 1 · 用法校验（最先 · exit 2）----------------------------------------------
  const usageErrs = [];
  if (specBad) usageErrs.push('`--fetch` 无实参');
  if (toBad) usageErrs.push('`--to` 缺失');
  let toAbs = null;
  if (!toBad) {
    toAbs = absPath(toRaw);
    if (GLOB_META.test(String(toRaw))) usageErrs.push(`\`--to\` 含 glob 元字符（注 h：目录路径一律不得含）：${toRaw}`);
    try { if (fs.existsSync(toAbs) && !fs.statSync(toAbs).isDirectory()) usageErrs.push(`\`--to\` 指向既存文件：${toAbs}`); } catch { }
  }
  if (usageErrs.length) {
    log('❌ 用法错（表 M1-B 行 26 · 用法校验最先、先于材料与黑名单）：');
    for (const e of usageErrs) log(`   · ${e}`);
    return 2;
  }

  // ---------- 闸 2 · 例外通道材料校验（先于黑名单 · exit 6）---------------------------------
  if (FETCH.intoProduction) {
    const miss = [];
    if (!FETCH.apply) miss.push('缺 `--apply`（`--apply` 本身是例外材料之一 ⇒ dry-run 下例外通道不可用）');
    if (!FETCH.confirmProduction) miss.push('缺 `--confirm-production`');
    else if (String(FETCH.confirmProduction) !== String(specRaw)) miss.push(`\`--confirm-production\` 与 \`--fetch\` 不全等：${FETCH.confirmProduction} ≠ ${specRaw}`);
    if (miss.length) {
      log('❌ 例外通道材料不全 / <sid> 不匹配（表 M1-B 行 9 / 10 / 12 / 15 / 16 / 25 · 先于黑名单）：');
      for (const m of miss) log(`   · ${m}`);
      return 6;
    }
  }

  // ---------- 闸 3 · 黑名单（层优先级 L3 → L2 → L1 → L0 · exit 5）--------------------------
  const nTo = normPath(toAbs);
  const layer = layerOf(nTo);
  let e4 = null;
  if (layer === 'L3') { log(`❌ 黑名单 L3（核心启动链）fail-closed：${toAbs} —— 例外通道**不含** L3（永不可作目标）`); return 5; }
  if (layer === 'L1') { log(`❌ 黑名单 L1（上位目录 / 盘根）fail-closed：${toAbs} —— 例外通道只认 L2（永不可作目标）`); return 5; }
  if (layer === 'L2') {
    if (!FETCH.intoProduction) { log(`❌ 黑名单 L2（生产目录）fail-closed：${toAbs} —— 默认路径一律不写生产（救援写回须走例外通道）`); return 5; }
    e4 = except4(nTo);
    if (!e4.ok) { log(`❌ 黑名单 L2 · 例外通道第 4 条不成立（${e4.why}）：${toAbs}`); return 5; }
  }
  // 表 M1-B 行 5–8：目标**不命中黑名单**（L0）却给了 `--into-production` ⇒ **忽略该旗标**、按默认路径走，
  //   但**必须打印提示、不得静默**（材料校验已在前一闸完成 ⇒ 缺件仍在行 9 报 6）
  if (layer === 'L0' && FETCH.intoProduction) {
    log('ℹ️ 目标不命中黑名单（L0）⇒ 忽略 `--into-production`（表 M1-B 行 5–8），按默认路径走（不报 6、不报 5）');
  }

  // ---------- 闸 4 · 三态（非空闸 fail-closed · exit 4）------------------------------------
  const tState = targetStateOf(toAbs);
  if (tState === 'nonempty' && !FETCH.allowNonempty) {
    log(`❌ 非空闸 fail-closed（表 M1-B 行 3${layer === 'L2' ? ' / 19' : ''}）：目标存在且非空、且未给 --allow-nonempty：${toAbs}`);
    return 4;
  }

  // ---------- 闸 5 · 锁 + 对端可达性（exit 3）---------------------------------------------
  // 注 j：与 tickd 的 `session-mirror` job **共用同一把锁**；抢不到 ⇒ 不等待、不排队、立即让路 ⇒ exit 3
  const { acquireTickLock, appendAudit } = await loadButlerLib();
  const lock = acquireTickLock(FETCH_LOCK_NAME, { ttlMs: FETCH_LOCK_TTL_MS, home: DSH });
  if (!lock.ok) {
    log(`⏸ 让路（原因 = 本机这一轮不予执行）：抢不到 \`${FETCH_LOCK_NAME}\` 锁（reason=${lock.reason ?? 'held'}${lock.holder?.pid ? `，holder pid=${lock.holder.pid}` : ''}）⇒ exit 3`);
    return 3;
  }
  try {
    if (!fs.existsSync(KEY)) { process.stderr.write(`缺少 SSH 密钥：${KEY}\n`); return 1; }   // 沿用既有语义（L148）
    const ch = ensureChannel();               // 通道择路同推送轮：lan 优先 → 隧道回落
    if (!ch.ok) {
      log('⚠️ 对端不可达（lan / tunnel 两条通道都探不通）⇒ exit 3（原因 = 本机这一轮不予执行）');
      for (const t of ch.tried) log(`    · ${t.channel}（${t.target}）：${t.err}`);
      if (ch.rent?.skipped) log(`    · 按需短租：**跳过**（${ch.rent.skipped}${ch.rent.switchReason ? ' · ' + ch.rent.switchReason : ''}${ch.rent.note ? ' · ' + ch.rent.note : ''}）`);
      else if (ch.rent?.rolledBack) log('    · 按需短租：开起来了但仍不通 ⇒ 已回滚（relay-cli down）');
      log('   兜底提示：仓2（Gitee `dsh-sessions`）只读 —— Gitee 拒写不拒读；若仓2 被回收 / 删除则该兜底亦断');
      return 3;
    }
    log(`  ⓘ 通道：${ch.channel === 'tunnel' ? 'VPS 中继隧道回落' : '局域网直连'}（${ch.target}）${ch.rented ? '（**本轮按需短租**：收尾立刻 down）' : ''}`);

    // ---------- 闸 6 · 远端命中（exit 7）--------------------------------------------------
    const re = globToRe(String(specRaw));
    const allDirs = [...listRemoteDirsUnder('sessions'), ...listRemoteDirsUnder('_archived-sessions')];
    const hits = [...new Set(allDirs.filter((d) => re.test(d.split('/').pop())))].sort();
    log('── 会话救援取回（镜像 → 本地）────────────────');
    log(`  对端    ${HOST}:${REMOTE_ROOT}`);
    log(`  请求    --fetch ${specRaw}`);
    log(`  目标    ${toAbs}   [层=${layer}${e4 ? ` · 例外④成立：${e4.why}` : ''} · 三态=${tState}]`);
    if (!hits.length) {
      log(`⚠️ 远端无匹配：${HOST} 的 sessions / _archived-sessions 下无 sid 命中 ⇒ exit 7（明确非零、不静默）`);
      return 7;
    }
    log(`  命中    ${hits.length} 个 sid 目录：`);
    for (const d of hits) log(`    · ${d}`);
    const uniqFiles = [...new Set(hits.flatMap((d) => listRemoteFilesUnder(d)))].sort();
    if (!uniqFiles.length) { log('⚠️ 命中的 sid 目录内无文件 ⇒ 按"远端未命中"处置 ⇒ exit 7'); return 7; }
    log(`  远端文件 ${uniqFiles.length} 个`);

    // ---------- 闸 7 · dry-run（不写） / 写盘（apply）-------------------------------------
    if (!FETCH.apply) {
      log('  [dry-run] 将取回（**一个字节都不写**、不建目录）：');
      for (const f of uniqFiles) log(`    ${f}`);
      log('  ⇒ exit 0（dry-run 与 apply 的 exit 相同，差别只在写盘与留痕 —— 表 M1-C）');
      return 0;
    }

    const want = String(process.env.DSH_MIRROR_FETCH_CHANNEL || 'auto').toLowerCase();
    let useTar;
    if (want === 'scp') useTar = false;
    else if (want === 'tar') useTar = true;
    else { const p = ssh('tar --version', 60_000); useTar = p.ok && /tar/i.test(String(p.out)); }
    log(`  取回通道 ${useTar ? 'tar（远端打包 → scp → 本地解包）' : 'scp 单文件直取（远端 tar 不可用）'}`);

    const got = useTar ? fetchViaRemoteTar(hits) : fetchViaScp(uniqFiles);
    if (got.error) {
      log(`❌ 取回过程失败：${got.error}`);
      log('   ⇒ exit 1（表 M1-D 的 1 行 · 运行期码；半截件不回滚，重跑按"同名永不覆盖"跳过并记账）');
      cleanupLocal(got.extractRoot);
      return 1;
    }
    const extractRoot = got.extractRoot;
    try {
      const gotFiles = walkFiles(extractRoot);
      if (!gotFiles.length) { log('❌ 取回后本地无文件 ⇒ exit 1'); return 1; }
      const manifest = gotFiles.map((rel) => {
        const src = path.join(extractRoot, ...rel.split('/'));
        return { rel, size: fs.statSync(src).size, sha256: sha256Of(src), target: path.join(toAbs, ...rel.split('/')) };
      });
      // 注 c（留痕）：走例外通道 ⇒ **写前**先打印 dry-run 清单（逐文件 sha + 目标路径）
      if (FETCH.intoProduction) {
        log('  ── 例外通道留痕：写前清单（逐文件 sha256 + 目标路径）──');
        for (const m of manifest) log(`    ${m.sha256}  ${String(m.size).padStart(9)} B  ${m.target}`);
      }
      let res;
      try { res = writeInto(toAbs, extractRoot, gotFiles); }
      catch (e) {
        log(`❌ 写盘失败：${e?.message ?? e}`);
        log('   ⇒ exit 1（运行期失败；半截件不回滚）');
        return 1;
      }
      // 注 c（留痕）：走例外通道 ⇒ **写后**写审计流水（`~\.dsh\butler-audit\YYYY-MM.jsonl`）
      if (FETCH.intoProduction) {
        try {
          appendAudit({
            type: 'session-mirror-fetch',
            spec: String(specRaw), to: toAbs, layer, except4: e4?.why ?? null,
            host: HOST, remoteRoot: REMOTE_ROOT, channel: useTar ? 'tar' : 'scp',
            files: manifest.map((m) => ({ rel: m.rel, sha256: m.sha256, size: m.size })),
            written: res.written, skipped: res.skipped,
          }, { home: DSH });
        } catch (e) { log(`   ⚠️ 审计流水写入失败（不改变 exit code）：${e?.message ?? e}`); }
      }
      const bytes = manifest.reduce((n, m) => n + m.size, 0);
      log('');
      log(`  ✅ 已写入 ${res.written.length} 个 / ${MB(bytes).toFixed(2)} MB${res.skipped.length ? ` · 跳过（同名已存在、永不覆盖）${res.skipped.length} 个` : ''}`);
      for (const s of res.skipped) log(`    ⊘ ${s}`);
      log(`  目标 ${toAbs} · 耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      return 0;
    } finally { cleanupLocal(extractRoot); }
  } finally {
    try { lock.release(); } catch { }
  }
}

// ---------------------------------------------------------------- 第一柱 · 远端清单核对 · 实现（--audit-remote）
//   ⚠️ 与「方案 §2」逐条对齐；改动必须同批核方案 §2.1–§2.6

/** §2.2 主选路径：一次 ssh + 远端 node 只读遍历 → TSV（唯一可行形态，禁改写法） */
function auditRemoteNodeTsv() {
  const root = REMOTE_ROOT.replace(/\\/g, '/');
  // ⚠️ 实测坑（2026-10-11 第一柱施工 · 四轮探针钉死）：远端 cmd 解析引号时会在
  //   「字符串字面量里的反斜杠转义 + 连续右括号收尾」处截断 —— 原写法（'\t' 拼接 + '\n' 收尾）
  //   实测发出 384 B / 收回 379 B，尾部 5 字节被吃掉 ⇒ node 抛 SyntaxError rc=1 ⇒ **静默降级成
  //   names-only**（真机首跑即踩这个坑）。⇒ **脚本内禁写反斜杠转义**，TAB/NL 一律用
  //   `String.fromCharCode(9/10)` 生成（探针实测：改写法后 458 B 原样往返 rc=0、真跑 4641 行）。
  const script = "const fs=require('fs');const p=require('path');const root='" + root + "';"
    + "const TAB=String.fromCharCode(9);const NL=String.fromCharCode(10);const out=[];"
    + "(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){"
    + "const f=p.join(d,e.name);if(e.isDirectory())walk(f);else{const s=fs.statSync(f);"
    + "out.push(p.relative(root,f).split(p.sep).join('/')+TAB+s.size+TAB+Math.round(s.mtimeMs));}}})"
    + "(root);process.stdout.write(out.join(NL));";
  const remoteCmd = 'node -e "' + script + '"';   // ← 整个 remoteCmd 是【一个】argv 元素（§2.2 硬约束）
  const r = ssh(remoteCmd, AUDIT_SSH_TIMEOUT_MS);
  const outLines = String(r.out ?? '').split(/\r?\n/);
  const parsed = [];
  let badLines = 0, tmpSkipped = 0;
  for (const line of outLines) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) { badLines++; continue; }
    const rel = parts[0].trim().replace(/\\/g, '/');
    const size = Number(parts[1]);
    const mtimeMs = Number(parts[2]);
    if (!rel || !Number.isFinite(size) || !Number.isFinite(mtimeMs)) { badLines++; continue; }
    if (rel === '_tmp' || rel.startsWith(AUDIT_TMP_PREFIX)) { tmpSkipped++; continue; }
    parsed.push({ rel, size, mtimeMs: Math.round(mtimeMs) });
  }
  const nonEmptyLines = outLines.filter((l) => l.trim()).length;
  const ok = r.ok && (parsed.length > 0 || nonEmptyLines === 0);
  return { ok, format: 'node-tsv', parsed, lineCount: parsed.length, tmpSkipped, badLines, rc: r.code, err: String(r.err ?? '').slice(0, 200) };
}
/** §2.2 降级路径（node 不可用时）：只给全路径、无 size/mtime ⇒ 纯存在性核对，标 names-only */
function auditRemoteNamesOnly() {
  const rels = new Set();
  for (const rel of listRemoteFilesUnder('')) if (rel) rels.add(rel);
  return { ok: rels.size > 0, format: 'names-only', rels, lineCount: rels.size };
}
/** §2.4：orphan 旧名/新名分布（末段是否 .v3.jsonl.zstd） */
function auditNameSplit(rels) {
  let legacy = 0, v3 = 0;
  for (const r of rels) { if (/\.v3\.jsonl\.zstd$/i.test(r)) v3++; else legacy++; }
  return { legacy, v3 };
}
/** 渲染人读面（§2.4）；人读与 MD **同一份内存数据**，不重跑比对 */
function auditRenderLines(R) {
  const P = [];
  P.push('── 会话异地镜像 · 远端清单核对（本机 → 远端）────────────');
  P.push('  触发：' + R.invokedBy + '            依据：butler-session-mirror.json（' + R.counts.registered + ' 登记 · 状态文件 ' + (R.stateMtime ?? '(取不到)') + '）');
  P.push('  远端：' + R.host + ':' + R.target + ' · ' + R.remoteListing + ' · ' + R.counts.remote + ' 个文件（剔除 _tmp ' + R.tmpSkipped + ' 条）');
  if (R.degraded) P.push('  ⚠️ 降级：' + R.degraded + ' —— 只判 missing/extra，**不能**判「内容变没变」（建议补 sha 抽样）');
  if (R.counts.missing === 0) P.push('  ✅ 无缺失（missing 0）');
  else P.push('  🔴 远端缺件 ' + R.counts.missing + ' 条（列前 ' + R.missing.items.length + '；**这一项影响退出码 rc=1**）');
  for (const it of R.missing.items) {
    P.push('      ' + it.rel + (it.size === null ? '' : '  ' + MB(it.size).toFixed(2) + ' MB') + (it.pushedAt ? '  pushedAt ' + it.pushedAt : ''));
  }
  P.push('  🟡 远端多余 ' + R.counts.extra + ' 条（列前 ' + R.extra.items.length + '）：');
  for (const rel of R.extra.items) P.push('      ' + rel);
  P.push('  🟡 本机僵尸登记 ' + R.counts.orphan + ' 条（新增 ' + R.counts.orphanNew + ' / 存量 ' + R.counts.orphanStock + '；旧名 ' + R.orphan.nameSplit.legacy + ' / 新名 .v3 ' + R.orphan.nameSplit.v3 + '）— 只列 Top ' + R.orphan.items.length);
  for (const rel of R.orphan.items) P.push('      ' + rel);
  P.push('  ⚪ 从未登记 ' + R.counts.neverMirrored + ' 条（本轮未跑到，正常）');
  P.push('  远端盘：' + (R.remoteSpace.freeBytes === null
    ? '取不到（level=unknown，不告警）'
    : '可用 ' + fmtGiB(R.remoteSpace.freeBytes) + ' GiB（level=' + R.remoteSpace.level + '）'));
  // §4.4 段④/⑥ 在人读面上同样给全（md 里另有独立段）
  for (const a of (R.alerts ?? [])) P.push('  [' + a.level + '] ' + a.code + '：' + a.message);
  if (R.fresh) P.push('  ' + R.fresh.text);
  return P;
}
/** 人读面 → MD（§2.4：头部固定带 invokedBy 与 asOf） */
function auditRenderMd(R, lines) {
  const B = String.fromCharCode(96);
  const out = [];
  out.push('# 会话异地镜像 · 远端清单核对周报');
  out.push('');
  // ⑥ 新鲜度行（§4.4 段⑥ · §4.3 判据）—— 方案要求落在**周报首行**。
  //    ⚠️ 边界空态（§4.4 之 1）：首跑 / `#lastAudit` 尚不存在 ⇒ 一律渲染
  //       「上次核对：无记录（首跑）」，**不得**渲染成 ✅ /「正常」（防"字段没了 = 一切正常"）。
  const fresh = R.fresh ?? { known: false, at: null, days: null, stale: false, text: '上次核对：无记录（首跑）' };
  out.push('> **新鲜度**：' + fresh.text);
  if (fresh.stale && fresh.at) out.push('> ⚠️ 上次成功核对：' + String(fresh.at).slice(0, 10) + '（中间若干轮可能因对端不可达 / 报告写不出去而未产出 —— 本行只说事实、不编轮数）');
  out.push('');
  out.push('- **invokedBy**：' + B + R.invokedBy + B);
  out.push('- **asOf**：' + R.asOf);
  out.push('- **主机 / 远端根**：' + B + R.host + B + ' / ' + B + R.target + B);
  out.push('- **远端清单形态**：' + B + R.remoteListing + B + (R.degraded ? '（降级：' + R.degraded + '）' : ''));
  out.push('- **依据**：' + B + 'butler-session-mirror.json' + B + '（' + R.counts.registered + ' 登记）· 状态文件 mtime ' + (R.stateMtime ?? '(取不到)'));
  out.push('');
  out.push('## 计数');
  out.push('');
  out.push('| remote | registered | scanned | missing | extra | orphan | orphanNew | orphanStock | neverMirrored | tmpSkipped |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  out.push('| ' + R.counts.remote + ' | ' + R.counts.registered + ' | ' + R.counts.scanned + ' | ' + R.counts.missing + ' | ' + R.counts.extra + ' | ' + R.counts.orphan + ' | ' + R.counts.orphanNew + ' | ' + R.counts.orphanStock + ' | ' + R.counts.neverMirrored + ' | ' + R.tmpSkipped + ' |');
  out.push('');
  out.push('## 退出码口径（§2.5）');
  out.push('');
  out.push('- ' + B + '0' + B + ' = 核对完成、missing=0（extra/orphan 只提示，不改 rc）');
  out.push('- ' + B + '1' + B + ' = 核对完成、**missing>0**（远端真丢件，需补传；与推送族「1=失败」同号不同义，看模式）');
  out.push('- ' + B + '2' + B + ' 用法错 · ' + B + '3' + B + ' 对端不可达 / 让路 · ' + B + '4' + B + ' 远端清单不可解析 / 明显截断 · ' + B + '5' + B + ' 本机状态文件缺失 / 损坏（fail-closed）');
  out.push('');
  out.push('## 三类结论');
  out.push('');
  out.push('### 🔴 missing（远端缺件 · 唯一影响 rc）');
  out.push('');
  if (!R.missing.items.length) out.push('（无）');
  else {
    out.push('| rel | size | pushedAt |');
    out.push('|---|---|---|');
    for (const it of R.missing.items) out.push('| ' + B + it.rel + B + ' | ' + (it.size ?? '') + ' | ' + (it.pushedAt ?? '') + ' |');
    if (R.counts.missing > R.missing.items.length) out.push('… 其余 ' + (R.counts.missing - R.missing.items.length) + ' 条（明细上限 ' + R.missing.limit + '）');
  }
  out.push('');
  out.push('### 🟡 extra（远端多余 · 只提示）');
  out.push('');
  if (!R.extra.items.length) out.push('（无）');
  else {
    for (const rel of R.extra.items) out.push('- ' + B + rel + B);
    if (R.counts.extra > R.extra.items.length) out.push('… 其余 ' + (R.counts.extra - R.extra.items.length) + ' 条');
  }
  out.push('');
  out.push('### 🟡 orphan（本机僵尸登记 · 只提示 · 只列 Top 10）');
  out.push('');
  out.push('新增 ' + R.counts.orphanNew + ' / 存量 ' + R.counts.orphanStock + '；旧名 ' + R.orphan.nameSplit.legacy + ' / 新名 ' + B + '.v3' + B + ' ' + R.orphan.nameSplit.v3);
  out.push('');
  if (!R.orphan.items.length) out.push('（无）');
  else for (const rel of R.orphan.items) out.push('- ' + B + rel + B);
  out.push('');
  out.push('### ⚪ neverMirrored（从未登记 · 只计数）');
  out.push('');
  out.push('**' + R.counts.neverMirrored + '** 条（本轮未跑到的增量，正常）');
  out.push('');
  out.push('## 远端盘');
  out.push('');
  out.push(R.remoteSpace.freeBytes === null
    ? '取不到（`level=unknown`，**不告警** —— 见方案 §3.2 失败行）'
    : '卷 ' + R.remoteSpace.volume + ' · 可用 ' + fmtGiB(R.remoteSpace.freeBytes) + ' GiB · `level=' + R.remoteSpace.level + '`'
      + ' · 阈值 warn ' + fmtGiB(R.remoteSpace.warnFreeBytes) + ' / alert ' + fmtGiB(R.remoteSpace.alertFreeBytes) + ' GiB'
      + (R.remoteSpace.enabled === false ? '（`remoteSpace.enabled=false` ⇒ **已关回、不告警**）' : ''));
  out.push('');
  // ④ 本轮 alerts[] 原样回显（§4.4 段④）+ "已恢复"行（与上一份成功报告比 code 差集）
  out.push('## 本轮告警（alerts[] · 原样回显）');
  out.push('');
  if (!(R.alerts ?? []).length) out.push('（本轮无告警）');
  else for (const a of R.alerts) out.push('- `' + a.level + '` · `' + a.code + '`：' + a.message);
  const prevAlerts = Array.isArray(R.prevAlerts) ? R.prevAlerts : null;
  if (prevAlerts) {
    const nowCodes = new Set((R.alerts ?? []).map((a) => a.code));
    const recovered = prevAlerts.filter((a) => !nowCodes.has(a.code));
    for (const a of recovered) out.push('- ✅ `' + a.code + '`（**已恢复**：上一份报告有、本轮没有）');
    if (!recovered.length) out.push('- （上一份报告的告警本轮仍在 / 已为空 ⇒ 无"已恢复"行）');
  } else {
    out.push('- （无上一份报告可对照 ⇒ 无法判定"已恢复"；首跑属正常，**不得**据此判一切正常）');
  }
  out.push('');
  // ⑤ 降级标志（§4.4 段⑤）
  out.push('## 降级标志');
  out.push('');
  out.push('- `remoteListing`：' + B + R.remoteListing + B + (R.degraded ? '（**降级**：' + R.degraded + '）' : '（主选 node-tsv 正常 ⇒ 可判 missing/extra/orphan 三类）'));
  out.push('- `tmpSkipped`：' + B + R.tmpSkipped + B + ' 条（远端 `_tmp/` 前缀条目，已剔除 ⇒ 不进 extra，防并发假阳）');
  out.push('');
  out.push('## 人读面原文');
  out.push('');
  out.push(B + B + B);
  for (const l of lines) out.push(l);
  out.push(B + B + B);
  out.push('');
  return out.join('\n');
}

/** --audit-remote 主流程（§2 全文；只读远端 + 只读本机状态文件） */
async function mainAuditRemote() {
  const asOf = new Date().toISOString();
  const invokedBy = auditInvokedBy();

  // ---------- 自检 · 写读同口径（S4 打回修正 · round2）--------------------------------------
  //   落盘目录（由 `--out` / `--report-md` 解析出来）必须落在**读侧候选目录**里，否则本轮报告
  //   永远不会被推送轮的 `mergeLatestAudit()` 读到 ⇒ `#lastAudit` 静默停更（= 上一轮被打回的根因）。
  //   ⇒ 每次核对都当场打印，把"写读一致"变成**运行时可核事实**，而不是纸面承诺。
  const auditWriteDirs = [AUDIT.out, AUDIT.reportMd].filter(Boolean).map(auditDestDir);
  const auditReadDirs = auditReportDirs();
  if (auditWriteDirs.length) {
    const sameDir = auditWriteDirs.some((w) => auditReadDirs.some((r) => path.resolve(r).toLowerCase() === path.resolve(w).toLowerCase()));
    if (sameDir) {
      log('✓ 写读同口径：产物落盘目录 == 读侧候选目录（' + auditWriteDirs[0] + '）');
    } else {
      log('⚠️ 写读口径不一致：产物落盘目录不在读侧候选目录内 ⇒ 本轮报告不会被合并进 #lastAudit');
      log('   · 落盘：' + auditWriteDirs.join(' | '));
      log('   · 读侧：' + auditReadDirs.join(' | '));
    }
  }

  // ---------- 闸 1 · 本机状态文件（§2.5 rc 5 · fail-closed）--------------------------------
  const st = readStateStrict();
  if (!st.ok) {
    log('❌ 本机状态文件缺失 / 损坏 ⇒ fail-closed（§2.5 rc 5：基准不可信）');
    log('   · ' + st.why);
    log('   · 路径：' + STATE + '（env DSH_SESSION_MIRROR_STATE 可注入）');
    return 5;
  }
  const registered = st.state.files;
  const registeredRels = Object.keys(registered);
  let stateMtime = null;
  try { stateMtime = new Date(fs.statSync(STATE).mtimeMs).toISOString(); } catch { }

  // ---------- 闸 2 · 对端可达（§2.5 rc 3 · 让路口径；**通道择路**同推送轮：lan 优先 → 隧道回落）-----------
  if (!fs.existsSync(KEY)) { process.stderr.write('缺少 SSH 密钥：' + KEY + '\n'); return 1; }
  printMirrorTargetNotices();
  const ch = ensureChannel();
  if (!ch.ok) {
    log('⚠️ 对端不可达（lan / tunnel 两条通道都探不通）⇒ exit 3（让路：本机这一轮不予执行，不重试）');
    for (const t of ch.tried) log('   · ' + t.channel + '（' + t.target + '）：' + t.err);
    if (ch.rent?.skipped) log('   · 按需短租：**跳过**（' + ch.rent.skipped + (ch.rent.switchReason ? ' · ' + ch.rent.switchReason : '') + '）');
    else if (ch.rent?.rolledBack) log('   · 按需短租：开起来了但仍不通 ⇒ 已回滚（relay-cli down）');
    // ⚠️ 本模式**不写状态文件**（§4.5 单写口）⇒ 也**不出声**：周频核对不刷告警，出声落在每小时的推送轮（必然执行的一侧）
    return 3;
  }
  log(ch.channel === 'tunnel'
    ? 'ⓘ 通道：VPS 中继隧道回落（' + ch.target + '）—— 局域网不可达' + (ch.rented ? '（**本轮按需短租**：收尾立刻 down）' : '')
    : 'ⓘ 通道：局域网直连（' + ch.target + '）');
  for (const t of ch.tried) log('   · 已试 ' + t.channel + '（' + t.target + '）：' + t.err);
  log('   · 注：本模式**不写状态文件**（§4.5 单写口）⇒ 也**不出声**；出声落在每小时的推送轮');

  // ---------- 闸 3 · 取远端清单（§2.2 主选 node-tsv → 降级 names-only）--------------------
  const remote = auditRemoteNodeTsv();
  let remoteSet = new Set();
  let tmpSkipped = remote.tmpSkipped ?? 0;
  let remoteListing = remote.format;
  let degraded = null;
  if (remote.ok && remote.format === 'node-tsv') {
    for (const e of remote.parsed) remoteSet.add(e.rel);
  } else {
    const names = auditRemoteNamesOnly();
    if (!names.ok) {
      log('❌ 远端清单不可解析 / 明显截断（§2.5 rc 4）');
      log('   · node-tsv：rc=' + remote.rc + ' 行数=' + remote.lineCount + ' 解析失败行=' + remote.badLines + (remote.err ? ' err=' + remote.err : ''));
      log('   · 降级 dir /b /s /a-d 也返回 0 行 ⇒ 不许把「读不到」当「0 差异」');
      return 4;
    }
    remoteSet = names.rels;
    remoteListing = 'names-only';
    degraded = 'node 不可用 / TSV 解析失败 ⇒ 降级 dir /b /s /a-d（纯存在性核对）';
    for (const rel of [...remoteSet]) if (rel === '_tmp' || rel.startsWith(AUDIT_TMP_PREFIX)) remoteSet.delete(rel);
  }

  // ---------- 三源与三类结论（§2.3）------------------------------------------------------
  const localFiles = scan();                       // A 本机生产集（SOURCES = sessions/_archived-sessions/attachments）
  const aSet = new Set(localFiles.map((f) => f.rel));
  const bSet = new Set(registeredRels);            // B 本机登记集
  const cSet = remoteSet;                          // C 远端实测集（已剔除 _tmp/）

  const missingRels = registeredRels.filter((rel) => aSet.has(rel) && !cSet.has(rel));
  const extraRels = [...cSet].filter((rel) => !bSet.has(rel));
  const orphanRels = registeredRels.filter((rel) => !aSet.has(rel));
  const neverMirroredRels = [...aSet].filter((rel) => !bSet.has(rel));

  // ---------- orphan 新增 vs 存量（§2.3 止噪 2）-------------------------------------------
  const prevOrphans = readAuditFeature().orphans;
  const orphanNewRels = orphanRels.filter((rel) => !prevOrphans.has(rel));
  const nNew = prevOrphans.size ? orphanNewRels.length : null;   // 首跑（无基线）⇒ 无法分「新增」，如实写 null
  const nStock = nNew === null ? null : Math.max(0, orphanRels.length - nNew);

  // ---------- 远端盘空间（§2.4 remoteSpace + §3 第二柱：判 level + 阈值告警）-------------------
  //  §3.2 取样点②（**新增**）：`--audit-remote` 内**必取一次**（不管有没有待推文件）⇒ 周核对保证每周 ≥1 个读数。
  //  🔴 阈值 = 统一开关文件（§3.3，唯一权威源）；缺配置 ⇒ fail-closed 到内置默认 20/10 GiB + 打印。
  //     复审 §7.3-S3②：**替换 S2 的临时代码阈值**（`<10=low / <50=warn` ⇒ 20/10 GiB 三档 ok/warn/alert）。
  //  🔴 与取样点①（推送路径）**共用同一份取盘/判级/决策实现**（`lib\remote-space.mjs`）—— 本文件不写第二份。
  //  ⚠️ 本模式**不写状态文件**（§2.6）：`prev` 只读；决策结果随报告 JSON/md 走，
  //     `#lastAudit`/`remoteSpace` 由推送 job 的单写口（§4.5）在下一轮合并。
  const spaceVol = REMOTE_ROOT.slice(0, 2).replace('/', '');
  const spacePrev = (() => {
    try { const s = readState()?.remoteSpace; return s && typeof s === 'object' ? s : null; } catch { return null; }
  })();
  const space = sampleRemoteSpace(spaceVol, { prev: spacePrev, now: Date.parse(asOf) || Date.now() });
  const remoteSpace = space.field;
  await emitSpaceAlert(space.decision.escalate);

  const pick = (rels, limit) => rels.slice(0, limit);
  // §4.3/§4.4：新鲜度读数（读本机状态文件的 `#lastAudit`，**只读**）+ 上一份报告的 alerts
  //   （供 md 的"已恢复"行；首跑无历史 ⇒ null，**不得**据此判一切正常）
  const fresh = auditFreshness();
  const prevAlerts = (() => {
    try {
      const a = readState()?.lastAudit?.alerts;
      return Array.isArray(a) ? a.map((x) => ({ level: x?.level ?? 'info', code: x?.code ?? '?', message: x?.message ?? '' })) : null;
    } catch { return null; }
  })();
  const R = {
    tool: 'dsh-session-mirror', mode: 'audit-remote', ok: missingRels.length === 0,
    asOf, invokedBy,
    host: HOST, target: REMOTE_ROOT,
    remoteListing, tmpSkipped, degraded,
    fresh, prevAlerts,
    stateMtime, stateSha16: sha16(STATE), stateBaselineMoved: false,
    counts: {
      remote: cSet.size, registered: registeredRels.length, scanned: localFiles.length,
      missing: missingRels.length, extra: extraRels.length, orphan: orphanRels.length,
      orphanNew: nNew, orphanStock: nStock, neverMirrored: neverMirroredRels.length,
    },
    bytes: {
      remoteTotal: localFiles.reduce((n, f) => n + (f.size ?? 0), 0),
      missingTotal: missingRels.reduce((n, rel) => n + (Number(registered[rel]?.size) || 0), 0),
    },
    remoteSpace,
  };
  R.missing = {
    limit: AUDIT.limit,
    items: pick(missingRels, AUDIT.limit).map((rel) => ({
      rel, size: Number(registered[rel]?.size) ?? null, pushedAt: registered[rel]?.pushedAt ?? null,
    })),
  };
  R.extra = { limit: Math.min(AUDIT.limit, AUDIT_EXTRA_DETAIL_LIMIT), items: pick(extraRels, Math.min(AUDIT.limit, AUDIT_EXTRA_DETAIL_LIMIT)) };
  R.orphan = { limit: AUDIT_ORPHAN_HARD_LIMIT, items: pick(orphanRels, AUDIT_ORPHAN_HARD_LIMIT), nameSplit: auditNameSplit(orphanRels) };
  R.alerts = [];
  // 【S3 · 第二柱】远端盘告警条目**全部由 `lib\remote-space.mjs` 的决策函数产出**
  //   （变严 / 同档 ≥24h 且 ≥1 次核对 / 连续 3 次 unknown / 变松留一行 info）⇒ 判据唯一，本文件不再自算阈值。
  //   🔴 关回：`remoteSpace.enabled=false` ⇒ 该函数返回空 `alerts[]`（验收④「不再告警」）。
  for (const a of space.decision.alerts) R.alerts.push(a);
  if (degraded) R.alerts.push({ level: 'info', code: 'remote-listing-degraded', message: degraded });
  if (R.counts.missing > 0) R.alerts.push({ level: 'warn', code: 'mirror-missing', message: '远端缺件 ' + R.counts.missing + ' 条（rc=1）' });
  // §4.3 新鲜度判据（`now - lastAudit.at > 8 天` ⇒ 🟡）：**落 alert.log + 周报首行**。
  //   ⚠️ 覆盖面**如实登记**（方案 §4.3 · 复审 N-3）：本判据只在"核对跑到这一步"时评估 ⇒
  //      实际只覆盖「job 被关」与「报告写不出去」两种；对端**连续不可达**时脚本在探活处即
  //      早退 rc=3、根本走不到这里 ⇒ 那一种首期不响（已升级为方案 §6.5-D8 待主人拍，
  //      本卡按默认 ③ = 零改动、如实登记后果）。
  if (fresh.stale) {
    R.alerts.push({ level: 'warn', code: 'mirror-audit-stale', message: fresh.text });
    try {
      const { alert } = await import('./lib/alert.mjs');
      // 显式传 home=DSH（= USERPROFILE/.dsh）⇒ 隔离夹具下自动落到夹具，**不污染生产 alert.log**
      alert({ level: 'warn', source: 'mirror-audit', message: fresh.text, detail: { lastAuditAt: fresh.at, days: Number(fresh.days.toFixed(2)) } }, { home: DSH, silent: true });
      log('  ⚠️ 新鲜度超阈 ⇒ 已落 alert.log（一级可见面仍是周报 md）');
    } catch (e) { log('  ⚠️ alert.log 写入失败（一级可见面是周报 md；不改变退出码）：' + (e?.message ?? e)); }
  }

  // ---------- 输出（§2.4）----------------------------------------------------------------
  const lines = auditRenderLines(R);
  for (const l of lines) log(l);

  if (AUDIT.out) {
    const p = auditDestPath(AUDIT.out, 'json');
    try {
      if (!fs.existsSync(path.dirname(p))) fs.mkdirSync(path.dirname(p), { recursive: true });
      writeTextAtomic(p, JSON.stringify(R, null, 2) + '\n');
      log('  📄 JSON 已落盘（原子写 · 同日重跑同名覆盖）：' + p);
    } catch (e) { log('  ⚠️ --out 落盘失败（不改变退出码）：' + (e?.message ?? e)); }
  }
  if (AUDIT.reportMd) {
    const p = auditDestPath(AUDIT.reportMd, 'md');
    try {
      if (!fs.existsSync(path.dirname(p))) fs.mkdirSync(path.dirname(p), { recursive: true });
      writeTextAtomic(p, auditRenderMd(R, lines));
      log('  📄 周报 MD 已落盘（原子写 · 同一份内存数据渲染）：' + p);
    } catch (e) { log('  ⚠️ --report-md 落盘失败（不改变退出码）：' + (e?.message ?? e)); }
  }

  // ---------- 只读探针（orphan 新增/存量）**独立于状态文件** -----------------------------
  try {
    if (!fs.existsSync(path.dirname(AUDIT_STATE))) fs.mkdirSync(path.dirname(AUDIT_STATE), { recursive: true });
    writeTextAtomic(AUDIT_STATE, JSON.stringify({
      schemaVersion: 1, lastAuditAt: asOf, host: os.hostname(), by: invokedBy,
      orphans: orphanRels, orphanNew: orphanNewRels, count: orphanRels.length,
    }, null, 2) + '\n');
  } catch (e) { log('  ⚠️ 审计探针落盘失败（不改变退出码）：' + (e?.message ?? e)); }

  if (argv.includes('--json')) process.stdout.write('---JSON---\n' + JSON.stringify(R, null, 2) + '\n');
  return R.counts.missing > 0 ? 1 : 0;
}

// ---------------------------------------------------------------- 主流程
/**
 * 【R9】`main()` 只做一层「收尾归还」外壳：无论走哪个出口（让路 / 成功 / 异常），
 *   都要把本轮**按需短租**的隧道还回去（`releasePeerChannel` —— **只关"本来 enabled=false、
 *   本次由我 enable+up"的那次**；走直连或隧道本来就在跑的轮次 `RENT_LEASE` 恒为空 ⇒ 什么都不做）。
 * ⚠️ 归还日志在 `--json` 模式下走 **stderr**：stdout 末尾那段 `---JSON---` 是给调用方解析的，不能污染。
 */
async function main() {
  try {
    return await mainBody();
  } finally {
    if (RENT_LEASE) {
      const say = (m) => { if (OPT.json) process.stderr.write(m + '\n'); else log(m); };
      try {
        const r = releasePeerChannel(RENT_LEASE, { log: say });
        if (!r.released) say(`  ⓘ 短租归还：${r.detail}`);
      } catch (e) {
        say(`  ⚠️ 短租归还失败（隧道可能还挂着 ⇒ 可跑 node <workspace>\\tools\\peer-channel-cli.mjs reclaim --apply）：${e?.message ?? e}`);
      }
    }
  }
}

async function mainBody() {
  if (process.exitCode === 2 || argv.includes('--help') || argv.includes('-h')) return process.exitCode ?? 0;
  if (AUDIT.present) return await mainAuditRemote();  // 第一柱 · 远端清单核对（只读；不写状态文件）
  if (FETCH.present) return await mainFetch();     // M1 · 会话救援取回（默认 dry-run；`--apply` 才写）
  if (!fs.existsSync(KEY)) { process.stderr.write(`缺少 SSH 密钥：${KEY}\n`); return 1; }

  const state = readState();
  state.files = state.files ?? {};

  if (OPT.status) {
    log('── 镜像状态 ─────────────────────────────────');
    log(`  目标        ${HOST}:${REMOTE_ROOT}`);
    log(`  通道        lan 优先 → tunnel 回落（本命令不探活；上轮实际走 ${state.channel ?? '(未记录)'}）`);
    log(`  上次运行    ${state.lastRunAt ?? '(从未)'}  结果 ${state.lastResult ?? '-'}`);
    // 【M4】判据面真源直读展示（人工判读用；与 tickd-health 读同一份载体）
    {
      const n = Number(state[UNREACHABLE_KEY] ?? 0);
      log(`  连续不可达  ${n} 轮${n > 0 && state[LAST_UNREACHABLE_AT_KEY] ? `（末次 ${state[LAST_UNREACHABLE_AT_KEY]}）` : ''}`
        + ' —— 健康判据真源（`butler-tickd\\state.json` 的 session-mirror 行已知失真，勿用）');
    }
    log(`  已登记文件  ${Object.keys(state.files).length} 个 / ${MB(Object.values(state.files).reduce((n, f) => n + (f.size ?? 0), 0) || 0).toFixed(1)} MB`);
    if (state.lastRun) log(`  上轮        发现 ${state.lastRun.scanned} / 变化 ${state.lastRun.changed} / 已传 ${state.lastRun.pushed} / ${MB(state.lastRun.bytes ?? 0).toFixed(1)} MB / 耗时 ${(state.lastRun.elapsedMs / 1000).toFixed(1)}s`);
    if (state.lastRun?.shellGuard) log(`  上轮守卫    空壳不得覆盖完整版：候选 ${state.lastRun.shellGuard.candidates} / 拒绝覆盖 ${state.lastRun.shellGuard.blocked}（见状态文件 lastRun.shellGuard.blockedItems）`);
    if (OPT.json) process.stdout.write('---JSON---\n' + JSON.stringify({ state }, null, 2) + '\n');
    return 0;
  }

  // 0) 开关文件"读不到 / 缺字段"的打印（§5.2：怕的是"静默变行为"）
  printMirrorTargetNotices();

  // 1) 探活 + **通道择路**（局域网优先 → 隧道回落；两条都不通 = 让路，不是失败）
  const ch = ensureChannel();
  if (!ch.ok) {
    // 【M4】判据面：连续不可达 **+1**（先记账再写；dry-run 不写盘 ⇒ 计数不前进，符合"dry-run 不记账"）
    const n = bumpUnreachable(state);
    log(`⚠️ 对端不可达（lan / tunnel 两条通道都探不通）→ 本轮让路（退出码 3）· 连续不可达 ${n} 轮`);
    for (const t of ch.tried) log(`    · ${t.channel}（${t.target}）：${t.err}`);
    // 【R9】短租为什么没救回来（可核事实；关掉总开关时这里会写明来源）
    if (ch.rent?.skipped) log(`    · 按需短租：**跳过**（${ch.rent.skipped}${ch.rent.switchReason ? ' · ' + ch.rent.switchReason : ''}${ch.rent.note ? ' · ' + ch.rent.note : ''}）`);
    else if (ch.rent?.rolledBack) log('    · 按需短租：开起来了但仍不通 ⇒ 已回滚（relay-cli down）');
    state.lastRunAt = new Date().toISOString();
    state.lastResult = 'unreachable';
    // 【B 段】达阈 ⇒ 出声（写进**同一个** state 对象 + 既有 alert 通道；dry-run 两样都不做）
    await checkUnreachableAlert(state, n, ch.tried);
    if (!OPT.dryRun) writeStateAtomic(state);
    return 3;
  }
  log(ch.channel === 'tunnel'
    ? `  ⓘ 通道：**VPS 中继隧道回落**（${ch.target}${ch.via ? ' · 来源 ' + ch.via : ''}）—— 局域网不可达${ch.rented ? '（**本轮按需短租**：收尾立刻 down）' : ''}`
    : `  ⓘ 通道：局域网直连（${ch.target}）`);
  // 择路顺序 = **可核事实**（成功路径也把失败过的候选打出来，否则"先 lan 后 tunnel"无从取证）
  for (const t of ch.tried) log(`    · 已试 ${t.channel}（${t.target}）：${t.err}`);
  markChannel(state);   // 本轮通道落到状态文件（**所有"可达"出口**都带 —— 见 markChannel 注释）
  // 【M4】探活成功 ⇒ 连续不可达**归零** + 清"已出声"记录（落盘发生在下方各"可达"分支 —— dry-run 不写盘 ⇒ 磁盘计数不动）
  clearUnreachable(state);

  // 2) 扫描 + 比对
  const files = scan();
  const changed = files.filter((f) => {
    if (OPT.full) return true;
    const p = state.files[f.rel];
    return !p || p.size !== f.size || p.mtimeMs !== f.mtimeMs;
  });
  const todo = OPT.limit > 0 ? changed.slice(0, OPT.limit) : changed;
  const todoBytes = todo.reduce((n, f) => n + f.size, 0);

  log('── 会话异地镜像（主机 A → mirror-host）────────────────');
  log(`  本地扫描 ${files.length} 个文件 / ${MB(files.reduce((n, f) => n + f.size, 0)).toFixed(1)} MB`);
  log(`  本轮变化 ${changed.length} 个 / ${MB(changed.reduce((n, f) => n + f.size, 0)).toFixed(1)} MB${OPT.limit ? `（--limit ${OPT.limit} 截断为 ${todo.length}）` : ''}`);

  if (!todo.length) {
    log('  ✅ 无需传输（幂等：本地状态与文件一致）');
    state.lastRunAt = new Date().toISOString();
    state.lastResult = 'ok';
    state.lastRun = { scanned: files.length, changed: 0, pushed: 0, bytes: 0, elapsedMs: 0 };
    if (!OPT.dryRun) writeStateAtomic(state);
    return 0;
  }
  // 2.5) M3 · 空壳不得覆盖完整版（R4）：源会话判空壳 **且** 远端那份是完整版（更大）⇒ 拒绝覆盖 + 记账。
  //      判据与仓2 侧**同源**（唯一来源 = `dsh-butler\lib\shell-session-watch.mjs`，本脚本不自造口径）；
  //      远端大小探测失败 / 未知 ⇒ 保守拒绝（宁可少覆盖、不可丢内容）。
  const guard = await guardShellOverwrite(todo, { probeRemote: probeRemoteSessionSize });
  for (const line of renderShellGuardLines(guard)) log(line);
  const todoSend = guard.blockedCount ? todo.filter((f) => !guard.blockedRels.has(f.rel)) : todo;
  const guardRecord = guard.candidates ? {
    at: new Date().toISOString(),
    candidates: guard.candidates,
    blocked: guard.blockedCount,
    allowed: guard.allowedCount,
    conservativeAllBlocked: guard.conservativeAllBlocked === true,
    blockedItems: guard.blocked.map((b) => ({ rel: b.rel, localBytes: b.localBytes, remoteBytes: b.remoteBytes, reason: b.reason, mismatch: b.mismatch === true })),
  } : null;
  if (guard.blockedCount) {
    // 记账（可被人看见）：审计流水 `~\.dsh\butler-audit\YYYY-MM.jsonl`（best-effort，失败不改 exit code）
    try {
      const { appendAudit } = await loadButlerLib();
      appendAudit({ type: 'session-mirror-shell-guard', host: HOST, remoteRoot: REMOTE_ROOT, candidates: guard.candidates, blocked: guard.blocked }, { home: DSH });
    } catch (e) { log(`   ⚠️ 守卫审计写入失败（不改变 exit code）：${e?.message ?? e}`); }
  }

  if (!todoSend.length) {
    log('  🛡 本轮待推送文件**全部**被空壳守卫拒绝 ⇒ 不传输（远端完整版保持不变）');
    state.lastRunAt = new Date().toISOString();
    state.lastResult = 'ok';
    state.lastRun = { scanned: files.length, changed: changed.length, pushed: 0, bytes: 0, elapsedMs: 0, shellGuard: guardRecord };
    if (!OPT.dryRun) writeStateAtomic(state);
    return 0;
  }
  if (OPT.dryRun) {
    log(`  [dry-run] 将传输${guard.blockedCount ? `（另有 ${guard.blockedCount} 个被空壳守卫拒绝，见上）` : ''}：`);
    for (const f of todoSend.slice(0, 20)) log(`    ${MB(f.size).toFixed(2)} MB  ${f.rel}`);
    if (todoSend.length > 20) log(`    … 其余 ${todoSend.length - 20} 个`);
    return 0;
  }

  // 3) 远端目录准备（只建目录，不删任何东西）
  const remoteDsh = REMOTE_ROOT.replace(/\//g, '\\');
  const remoteTmp = `${remoteDsh}\\_tmp`;
  const prep = ssh(`if not exist "${remoteDsh}" mkdir "${remoteDsh}" & if not exist "${remoteTmp}" mkdir "${remoteTmp}"`);
  const prepChk = ssh(`if exist "${remoteTmp}" echo tmp-ready`);
  if (!prepChk.out.includes('tmp-ready')) {
    process.stderr.write(`远端目录准备失败：prep=${prep.out} ${prep.err}\n`);
    return 1;
  }
  // 【S3 · 第二柱】§3.2 取样点①：**既有位置**（只在本轮有待推文件时执行，不改推送主链）——
  //   由"只 log 一个字符串"升级为"结构化读数 + 判 level + 阈值告警 + 落状态字段"。
  const spaceVol = REMOTE_ROOT.slice(0, 2).replace('/', '');
  const space = sampleRemoteSpace(spaceVol, { prev: state.remoteSpace ?? null, now: Date.now() });
  state.remoteSpace = space.field;   // §3.4 通道②（状态字段）；本轮各出口的 writeStateAtomic 会带上它
  log(`  远端盘空间：${space.field.freeBytes === null
    ? '取不到（level=unknown，不告警）'
    : '可用 ' + fmtGiB(space.field.freeBytes) + ' GiB（level=' + space.field.level + '）'}`);
  await emitSpaceAlert(space.decision.escalate);

  // 4) 分批 tar + scp + 远端解压
  // 【2026-10-12 卡·镜像通道根治】批次约束多一条 argv 长度：
  //   传输改用**命令行参数**（见下方 tar 调用处的编码坑说明）⇒ 必须防 Windows 命令行上限（~32K 字符）。
  const ARGV_BUDGET = 26_000;
  const batchLimit = Math.max(1, OPT.batchMb) * 1048576;
  const batches = [];
  let cur = [], curBytes = 0, curArgv = 0;
  for (const f of todoSend) {
    const cost = f.rel.length + 3;
    if (cur.length && (curBytes + f.size > batchLimit || curArgv + cost > ARGV_BUDGET)) { batches.push(cur); cur = []; curBytes = 0; curArgv = 0; }
    cur.push(f); curBytes += f.size; curArgv += cost;
  }
  if (cur.length) batches.push(cur);

  fs.mkdirSync(TMP, { recursive: true });
  const startedAt = Date.now();
  let pushedFiles = 0, pushedBytes = 0;
  const failed = [];

  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    const tarFile = path.join(TMP, `batch-${i}.tar`);
    // 留痕（排障用）；⚠️ **不再**用 `-T <list>` 传成员路径 —— 见下条：
    //   Windows 自带 bsdtar 读 `-T` 列表时按**本地 ANSI** 解码 ⇒ UTF-8 的**中文附件名**会被误解、整批
    //   报 `Couldn't visit directory`（2026-10-12 实测：`-T`+中文 rc=1 / 命令行参数 rc=0）。命令行走 node
    //   的宽字符 argv ⇒ 中文名正常。⇒ 成员路径一律**命令行参数**（已由上方 ARGV_BUDGET 约束批长）。
    fs.writeFileSync(path.join(TMP, `list-${i}.txt`), b.map((f) => f.rel).join('\n') + '\n', 'utf8');

    const t = run('tar', ['-cf', tarFile, '-C', DSH, ...b.map((f) => f.rel)]);
    if (!t.ok) { failed.push({ batch: i, stage: 'tar', err: t.err || t.out }); continue; }

    const remoteTar = `${remoteTmp}\\batch-${i}.tar`;
    const up = run('scp', ['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-i', KEY, tarFile, `${HOST}:${REMOTE_ROOT}/_tmp/batch-${i}.tar`]);
    if (!up.ok) { failed.push({ batch: i, stage: 'scp', err: up.err || up.out }); continue; }

    // cmd 的 `%errorlevel%` 在整行解析时就展开（拿到的是 tar 之前的值），故用 `&&` 串：
    // tar 真失败 ⇒ echo 不执行 ⇒ 输出里没有 extract-ok ⇒ 本地判失败。
    const ex = ssh(`tar -xf "${remoteTar}" -C "${remoteDsh}" && echo extract-ok`);
    if (!ex.ok || !ex.out.includes('extract-ok')) { failed.push({ batch: i, stage: 'extract', err: `${ex.out} ${ex.err}`.trim() }); continue; }

    const now = new Date().toISOString();
    for (const f of b) {
      state.files[f.rel] = { size: f.size, mtimeMs: f.mtimeMs, pushedAt: now };
      pushedFiles++; pushedBytes += f.size;
    }
    log(`  [${i + 1}/${batches.length}] 传 ${b.length} 个 / ${MB(b.reduce((n, f) => n + f.size, 0)).toFixed(1)} MB ✅`);
  }

  // 远端临时 tar 清理（不动已解压的镜像内容）
  ssh(`del /q "${remoteTmp}\\*.tar"`);

  const elapsedMs = Date.now() - startedAt;
  state.lastRunAt = new Date().toISOString();
  state.host = os.hostname();
  state.target = `${HOST}:${REMOTE_ROOT}`;   // 本轮通道由 markChannel 统一落（唯一落点，防两处口径漂移）
  state.lastResult = failed.length ? 'partial' : 'ok';
  state.lastRun = { scanned: files.length, changed: changed.length, pushed: pushedFiles, bytes: pushedBytes, elapsedMs, failed: failed.length, shellGuard: guardRecord };
  writeStateAtomic(state);

  log('');
  log(`  已传 ${pushedFiles} 个 / ${MB(pushedBytes).toFixed(1)} MB / 耗时 ${(elapsedMs / 1000).toFixed(1)}s${failed.length ? ` · ❌ 失败批 ${failed.length}` : ''}`);
  log(`  状态文件 ${STATE}`);
  for (const f of failed) log(`    ❌ 批 ${f.batch} ${f.stage}: ${String(f.err).slice(0, 200)}`);

  if (OPT.verify > 0) {
    log('');
    log(`── 抽样核对 sha256（${Math.min(OPT.verify, todoSend.length)} 个）──`);
    const sample = todoSend.slice(0, OPT.verify);
    let okN = 0, badN = 0;
    for (const f of sample) {
      const local = sha16(f.abs);
      const rpath = `${remoteDsh}\\${f.rel.replace(/\//g, '\\')}`;
      const r = ssh(`certutil -hashfile "${rpath}" SHA256`);
      // ⚠️ 不能对整段输出直接抓 64 位 hex：certutil 第一行是 `SHA256 hash of <路径>`，
      //    而附件文件名本身就是 64 位 hex（按内容 sha256 命名）⇒ 会抓错行、误报"不一致"。
      //    只认「整行就是 64 位 hex」的那一行。
      const hexLine = r.out.split(/\r?\n/).map((l) => l.trim()).find((l) => /^[0-9a-fA-F]{64}$/.test(l));
      const remote = hexLine ? hexLine.toLowerCase().slice(0, 16) : null;
      if (remote === local) { okN++; log(`  ✅ ${f.rel}`); }
      else { badN++; log(`  ❌ ${f.rel}  本地=${local} 远端=${remote ?? '(取不到)'}`); }
    }
    log(`  抽样结果：一致 ${okN} / 不一致 ${badN}`);
    if (badN) state.lastResult = 'verify-failed';
  }

  // 清理本地临时件
  try { rmGuarded(TMP, { label: 'mirror-tmp', reason: '推送收尾：清整棵本地临时目录' }); } catch { }

  if (OPT.json) process.stdout.write('---JSON---\n' + JSON.stringify({ result: state.lastResult, consecutiveUnreachable: Number(state[UNREACHABLE_KEY] ?? 0), scanned: files.length, changed: changed.length, pushed: pushedFiles, bytes: pushedBytes, elapsedMs, failed, shellGuard: guardRecord }, null, 2) + '\n');
  return failed.length ? 1 : 0;
}

process.exitCode = await main();
