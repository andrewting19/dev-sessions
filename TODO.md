# TODO — dev-sessions

## Completed

### Phase 1: Foundation ✅
- [x] TypeScript project scaffolding (package.json, tsconfig, vitest, build scripts)
- [x] Champion ID generation (LoL champion + role, e.g., `fizz-top`)
- [x] Session store (JSON file at `~/.dev-sessions/sessions.json`)
- [x] CLI skeleton with commander.js (all commands wired)

### Phase 2: Claude Code Backend ✅
- [x] `create` — tmux + `claude --session-id <uuid> --dangerously-skip-permissions`
- [x] `send` — base64-encoded tmux send-keys with CLI running verification
- [x] `kill`, `list` with dead session pruning
- [x] Transcript parsing: `~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl`
- [x] `last-message` — extract assistant text blocks from JSONL
- [x] `status` — infer idle/working/waiting_for_input (system-entry-aware)
- [x] `wait` — system-entry-based turn detection (reliable after 3 iterations of fixes)
- [x] `create` race fix — polls for transcript file existence before returning, so a fast `send` after `create` doesn't type into an unready TUI

### Phase 2b: Docker Gateway ✅
- [x] Thin HTTP relay gateway (`dev-sessions gateway --port <port>`)
- [x] CLI auto-detection: `DEV_SESSIONS_SANDBOX=1` → route through gateway
- [x] `HOST_PATH` mapping for transcript resolution
- [x] Fail fast when sandbox `/workspace` paths cannot be translated because `HOST_PATH` is missing
- [x] Gateway as subcommand (no separate install needed)
- [x] Gateway binary resolution — resolves path from `process.argv[1]`
- [x] Gateway request logging — requests logged for easier Docker debugging
- [x] Error message when gateway unreachable — includes URL + hint
- [x] Gateway binds to `127.0.0.1` only (security — was binding to all interfaces)
- [x] Real Docker E2E verified — all three paths:
  - Docker → Codex on host
  - Docker → Claude on host
  - Docker → Claude in Docker (`--mode docker`)

### Phase 3: Codex Backend ✅
- [x] Persistent `codex app-server` daemon (WebSocket, JSON-RPC 2.0)
- [x] One daemon, many threads — conversation continuity across sends
- [x] `create` auto-starts daemon if not running, calls `thread/start`
- [x] `send` connects via WebSocket, calls `turn/start`, waits for `turn/completed`
- [x] `wait`, `last-message`, `status` all work
- [x] `kill` archives thread, stops daemon when last Codex session killed
- [x] Daemon metadata at `~/.dev-sessions/codex-appserver.json`
- [x] `last-message` reads from `thread/read` RPC — persisted history across process restarts
- [x] `status`/`wait` reconcile with live app-server state via `thread/resume` — no longer trust stale store cache
- [x] `sessionExists()` verifies specific thread ID via `thread/list` — not just daemon liveness
- [x] Overlap guard — rejects `send` if `codexTurnInProgress` is already true, with clear error
- [x] `extractThreadRuntimeStatus` fixed — correctly parses Codex `ThreadStatus` enum JSON shape
- [x] Stale `lastTurnStatus: 'failed'` in store now reconciled against live thread before throwing
- [x] Fast-capture only returns `assistantText` when the early wait actually completes (not on timeout/partial deltas)
- [x] P0 fixes: timeout no longer poisons store with `interrupted`; `status()` always does live check against app-server; non-Error throws always trigger send cleanup
- [x] Codex `wait` now waits through multi-turn progress updates (loops until thread quiescence), scopes `turn/completed` to the target thread, and live-rechecks status when store state is stale
- [x] Codex `send`/`wait` now track the exact `turnId` from `turn/start`, so `wait` blocks on that turn's `turn/completed` notification instead of trusting false `thread/resume` idle/completed states during long tool execution on Codex 0.104.0
- [x] Codex exact-turn `wait` now reconciles `turn/completed` against `thread/read` before returning, which fixes false early completion on reconnect and lets `wait` recover when the completion notification was missed but the target turn is already terminal
- [x] Remove `yolo` mode — `native` is now always permissive (`--dangerously-skip-permissions`)

