# board-ops · 看板卡操作工具集（主会话盯卡专用）

> 2026-09-15 建（主人「做成工具吧」）。来源 = 全家桶线 A1/A9 验收过程中现场造的一批脚本，规范化后归位到 `tools\`（原来散在 `<workspace>\_tmp\`，会被归档清理）。

## 0. 先分清「通知」与「工具」

**大管家通知（queue job）负责"什么时候该动手"**——卡进 `review` 时把消息投给绑定的发起会话（空闲即时投、在跑排队、滞留 30 分钟升级）。**别用后台轮询**（会被重启连坐杀掉）。

**但它不做四件事**，这正是本工具集存在的理由：

| 工具 | 补哪件事 |
|---|---|
| `session-state.mjs` | **验收判据②**：执行会话真结束了吗（防"假结算"）|
| `session-tail.mjs` | **排障**：为什么中断/卡住（通知不说原因）|
| `card-run.mjs` / `card-action.mjs` | 起卡、confirm/reject（大管家只提醒，不代跑不代验收）|
| `card-note.mjs` | 把验收结论/拍板结论写回卡（账本留痕）|

一句话：**通知是门铃，这些工具是验货的尺子、账本和螺丝刀。**

## 1. 工具速查

| 脚本 | 干什么 | 关键参数 |
|---|---|---|
| `board-status.mjs` | 看板总览（在板/归档/状态分布/主线分组）| `--line "<主线>"` · `--archived N` · `--json` |
| `panel-fetch.mjs` | **面板/归档端点取证**（大管家 state / 归档 list / 看板 archive）：自动取 cookie（日志 token，兜底密钥自签）+ **三组对照**（裸 / 只同源头 / 带 cookie）⇒ 给状态码·字段名·体积·耗时·成因判读 | `--base URL` · `--log FILE` · `--no-bare` · `--json` · 只读 |
| `card-state.mjs` | 单卡状态 + executions + 交付报告 | `--report N` · `--full` · `--json` |
| `card-run.mjs` | 起卡（run / rerun）| `--rerun` · **`--apply`** |
| `card-action.mjs` | confirm / reject / move / archive / restore / delete | `--status backlog\|todo\|done` · `--note "..."` · **`--apply`** |
| `card-note.mjs` | 往卡 description 追加留痕（幂等）| `--card` `--mark` `--file\|--text` · **`--apply`** |
| `session-state.mjs` | 会话存活（判据②）/ 找 running 会话 | `<sid...>` · `--all` · `--find <词>` · `--json` |
| `session-tail.mjs` | 读会话 jsonl.zstd 尾部（多帧 zstd）| `<sid>` · `--lines` · `--grep <文本>` · `--raw` |

全部：`node <脚本> --help` 看用法；`--base-url` 可指到别的实例（默认 `http://localhost:3080`，本机**一律用 localhost**，别用 127.0.0.1）。
> ⚠️ **订正注（2026-10-09 · 会话 `<session>` · 只标注不改原文；真源 = `docs\交付报告-冲刺600-取证通道-20261009.md` §7#3）**：上面「本机一律用 localhost」这句**与 2026-10-09 实测相反** —— 本机 API 走 `localhost` 比 `127.0.0.1` **慢约 70 倍**（4359ms vs 62ms，纯主机名解析开销）⇒ **命令行/脚本调本机 API 一律用 `127.0.0.1`**（`panel-fetch.mjs` 已按此写死默认）。**例外**：浏览器访问（BrowserSkill 那条口径）仍走 `localhost`，语境不同、不冲突。`board-status.mjs:25` 现在会把 `127.0.0.1` 主动替换回 `localhost`（属"改别的工具行为"，未在本卡顺手改，待主人定）。
**写操作一律默认 dry-run，必须显式 `--apply`。**

## 2. 标准盯卡循环

