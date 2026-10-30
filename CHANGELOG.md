# CHANGELOG

## v0.1.1 — 2026-10-30

- `board-ops/card-prompt.mjs`：注释去掉内部批次编号（「2026-10-10 多端线第 12 棒起」→「2026-10 起」），行为不变。
- 脱敏扫描（含注入的私有标识词表）待复核 = 0。

*English: internal batch numbering removed from one comment; no behaviour change.*

## v0.1.0 — 2026-10-19

首个公开版本（从私有工具树拆仓发布）。

### 包含

- **看板 11 件**：`board-card` / `board-card-add` / `board-dup-check` / `board-archive-bulk` /
  `board-archive-line` / `board-line-backfill` / `board-merge` / `board-snapshot-export` /
  `board-j1b-trend` / `board-selfdev-ratio` / `board-upstream-symbol-gate`
- **归档与索引 5 件**：`archive-card-sessions` / `archive-index-export` / `archive-meta-backfill` /
  `projcache-prune` / `projcache-restore-archived`
- **会话异地镜像 1 件**：`dsh-session-mirror`
- **盯卡运维 9 件**（`board-ops/`）与**短小四件**（`board-tools/`）
- **依赖闭包**（`lib/`）：宿主 RPC 客户端（端点表 + 双栈回落）、home/工作区解析、归档读取、
  生产路径闸、（多帧）zstd 解码、主机短码、镜像与跨机同步判据

### 口径

- 全部命令**零第三方依赖**，Node.js ≥ 22。
- 批量写操作**默认 dry-run**，真写须 `--apply`；带 `--emit-restore` 的动作会生成 `before.json`
  ＋逐卡回滚脚本＋桌面 `.cmd`。
- **不内置任何机器专属路径**：工作区 / 镜像目标 / 比对源目录一律走环境变量，缺配置即报错退出。
- **不随仓发布宿主凭据解析件**：需要鉴权的调用由 `DSH_RPC_COOKIE_SECRET` 或调用方显式注入 cookie。

### 已知限制

- `board-selfdev-ratio` 与 `board-upstream-symbol-gate` 需要外部提供上游包 `src`（`BOARD_UPSTREAM_SRC`）；
  不给就退出 2，不会用内置路径猜。
- `dsh-session-mirror` 的默认目标主机是占位值 `mirror@example-host`，用前必须设 `DSH_MIRROR_HOST`。
- 依赖宿主主包闭包位置的工具（符号门）按 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh` 派生，
  非标准安装位置需自行改 `APPDATA`。