### Phase 4: Skills & Install ✅
- [x] `skills/` directory — multi-skill bundle (dev-sessions + handoff)
- [x] `install-skill` installs all skills at once (`--global`/`--local`, `--claude`/`--codex`, auto-detect)
- [x] `handoff` skill ported from claude-ting MCP → CLI

### Phase 5: Gateway Daemon ✅
- [x] `gateway install` — installs as macOS launchd service or Linux systemd unit
- [x] `gateway uninstall` — removes daemon and stops it
- [x] `gateway status` — shows whether daemon is running and on which port
- [x] Auto-starts on login; no manual `dev-sessions gateway` needed
- [x] Resolves node binary via `process.execPath` so launchd/systemd find it regardless of PATH/NVM

### clauded/Docker Integration ✅
- [x] `dev-sessions` CLI in `claude-ting/Dockerfile.ubuntu-dev`
- [x] `claude-docker` in zshrc passes `DEV_SESSIONS_GATEWAY_URL`
- [x] `~/.local/bin/clauded` wrapper script (was zsh-only function)
- [x] dev-sessions MCP stripped from claude-ting Dockerfile — CLI-based approach only
- [x] claude-ting docs updated with host setup instructions (gateway install, install-skill)

### Testing ✅
- [x] 126 automated tests (unit + integration) across 17 test files
- [x] Real E2E verified: Claude Code send→wait→last-message
- [x] Real E2E verified: Codex send→wait→last-message (PONG test)
- [x] Real E2E verified: Docker gateway relay

### Phase 6: Codex 0.139.0 + Goals ✅
- [x] Verified against codex-cli 0.139.0 (latest as of 2026-06-09) — live E2E: create/send/wait/last-message/status/logs/kill, including tool-executing turns
- [x] **Model default removed** — `gpt-5.3-codex` was hardcoded and is now rejected by the API (400 on ChatGPT accounts), silently breaking every new session. `model` is omitted from `thread/start`/`thread/resume` unless `create --model` is passed; legacy stored `gpt-5.3-codex` is dropped on send
- [x] `create --model <m>` flag
- [x] **Goal support** (Codex `/goal`, stable since 0.133.0): `goal <id> [objective] [--budget N] [--pause|--resume|--clear] [--json]` via `thread/goal/set|get|clear`; setting an objective implies `status: active` (otherwise a completed goal stays complete and nothing runs)
- [x] `wait <id> --goal` — blocks until the goal reaches a terminal state (complete/paused/blocked/usageLimited/budgetLimited); prints the status; exit 124 on timeout
- [x] `ask <id> <msg>` — one-shot send + wait + print-reply round trip
- [x] Gateway routes for goal (`GET/POST /goal`, `GET /wait?goal=1`) + gateway client methods
- [x] **Failed turns surface real errors** — `error` notifications (e.g. invalid model 400s) are captured live and used when `turn/completed` lacks detail; reconnecting `wait` detects the silent-failure pattern (turn persisted `completed` with no output + thread `systemError`) and reports failure with the thread error detail
- [x] tmux `sessionExists` treats "no server running" as `dead` (was `unknown`, which blocked pruning when the killed session was the last one on the server)
- [x] Live goal E2E: set → autonomous turn → complete; pause/resume/clear; second objective reactivates
- [x] `/tmp/codex` re-pinned to `rust-v0.139.0`

### Phase 7: Orchestration polish ✅
- [x] `wait <id> --next-turn` — single-shot turn-boundary wait (returns on the next `turn/completed`, including server-initiated goal continuation turns; plain `wait` loops to quiescence and rides through goal turns because continuations fire synchronously on thread-idle)
- [x] `last-message --json` + gateway uses it — fixes the gateway block-splitting corruption (messages with paragraph breaks were split on blank lines)
- [x] `kill --all` and `kill --older-than <30m|72h|7d>` — bulk cleanup of stale sessions, works through the gateway (CLI-level list+kill)

---

## Known Issues (open)

