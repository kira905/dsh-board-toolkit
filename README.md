# dsh-board-toolkit · DSH 看板与会话运维工具集

> 三十个零依赖命令行小件：**看板卡**（建卡 / 查重 / 起卡 / 验收 / 归档 / 并回 / 快照 / 趋势）、**会话**（按卡归档、索引导出与元数据回填、索引缓存瘦身与恢复）、**会话异地镜像**。
> 全部走宿主 HTTP API 或只读文件，**批量写操作默认 dry-run**，真写必须显式 `--apply`。

## 这是什么 · 给谁用

DSH（DeepSeek Harness）把「任务卡」做成了真会话：一张卡 = 一条待办 + 一次独立执行。
本仓库把这些日常动作做成可以脚本化、可以进 CI、可以被另一个 agent 调用的命令行件：

- **人**：想看板面之外的东西（趋势、归一化率、归档前后一致性）；
- **脚本 / agent**：想在一个无人值守的夜里批量归档、批量回填、批量并回，并且**每一步都能回滚**；
- **排障**：想在一分钟内回答「这张卡为什么卡住了」「这个会话到底是死是活」「归档端点为什么 403」。

设计前提：**账本是宿主（Host）的，不是脚本的**。所有写动作要么走 Host API，要么在本地文件上做「备份 → 改 → 校验 → 可回滚」三段式。

## 零依赖 · 怎么跑

需要 Node.js **≥ 22**（用到 `AbortSignal.timeout`、多帧 zstd 解压等）。没有第三方依赖，不需要 `npm install` 之前的网络。

```bash
git clone https://github.com/kira905/dsh-board-toolkit.git
cd dsh-board-toolkit
node board-card.mjs status --line "主线名"
```

安装成全局命令（可选，会得到 `board-status` / `board-card-run` 等短名）：

```bash
npm install -g @kira905/dsh-board-toolkit
board-status <cardId>
```

也可以直接 `npx -p @kira905/dsh-board-toolkit board-dup-check --kw 归档`。

> ⚠️ **本仓 CLI 没有实现 `--help`**：未识别的参数会被忽略、脚本**直接执行**（例如 `board-snapshot-export.mjs --help` 会真的导出一份快照）。请照下面每件用途表给的参数调用，不要用 `--help` 试探。

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_WORKSPACE` | **工作区根**（放 `docs/ tools/ _archive/ logs/` 的那棵树） | `~/DSH` |
| `DSH_HOME` | 宿主 home（放 `sessions/`、`task-board/ledger-v2.json` 等） | `~/.dsh` |
| `DSH_WEB_URL` / `DSH_BOARD_BASE` / `DSH_BOARD_URL` | 宿主 HTTP 地址 | `http://localhost:3080` |
| `DSH_MIRROR_HOST` / `DSH_MIRROR_ROOT` | 异地镜像的目标主机与镜像根 | `mirror@example-host` / `~/dsh-session-mirror/local/.dsh` |
| `DSH_OFFSYNC_ROOT` / `SYNCED_SESSIONS_REPO` | 跨机同步根 / 仓2 会话落地区 | `<workspace 同级>/DSH-offsync` 下 |
| `BOARD_UPSTREAM_SRC` / `BOARD_PLUGIN_SRC` | 上游看板包 `src` 与本地看板插件 `src`（两个比对类工具必需） | 无（不设则报错退出 2） |
| `PROJCACHE_PRUNE_SNAPSHOT` | `projcache-restore` 的默认来源快照 | 无（须 `--from`） |

> 本发行版**不内置任何机器专属路径**；拿不到配置时宁可报错退出，也不静默落到某个磁盘。

## 目录结构

```
.
├── board-*.mjs                 看板 11 件（根目录，见下表）
├── archive-*.mjs               归档 3 件
├── projcache-*.mjs             会话索引缓存 2 件
├── dsh-session-mirror.mjs      会话异地镜像 1 件
├── board-ops/                  盯卡运维 9 件（含一份子 README）
├── board-tools/                只读/写动作 4 件（含一份子 README）
└── lib/                        依赖闭包（RPC 客户端、归档视图、生产闸、zstd 帧、主机短码…）
```

## 逐件用途表

### 看板（根目录 11 件）