```powershell
$T = '<workspace>\tools\board-ops'   # ⚠️ 别再定义 $t —— PowerShell 变量名**不分大小写**，$t 会覆盖 $T（2026-09-15 实测踩到：changelog 文本把 `$T\card-run.mjs` 污染成诡异路径）
# ① 起卡 + 立刻绑定（不绑定 → 通知退化到猜标题、多【运行】会话时静默）
node $T\card-run.mjs <卡id> --apply
node <workspace>\tools\dsh-butler\butler-bind-card.mjs --card <卡id> --session auto
# ② 等大管家通知（不要轮询）
# ③ 通知到 → 双判据
node $T\card-state.mjs <卡id>            # 判据①：status 是否 review + executions 末条
node $T\session-state.mjs <执行会话id>   # 判据②：必须是【完整 sid】且命中 ⇒ running 必须 false
#   ⚠️ 传 8 位短前缀【不会命中】：2026-09-24 起该工具不再把"未命中"写成"已结束"，改为
#      `MISSING …（未精确命中 · 弱判据：不代表已结束）`，唯一前缀命中时还会回显完整 sid。
#      判据②方向：**未命中 ≠ 已结束**（会话表是窗口制）；只有短前缀时请用 tools\board-tools\board-card-status.mjs。
# ④ 独立复核（不读卡内自述）：产物/远端/单测/演练亲手验
# ⑤ 结论留痕 + 结案
node $T\card-note.mjs --card <卡id> --mark "【主会话验收结论】**" --file verdict.md --apply
node $T\card-action.mjs <卡id> confirm --apply
# 异常排查
node $T\session-tail.mjs <执行会话id> --grep aborted --raw
```

## 2.5 验收比对四条坑（2026-09-23 回写批 11 张实战踩出 · 血泪）

| # | 坑 | 正确姿势 |
|---|---|---|
| 1 | **猜 manifest 字段名 ⇒ 假通过** | 每张卡的回滚点 `manifest.json` **schema 各不相同**（数组名 `files[]`/`after[]`/`items[]`/`before[]`；字段名 `rel`/`relPath`/`target`/`livePath` 各异）。猜字段名会取到 `$null`，而 **`$null -eq $null` = True** ⇒ 脚本照样打印「MATCH 删除=0 新增=0」的**假绿**。**先 dump 一条条目、认准字段名，再写循环** |
| 2 | **比对前不验空** | 循环体内先断言两侧非空（`if (-not $LiveHash -or -not $WantHash){'字段缺失';return}`），diff 前先 `Test-Path` 备份副本。否则"全绿"实际一份都没比 |
| 3 | **PS 变量名不分大小写** | `$r`（比对结果）会**覆盖** `$R`（回滚点根路径）⇒ 之后所有路径拼接错乱（报「找不到路径 未改·一致\before\…」）。复核脚本一律用多字名：`$RollbackDir` / `$LiveHash` / `$Verdict` / `$TargetPath` |
| 4 | **基线会过期 ⇒ drill 复跑报红先归因** | ① 落点是**自动重生成文件**（如 `docs\坑库\*-<host>.md` 每轮 tick 重渲染页眉/score）② 或**后卡改了前卡落点**。这两种"红"都不是卡不合格。归因方法：拿"卡自称结果 + 其运行时间线 + 相关文件 mtime/状态文件 mtime"三方对表（实例：`butler-pitfall-scan.json` 与目标 md **同秒 mtime** ⇒ 判定 tickd 重渲染） |

> 推论：**回滚要逆序**（后卡改了前卡落点 ⇒ 前卡回滚器 fail-closed 拒绝，先回滚新卡再回旧卡）；**「原文零抹除」的最强证据 = `Compare-Object` 的删除行数为 0**（若曾把两行拼一行再修回，会表现为"删 2 增 1"，据此也能抓出残留）。

## 3. 红线

1. **绝不直接编辑 `ledger-v2.json`**——一律走 Host HTTP API（本工具集全走 API）。
2. `move` 只能到 `backlog/todo/done`；`review` 走 confirm/reject（手移会被拒 `invalid manual status`）。
3. 起卡后**必须绑定**发起会话（`butler-bind-card.mjs --session auto`）。
4. 卡执行会话收尾标【完成】（`session-mark.mjs --done`），别标【待续】。
5. Node 脚本收尾用 `process.exitCode`，**禁用 `process.exit()`**（undici/libuv 断言坑）；本目录脚本已全部遵守。