- [ ] **Codex ignores `--mode` flag** — `approvalPolicy` and `sandbox` are hardcoded to `never`/`danger-full-access` regardless of mode. Low priority since native mode always uses permissive settings.
- [ ] **No `respond`/`approve` command** — when a session hits `waiting_for_input`, the orchestrator has no structured way to respond. Only matters for non-native modes.
- [ ] **Claude permission prompts undetectable** — TUI elements, not in JSONL transcript. `status` reports `working` instead of `waiting_for_input`. Only affects `native` mode.
- [x] **Codex `last-message` returns empty** — fixed: `waitForTurnCompletion` now includes `assistantText` in result; `wait` persists it to `lastAssistantMessages` in the store.
- [x] **Gateway `last-message` block splitting** — fixed: `last-message --json` prints a lossless JSON block array and the gateway route uses it.

---

## Remaining Work

### High Priority

#### ~~Make `send` non-blocking~~ ✅
`send` now returns immediately after `turn/start` is accepted (Codex) or after tmux send-keys (Claude). `wait` is the dedicated blocking primitive. Overlap guard removed — app-server queues turns naturally.

#### ~~Tmux tri-state liveness (#6)~~ ✅
`sessionExists()` returns `'alive' | 'dead' | 'unknown'`. `listSessions()` only prunes on `'dead'`; `'unknown'` preserves the session record.

### Medium Priority

#### ~~Session store locking (#2/#3)~~ ✅
File-based locking added to `SessionStore` via atomic `mkdir` lock primitive. All read-modify-write operations (`upsertSession`, `updateSession`, `deleteSession`, `pruneSessions`) are serialized through `withLock()`. Stale lock recovery (30s timeout) prevents deadlocks from crashed processes. Concurrency tests added covering parallel upserts, deletes, updates, mixed operations, and cross-instance access.

#### Orphaned resources on store failure (#8)
**Why:** External resources (tmux session, Codex thread) are created before store persistence. If `upsertSession()` fails, the session/thread is created but untracked — orphaned forever.
**What:** On store write failure, do best-effort rollback (kill tmux session or archive Codex thread) before returning error.
**Files:** `src/session-manager.ts` (create path), `src/backends/claude-tmux.ts`, `src/backends/codex-appserver.ts`

#### Codex daemon concurrent startup (#9)
**Why:** Two concurrent `create` calls can both decide the daemon isn't running and both try to spawn it, resulting in two daemons. Also, if startup checks fail after spawn, the child process is orphaned.
**What:** Add a startup lockfile before spawning. Use unique temp state files. Kill the spawned child on startup failure before throwing.
**Files:** `src/backends/codex-appserver.ts` (daemon startup path)

#### Codex status truthfulness via app-server notification monitor (new)
**Why:** On codex-cli `0.104.0`, `thread/resume` and even `thread/read` can report an idle/completed thread while the agent is still executing tools in the same turn. We now mitigate `wait` and `status` by persisting `codexActiveTurnId`, but `status` remains conservative and can stay `working` after out-of-band completion until `wait` or another completion path clears the latch.
**What:** Build a long-lived local monitor (daemon task or companion process) that subscribes to Codex app-server notifications and updates the session store from `turn/started` / `turn/completed` events for tracked threads. Use the existing app-server as source of truth; the monitor just persists a projection into `~/.dev-sessions/sessions.json` (or future SQLite store).
**Protocol signals to use (0.104.0):**
- `turn/started` → persist `codexTurnInProgress=true`, `codexActiveTurnId=<turn.id>`
- `turn/completed` (matching thread + turn) → persist `codexTurnInProgress=false`, clear `codexActiveTurnId`, persist `lastTurnStatus`/`lastTurnError`, update `codexLastCompletedAt`
- `item/agentMessage/delta` (optional) → capture streamed text for better `last-message` freshness if desired
**Non-goals for v1 monitor:**
- Do not infer completion from `thread/resume` or `thread/read`
- Do not try to reconstruct missed notifications after the monitor was offline (best-effort only)
**Suggested design:**
- Single monitor connection per app-server (not per session)
- Subscribe by `thread/resume` for active tracked threads; maintain mapping `threadId -> championId`
- Reconcile tracked threads periodically from store (or via `create`/`send` hooks) so newly created sessions get subscribed
- Gracefully handle daemon restarts / websocket reconnects; resubscribe all tracked threads on reconnect
- Keep updates idempotent (ignore duplicate notifications)
**Success criteria (verifiable):**
1. Reproduce the timed-command false-idle bug on Codex `0.104.0` and confirm `dev-sessions status <id>` stays `working` during the 8s command even when `thread/resume` reports idle.
2. After the final `turn/completed`, `dev-sessions status <id>` flips to `idle` without requiring `dev-sessions wait`.
3. Out-of-band completion (agent finishes while no `wait` is running) clears `codexActiveTurnId` automatically.
4. Monitor survives app-server restart: after reconnect + resubscribe, new turns update status correctly.
5. Duplicate `turn/completed` notifications (or reconnect replay artifacts if any) do not corrupt store state.
**Files (likely):**
- `src/backends/codex-appserver.ts` (notification client reuse / subscription helpers)
- `src/session-manager.ts` or new monitor module (lifecycle wiring)
- `src/session-store.ts` (event-driven updates; later SQLite integration)
- `tests/integration/` (real Codex repro asserting status transitions without `wait`)

