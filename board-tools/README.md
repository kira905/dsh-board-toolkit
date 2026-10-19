# board-tools —— 看板卡操作四件套（走 Host HTTP API，绝不手改账本）

来源：2026-09-20 深夜从 `<workspace>\_tmp\` 收编（验收六包期间反复用到；`_tmp` 会被归档清理，故进 `tools\` 长期留用）。
统一口径：一律 `POST http://localhost:3080/api/task-board/*`（Host 权威账本），**永不直接改 `ledger-v2.json`**。
家规：这些脚本都发过 fetch ⇒ 收尾一律 `process.exitCode = await main()` 自然退出，**禁用 `process.exit()`**（Windows 上概率性 `0xC0000409`）。

| 脚本 | 用途 | 用法 | 退出码 |
|---|---|---|---|
| `board-status-brief.mjs` | 只读总览：现役主线汇总 + 全部非 done 在途卡 | `node board-status-brief.mjs` | 0 / 2 |
| `board-card-status.mjs` | 只读核一张卡：status + 末两条 executions + 执行会话是否在跑 | `node board-card-status.mjs <id前缀>` | 0 / 2 / 3 |
| `board-card-dump.mjs` | 只读 dump 卡的 title/description/prompt 全文 | `node board-card-dump.mjs <短id> [<短id>...]` | 0 / 2 |
| `board-act.mjs` | **写动作**：run / confirm / reject / move（建卡不在此件，见下） | `node board-act.mjs --card <完整id> --kind run [--note "..."]` | 0 / 1 / 2 / 3 |

## 注意

- `board-act.mjs --card` **优先给完整 uuid**：前缀命中多张卡会直接报错退出 3（早期版本会静默照登记错卡）。
- `move` 必须带 `--status`；`reject` 可带 `--note`（附在打回说明里）。
- **建卡走 `task-board` 技能**（Host API create），本目录只做「对已存在的卡动手」。
- 卡是「待验收」不等于活干完了：验收前先按 `task-board` 技能 §7.4 双判据核对（`status=review` **且**执行会话真结束）。