| 文件 | 一行用途 | 典型用法 |
|---|---|---|
| `board-card.mjs` | 单卡操作：查状态 / 起卡 / 验收 / 打回 / 移列 | `node board-card.mjs status --line "主线名"` |
| `board-card-add.mjs` | 建卡（内置 DoR 模板与字段校验） | `node board-card-add.mjs --title "…" --prompt p.md` |
| `board-dup-check.mjs` | 建卡前查重（扫全量，含归档卡） | `node board-dup-check.mjs --kw 归档 --deep` |
| `board-archive-bulk.mjs` | 批量归档已完成的卡（可生成回滚脚本） | `node board-archive-bulk.mjs --apply --emit-restore` |
| `board-archive-line.mjs` | 按主线整条归档（可生成逐卡回滚脚本 + 桌面入口） | `node board-archive-line.mjs --line "…" --apply` |
| `board-line-backfill.mjs` | 批量回填卡的主线 / 节点字段（映射文件驱动） | `node board-line-backfill.mjs --map map.json --apply` |
| `board-merge.mjs` | 把异地快照并回本机账本（含 line/seq 合法性门） | `node board-merge.mjs --snapshot snap.json --dry-run` |
| `board-snapshot-export.mjs` | 导出看板快照（含主机名与时间戳，另带敏感串自检） | `node board-snapshot-export.mjs --label depart` |
| `board-j1b-trend.mjs` | 复算看板体量趋势判据（斜率 / 阈值告警） | `node board-j1b-trend.mjs --days 30` |
| `board-selfdev-ratio.mjs` | 量化「自研程度」：与上游看板包逐行比对 | `BOARD_UPSTREAM_SRC=… BOARD_PLUGIN_SRC=… node board-selfdev-ratio.mjs` |
| `board-upstream-symbol-gate.mjs` | 符号门：上游独有 import 在宿主主包闭包里是否真能解析 | `node board-upstream-symbol-gate.mjs` |

### 归档与索引（5 件）

| 文件 | 一行用途 | 典型用法 |
|---|---|---|
| `archive-card-sessions.mjs` | 把「看板卡触发的执行会话」中超 N 小时不活跃的搬进归档区 | `node archive-card-sessions.mjs --hours=24` |
| `archive-index-export.mjs` | 导出归档区索引（按主机短码落 JSON） | `node archive-index-export.mjs --top 20` |
| `archive-meta-backfill.mjs` | 归档元数据回填：库表 ↔ 归档目录对账（孤儿 / 缺档） | `node archive-meta-backfill.mjs --dry-run` |
| `projcache-prune.mjs` | 会话索引缓存瘦身（先备份、后裁剪、可回滚） | `node projcache-prune.mjs --dry-run` |
| `projcache-restore-archived.mjs` | 从历史备份里把「已归档会话」的记录合并回来 | `node projcache-restore-archived.mjs --from snap.before` |

### 会话异地镜像（1 件）

| 文件 | 一行用途 | 典型用法 |
|---|---|---|
| `dsh-session-mirror.mjs` | 会话与附件增量镜像到对端主机（只增不删、带空壳守卫与远端盘告警） | `node dsh-session-mirror.mjs --dry-run`（默认即 dry-run） |

### `board-ops/` · 盯卡运维 9 件

| 文件 | 一行用途 |
|---|---|
| `board-ops/board-status.mjs` | 看板总览（在板 / 归档 / 状态分布 / 主线分组） |
| `board-ops/panel-fetch.mjs` | 面板与归档端点取证：三组对照（裸 / 只带同源栅栏头 / 带 cookie），给状态码 · 字段名 · 体积 · 耗时 |
| `board-ops/card-state.mjs` | 单卡状态 + 执行记录 + 交付报告 |
| `board-ops/card-prompt.mjs` | 打印单卡的 title / status / description / prompt（只读） |
| `board-ops/card-run.mjs` | 起卡（run / rerun），**`--apply` 才真执行** |
| `board-ops/card-action.mjs` | confirm / reject / move / archive / restore / delete，**`--apply` 才真写** |
| `board-ops/card-note.mjs` | 往卡 description 追加留痕（幂等） |
| `board-ops/session-state.mjs` | 会话存活判据（防「假结算」）/ 找在跑的会话 |
| `board-ops/session-tail.mjs` | 读会话 `jsonl.zstd` 尾部（多帧解压；排障用） |
| `board-ops/_test/test-session-tail-v3.mjs` | `session-tail` 的 v3 文件名世代自测（退出码 0 = 全绿） |

### `board-tools/` · 短小四件

