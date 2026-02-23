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
- [x] CLI auto-detection: `IS_SANDBOX=1` → route through gateway
- [x] `HOST_PATH` mapping for transcript resolution
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

---

## Known Issues (open)

- [ ] **Codex ignores `--mode` flag** — `approvalPolicy` and `sandbox` are hardcoded to `never`/`danger-full-access` regardless of mode. Low priority since native mode always uses permissive settings.
- [ ] **No `respond`/`approve` command** — when a session hits `waiting_for_input`, the orchestrator has no structured way to respond. Only matters for non-native modes.
- [ ] **Claude permission prompts undetectable** — TUI elements, not in JSONL transcript. `status` reports `working` instead of `waiting_for_input`. Only affects `native` mode.
- [x] **Codex `last-message` returns empty** — fixed: `waitForTurnCompletion` now includes `assistantText` in result; `wait` persists it to `lastAssistantMessages` in the store.
- [ ] **Gateway `last-message` block splitting** — `cli.ts` joins blocks with blank lines; `gateway/server.ts` splits on blank lines — assistant messages with paragraph breaks get corrupted. Fix: use structured JSON over the gateway.

---

## Remaining Work

### High Priority

#### ~~Make `send` non-blocking~~ ✅
`send` now returns immediately after `turn/start` is accepted (Codex) or after tmux send-keys (Claude). `wait` is the dedicated blocking primitive. Overlap guard removed — app-server queues turns naturally.

#### ~~Tmux tri-state liveness (#6)~~ ✅
`sessionExists()` returns `'alive' | 'dead' | 'unknown'`. `listSessions()` only prunes on `'dead'`; `'unknown'` preserves the session record.

### Medium Priority

#### Session store locking (#2/#3) — HIGH PRIORITY
**Why:** Concurrent CLI invocations do read-modify-write on `~/.dev-sessions/sessions.json` with no locking. Parallel `kill` calls in a loop have been observed wiping unrelated sessions from the store (confirmed in practice). Two parallel `create` calls can also pick the same champion ID.
**What:** Migrate store to SQLite — solves locking, atomicity, and query performance in one go. File locking (e.g. `proper-lockfile`) is a lower-effort alternative but doesn't fix all races.
**Files:** `src/session-store.ts`

#### Orphaned resources on store failure (#8)
**Why:** External resources (tmux session, Codex thread) are created before store persistence. If `upsertSession()` fails, the session/thread is created but untracked — orphaned forever.
**What:** On store write failure, do best-effort rollback (kill tmux session or archive Codex thread) before returning error.
**Files:** `src/session-manager.ts` (create path), `src/backends/claude-tmux.ts`, `src/backends/codex-appserver.ts`

#### Codex daemon concurrent startup (#9)
**Why:** Two concurrent `create` calls can both decide the daemon isn't running and both try to spawn it, resulting in two daemons. Also, if startup checks fail after spawn, the child process is orphaned.
**What:** Add a startup lockfile before spawning. Use unique temp state files. Kill the spawned child on startup failure before throwing.
**Files:** `src/backends/codex-appserver.ts` (daemon startup path)

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
- [ ] Version strings — source from `package.json` in one place (currently duplicated in cli.ts and codex clientInfo)

### Future
- [ ] Session groups (named collections for fan-out workflows)
- [ ] Codex Docker support (`codexed` + tmux + transcript parsing) — P2
- [ ] Mid-turn steerability — explicit `send --interrupt` or `send --queue` flags once `send` is non-blocking