### Architecture

#### ~~Backend adapter interface (#13)~~ ✅
`Backend` interface defined in `src/backends/backend.ts`. `ClaudeBackend` and `CodexBackend` adapters in `src/backends/claude-backend.ts` and `src/backends/codex-backend.ts`. `SessionManager` now routes through a `Map<SessionCli, Backend>` with no `if (session.cli === 'codex')` branches. All 123 tests pass.

### Polish
- [ ] `send --file` with template variables (inject session context)
- [ ] `wait` with multiple session IDs (wait for all/any)
- [ ] Auto-cleanup: kill sessions older than N hours
- [x] `logs` command — full transcript dump with role labels (Claude: JSONL parse; Codex: thread/read)
- [x] `inspect` command — dump raw stored session record as JSON
- [ ] Better error messages throughout (session not found, tmux not installed, codex not installed)
- [x] Reject nonexistent workspace paths up front instead of creating broken sessions
- [ ] Version strings — source from `package.json` in one place (currently duplicated in cli.ts and codex clientInfo)

### Future

#### Replace Claude tmux backend with `--sdk-url` WebSocket protocol
**Why:** `claude-tmux.ts` is the most brittle part of the system — tmux send-keys with base64 encoding, hardcoded sleep delays, JSONL transcript polling, ps-based liveness detection. All replaceable.

**How:** Claude Code accepts `--sdk-url ws://HOST:PORT/PATH`. The CLI connects back as a WebSocket client and speaks NDJSON. Messages include `system/init`, `assistant` (streaming), `result` (turn complete with cost/tokens/stop reason), and `control_request` (auto-approve). Server sends `user` (prompt), `control_response`, and `control_request/interrupt`. This gives push-based status, structured turn results, prompt queuing, and interrupt support — no tmux, no transcript parsing, no polling.

**Quirk:** CLI waits for a `user` message BEFORE sending `system/init`. Must send queued prompt on WebSocket open before waiting for init.

**Reference:** `andrewting19/cc-api` — single-file Bun implementation of this protocol (~500 LOC). Demonstrates full session lifecycle. Would need porting from Bun to Node (`ws` package), stripping the OpenClaw callback, and wiring into existing `Backend` interface + `SessionStore`.

**Replaces:** `claude-tmux.ts`, `transcript/claude-parser.ts`, transcript-based `wait` logic.
**Risk:** `--sdk-url` is undocumented. Keep tmux backend as fallback initially.

- [ ] Session groups (named collections for fan-out workflows)
- [ ] Codex Docker support (`codexed` + tmux + transcript parsing) — P2
- [ ] Mid-turn steerability — explicit `send --interrupt` or `send --queue` flags once `send` is non-blocking