| 文件 | 一行用途 |
|---|---|
| `board-tools/board-status-brief.mjs` | 极简总览：现役主线 + 全部非 done 在途卡 |
| `board-tools/board-card-status.mjs` | 单卡速查（status + 末两条执行 + 执行会话是否在跑） |
| `board-tools/board-card-dump.mjs` | dump 卡的 title / description / prompt 全文 |
| `board-tools/board-act.mjs` | 写动作 run / confirm / reject / move（`--card` 建议给完整 uuid） |

### `lib/` · 依赖闭包（不单独发命令，但可 import）

`dsh-rpc-client`（宿主 HTTP RPC 客户端，端点表 + 新旧双栈回落）、`dsh-home` / `workspace`（home 与工作区根解析）、`archive-meta-store` / `projcache-read` / `session-file-name` / `zstd-frames`（归档与索引读取）、`board-archive-view` / `board-j1-limits`（看板判据）、`production-guard` / `deploy-guard` / `bypass-ledger`（生产路径闸与放行台账）、`redact`（敏感串脱敏）、`host-tag`（主机短码）、`peer-channel` / `remote-space` / `sync-topology` / `shell-session-watch` / `watch-events` / `pitfall-*`（镜像与跨机同步）。

## 与 DSH 的集成点

| 集成点 | 走什么 | 说明 |
|---|---|---|
| 看板读写 | `POST/GET /api/task-board/*` | 账本 `ledger-v2.json` 归宿主所有，**脚本永不直接改它** |
| 宿主 RPC | `/api/<ns>/<method>`（`lib/dsh-rpc-client.mjs`） | cookie 三路注入：显式参数 / `DSH_RPC_COOKIE_SECRET` / 宿主本机凭据件（公开环境不存在 ⇒ 无凭据，不静默改变行为） |
| 会话文件 | `<DSH_HOME>/sessions/**`（`session.v3.jsonl.zstd`） | 文件名由 `lib/session-file-name.mjs` 统一解析，**不写死世代名** |
| 归档区 | `<DSH_HOME>/_archived-sessions/**` | 卡会话在 `cards/<批次>/`、主线在 `<批次>/`，两层都要扫 |
| 回滚点 | `<DSH_WORKSPACE>/_archive/<任务>-<时间戳>/` | 写动作 `--emit-restore` 会生成 `before.json` + 逐卡恢复脚本 + 桌面 `.cmd` |

## 安全边界（重要）

1. **默认 dry-run**：所有批量写操作（归档 / 回填 / 起卡 / 验收 / 删卡）不传 `--apply` 只打印计划。
2. **生产路径闸**：`lib/production-guard.mjs` 对「生产树」做逻辑路径 + realpath 双侧判定（junction 场景下只判一边必然失效）。
3. **只读优先**：`board-status` / `card-state` / `session-tail` / `panel-fetch` / `board-j1b-trend --no-sample` 等只读；自检（`--self-test` / `--selftest`）不读也不写生产账本。
4. **不删除历史**：镜像与归档都「只增不删」；本机删除面集中在 `%TEMP%` 与显式 `--apply` 的归档动作。
5. **凭据**：本仓库**不含任何凭据读取件**（宿主专有的凭据解析件不随仓发布）。需要鉴权的调用由环境变量或调用方显式注入。

## 版本与许可

- 版本：`CHANGELOG.md`；当前 `v0.1.0`（首批拆仓）。
- 许可：**AGPL-3.0 + 商业授权**（双许可）——要么按 AGPL-3.0 使用并开源你的衍生作品，要么购买商业授权。详见 `LICENSE` 与下方「License / 商业授权」段。
- 上游：DSH（DeepSeek Harness）本身另有其许可，本仓库只包含自研的命令行件。

## License / 商业授权

This project is dual-licensed.

1. **Open source**: GNU Affero General Public License v3.0 (see `LICENSE`).
   You may use, modify and distribute this software under AGPL-3.0, provided that
   derivative works are also released under AGPL-3.0 (including when offered over a network).

2. **Commercial license**: If you want to use this software in a closed-source product,
   or you cannot comply with AGPL-3.0, a commercial license is available.
   Contact the author to obtain one.

本项目采用**双许可**：开源使用请遵循 `LICENSE` 中的 AGPL-3.0（衍生作品需同样开源，含网络提供服务的情形）；
如需闭源商用或不适用 AGPL-3.0，请联系作者取得**商业授权**。
