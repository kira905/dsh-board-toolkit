# dsh-board-toolkit · board & session ops for DSH

> Thirty zero-dependency command-line tools for **task-board cards** (create, dedupe, run, accept,
> archive, merge, snapshot, trend), **sessions** (archive by card, index export, metadata backfill,
> projection-cache prune/restore) and **off-host session mirroring**.
> Every write path goes through the host HTTP API and defaults to **dry-run**; a real write needs an explicit `--apply`.

## What it is

DSH (DeepSeek Harness) turns a task card into a real session: one card = one todo + one isolated run.
This repo exposes the daily operations around that model as scriptable CLIs that a human, a cron job,
or another agent can drive — with rollback points generated on demand.

## Requirements

- Node.js **≥ 22**, no third-party dependencies (`git clone` and run).
- A running DSH host for the API-backed commands (default `http://localhost:3080`).

```bash
git clone https://github.com/kira905/dsh-board-toolkit.git
cd dsh-board-toolkit
node board-card.mjs --help
```

Global install (optional, gives short names such as `board-status`):

```bash
npm install -g @kira905/dsh-board-toolkit
board-status --help
```

## Environment

| Variable | Meaning | Default |
|---|---|---|
| `DSH_WORKSPACE` | workspace root (holds `docs/ tools/ _archive/ logs/`) | `~/DSH` |
| `DSH_HOME` | host home (holds `sessions/`, `task-board/ledger-v2.json`) | `~/.dsh` |
| `DSH_WEB_URL` / `DSH_BOARD_BASE` / `DSH_BOARD_URL` | host HTTP base | `http://localhost:3080` |
| `DSH_MIRROR_HOST` / `DSH_MIRROR_ROOT` | mirror target host / mirror root | `mirror@example-host` / `~/dsh-session-mirror/local/.dsh` |
| `DSH_OFFSYNC_ROOT` / `SYNCED_SESSIONS_REPO` | cross-host sync root / synced session drop | derived |
| `BOARD_UPSTREAM_SRC` / `BOARD_PLUGIN_SRC` | upstream board package `src` and local plugin `src` (required by the two comparison tools) | none |
| `PROJCACHE_PRUNE_SNAPSHOT` | default source snapshot for `projcache-restore` | none |

No machine-specific path is baked in: missing configuration fails loudly instead of silently
falling back to some disk location.

## Per-file purpose (the 19 shipped tools)

### Board

| File | Purpose |
|---|---|
| `board-card.mjs` | single-card ops: status / run / confirm / reject / move |
| `board-card-add.mjs` | create a card (DoR template + field validation) |
| `board-dup-check.mjs` | duplicate check before creating (scans archived cards too) |
| `board-archive-bulk.mjs` | bulk-archive finished cards, optional restore-script emission |
| `board-archive-line.mjs` | archive a whole line (mainline) with per-card rollback |
| `board-line-backfill.mjs` | backfill `line` / `seq` fields from a mapping file |
| `board-merge.mjs` | merge a remote snapshot back into the local ledger (with validity gate) |
| `board-snapshot-export.mjs` | export a board snapshot (host tag + timestamp, includes a secret self-test) |
| `board-j1b-trend.mjs` | recompute board growth trend (slope / threshold) |
| `board-selfdev-ratio.mjs` | quantify how much of the plugin is first-party (line-by-line vs upstream) |
| `board-upstream-symbol-gate.mjs` | symbol gate: can upstream-only imports really resolve in the host closure |

### Archive / index

| File | Purpose |
|---|---|
| `archive-card-sessions.mjs` | move card-triggered sessions idle > N hours into the archive area |
| `archive-index-export.mjs` | export the archive index as JSON per host tag |
| `archive-meta-backfill.mjs` | reconcile archive metadata store vs archive directory (orphans / gaps) |
| `projcache-prune.mjs` | prune the session projection cache with a rollback point |
| `projcache-restore-archived.mjs` | merge archived-session records back from a historical snapshot |

### Mirror / helper dirs

| File | Purpose |
|---|---|
| `dsh-session-mirror.mjs` | incremental off-host mirror of sessions and attachments (append-only) |
| `board-ops/*.mjs` | 9 watching/ops tools: overview, endpoint forensics, single-card state, prompt dump, run, confirm/reject/move/archive, note append, session liveness, session tail |
| `board-tools/*.mjs` | 4 short tools: brief overview, single-card check, card dump, write actions |
| `lib/*` | dependency closure: RPC client, home/workspace resolution, archive readers, production guard, zstd frames, host tag, mirror/sync helpers |

## Safety

1. **Dry-run by default** — every batch write prints a plan unless `--apply` is passed.
2. **Production guard** — `lib/production-guard.mjs` classifies targets by both logical path and
   `realpath` (junctions break one-sided checks).
3. **Read-only first** — status/report/forensics commands never write; `--self-test` paths never
   touch a live ledger.
4. **Append-only** — mirroring and archiving never delete history; local deletions are confined to
   `%TEMP%` and explicit `--apply` archive actions.
5. **No credentials** — the host-specific credential reader is deliberately excluded from this repo.

## License / Commercial license

Dual-licensed: **AGPL-3.0** (see `LICENSE`) or a **commercial license** for closed-source use.
Derivative works under AGPL-3.0 must stay open source, including when served over a network.
