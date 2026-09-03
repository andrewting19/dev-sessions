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
- [x] `create` race fix — waits for a stable interactive prompt, confirms the explicit workspace trust screen, and fails with pane evidence if Claude exits or does not become ready
- [x] Claude blank-start recovery — restarts one native Claude process that produces no tmux output for 15 seconds
- [x] `send` acceptance check — confirms the new user entry in the Claude transcript and retries a lost Enter key before returning

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
- [x] `kill` retires the active pointer without archiving the durable thread; rollback-only cleanup can still archive an unrecorded thread
- [x] Daemon metadata at `~/.dev-sessions/codex-appserver.json`
- [x] Daemon stop waits for process exit before it removes state, so immediate task resume cannot start a second writer
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
- [x] `skills/` directory — dev-sessions CLI guide
- [x] `install-skill` installs all skills at once (`--global`/`--local`, `--claude`/`--codex`, auto-detect)

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
- [x] Full automated suite passes; real-provider tests are opt-in
- [x] Real E2E verified: Claude Code create→send→wait→last-message→kill→resume by task ID→second turn
- [x] Real E2E verified: Codex keeps one thread ID across create→first turn→kill→resume by task ID→second turn
- [x] Real Codex E2E uses isolated session, automation, daemon-state, and daemon-log paths and archives its test thread during cleanup
- [x] Real E2E verified: Grok 4.6 create→first turn→kill→resume by task ID→second turn
- [x] Real E2E verified: scheduled Codex work records the exact scheduled-turn result, not a stale previous reply
- [x] Codex schedule polling stores assistant output only after terminal completion, so partial replies do not create duplicate history entries
- [x] Real remote E2E verified on Ubuntu over SSH: a temporary remote gateway completed a scheduled Codex tool turn after the control SSH connection ended
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

### Phase 8: In-container goal verification ✅
- [x] **Gateway `/goal` flag reconstruction fixed** — the CLI sends `status: 'active'` with every objective (objective implies active); the gateway re-encoded that as `--resume`, which the host CLI rejects alongside an objective. The route now drops the redundant `active` and 400s on `paused`+objective
- [x] **Goal ops work on fresh threads** — goal set/get/clear and `wait --next-turn` did `thread/resume` first, which fails with "no rollout found" on a thread that hasn't run its first turn yet (rollout file doesn't exist until then, even though the thread is live in the daemon). Resume is now tolerant of exactly that error
- [x] Full in-container E2E (real ubuntu-dev container → gateway → host): create codex session, goal set → autonomous completion → `wait --goal`, `ask` with multi-paragraph reply preserved, pause/resume/clear, `wait --next-turn` timeout semantics, kill

### Phase 7: Orchestration polish ✅
- [x] `wait <id> --next-turn` — single-shot turn-boundary wait (returns on the next `turn/completed`, including server-initiated goal continuation turns; plain `wait` loops to quiescence and rides through goal turns because continuations fire synchronously on thread-idle)
- [x] `last-message --json` + gateway uses it — fixes the gateway block-splitting corruption (messages with paragraph breaks were split on blank lines)
- [x] `kill --all` and `kill --older-than <30m|72h|7d>` — bulk cleanup of stale sessions, works through the gateway (CLI-level list+kill)

### Phase 9: Remote host support (SSH) ✅
- [x] `create --host <ssh-target>` — session spawns on the remote; all other commands route automatically via the local registry (`host` + `remoteBin` stored per session)
- [x] Remote schedule, message, and run IDs reuse the saved `remoteBin` for their host after process restart and session cleanup instead of falling back to a stale global install
- [x] Transport: `ssh <host> bash -lc '<remoteBin> <cmd> --json'` with ControlMaster multiplexing (60s persist), `BatchMode=yes`, `StrictHostKeyChecking=accept-new`, `ConnectTimeout=10`, ServerAlive keepalives — `src/remote/ssh-runner.ts`
- [x] `RemoteHostClient` (per-command builders/parsers) + `RoutingSessionManager` (implements `SessionManagerLike`, routes by `session.host`) — same seam as the gateway client
- [x] Champion IDs pre-allocated locally and passed via `create --id`, so IDs stay unique across hosts; retries if the ID is taken remotely
- [x] Version handshake at `create --host` — warns (stderr) when remote major.minor differs, continues
- [x] `send`/`ask --file` content streams over ssh **stdin** (`send <id> --file -`), never argv — no scp temp files, arbitrary quoting/size safe
- [x] `list` shows HOST column, merges live remote state, prunes stubs whose remote session died, keeps cached stubs (with warning) when a host is unreachable
- [x] Exit codes preserved through the relay (wait timeout 124 verified live); SSH transport failure exits **255** (distinct from session failure)
- [x] Durability: session + goal driver run detached on the remote; verified live that killing the ControlMaster mid-turn doesn't touch the session and `wait` reattaches
- [x] Gateway `/create` accepts `host` so Docker-sandboxed agents can target remote hosts (host-side routing does the rest)
- [x] New machine-readable surface for the relay: `create --json`, `create --id`, `logs --json`; `--version` no longer double-prints
- [x] Verified E2E against a real Ubuntu host over real ssh: create/list/send/status/wait/last-message/logs/inspect/ask/kill, hostile-quoting round trip, out-of-band kill pruning, version-mismatch warning, unreachable-host exit 255
- [x] Remote codex goal flow live-tested against an authed remote (real codex 0.142.3 over ssh): create → ask round trip → goal set → autonomous completion server-side → `wait --goal` → artifact verified on the remote → kill (daemon stopped, no processes left). Also exercised `DEV_SESSIONS_REMOTE_BIN` for real — the remote's login PATH had a stale codex 0.128 (pre-goals) ahead of a goals-capable one; a PATH-prefixing remoteBin routed around it without touching the machine's config

### Phase 11: Gateway client surfaces streamed /wait errors ✅
- [x] **Gateway client `timedOut` crash fixed** — `/wait` commits a 200 status up front (to satisfy fetch header timeouts) and keepalives, so a host-side `wait` failure after that point arrives as `{ ok: false, error }` in a 200 body. The client only checked HTTP status, returned the error envelope as if it were a wait payload, and callers crashed with `Cannot read properties of undefined (reading 'timedOut')` — burying the real error. Found live when a TCC-revoked codex app-server hung every turn and sandboxed agents saw only the cryptic crash. The client now throws the in-body `error` for any `ok: false` envelope and fails clearly if a wait response lacks `waitResult` (dropped connection).

### Phase 12: Grok Build ACP backend ✅
- [x] `create --cli grok` uses the official `grok agent serve` WebSocket ACP server; no tmux or terminal scraping
- [x] Private loopback daemon with startup locking, random authentication secret, owner-only state/log files, stale-process recovery, and last-session shutdown
- [x] Existing Grok login is selected from ACP initialize metadata; failures direct the user to `grok login`
- [x] `create --model grok-4.6` and Grok's configured default model both work
- [x] Non-blocking `send` uses a client-minted prompt ID and waits for ACP queue/turn acceptance
- [x] Exact `wait` uses durable `turn_completed` replay; status uses the live Grok roster
- [x] `last-message`, `logs`, follow-up continuity, `inspect`, `list`, and `kill` work through the shared backend interface
- [x] Grok is wired through the Docker gateway and generic remote SSH routing; model overrides now pass through the gateway create route
- [x] Unit tests cover the backend adapter, daemon security/lifecycle, ACP wire contract, CLI parsing, session persistence, and gateway relay
- [x] Opt-in real Grok E2E covers create → send → wait → replay → follow-up continuity → close
- [x] Live Grok 4.6 E2E passed on macOS with Grok Build 1.0.3, then stable auto-updated to 1.0.4

### Phase 13: Relay passes host stderr and exit code through ✅
- [x] Gateway client turns `{ ok: false, error, output }` envelopes into errors that carry the host CLI's stderr and non-zero exit code, so container-side `status`/`wait` failures are diagnosable instead of a bare `Command failed: <host cmd>`
- [x] Streamed `/wait` in-body errors now include the `output` block too (previously only the pre-headers path did)
- [x] Root cause of the reported "wait fails mid-turn" bug: the Codex thread was in a sticky `systemError` state after a model stream disconnect (`adapter_eof`); `status`/`wait` exit 1 by design until the next turn starts. Documented in the skill.

### Phase 10: Multiline/dash-safe goal & send through the gateway ✅
- [x] **Gateway argv mangling fixed** — the gateway relayed `goal` objectives and `send` messages as bare positional argv; any content starting with `-` (e.g. a markdown bullet list) hit commander's option parser on the host and failed with `unknown option`. This was the "multiline prompts through goal fail at the host proxy" bug — size was never the issue (argv handles multi-KB fine); the trigger was a leading dash. Routes now pass free text after a `--` terminator.
- [x] **`goal -f/--file <path>`** — read the objective from a file (`-` for stdin), same as `send`/`ask`; preferred for long/multiline objectives so they never travel through argv

---

## Known Issues (open)

- [ ] **Optional shared Codex app-server mode** — keep the current dev-sessions-owned daemon as the default for now. Add an explicit opt-in endpoint that can connect to a Desktop-owned Codex app-server over `unix://PATH`. In shared mode, dev-sessions must never spawn, reset, or stop that external server; the gateway status projector and all Codex commands must use the same endpoint. Add unit tests for Unix-socket WebSocket transport and non-ownership, plus a live create → send → wait proof that confirms no second Codex app-server starts. Treat the gateway restart and migration of active sessions as a separate, approval-gated rollout.
- [ ] **Codex ignores `--mode` flag** — `approvalPolicy` and `sandbox` are hardcoded to `never`/`danger-full-access` regardless of mode. Low priority since native mode always uses permissive settings.
- [ ] **Grok ignores `--mode` flag** — Grok always uses the native ACP server with automatic approval; Grok + Docker is not implemented.
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

#### ~~Orphaned resources on store failure (#8)~~ ✅
`createSession` now rolls back (kills) the just-created tmux session / codex thread when the store write fails, then rethrows. Unit-tested with a failing store.

#### ~~Codex daemon concurrent startup (#9)~~ ✅
Daemon startup is serialized by a `mkdir`-based lock (`codex-appserver.json.startup.lock`) with stale-lock recovery; after acquiring, `ensureServer` re-checks the state file so the loser adopts the winner's daemon. A spawned child that fails startup checks is SIGTERMed before the error propagates. Unit-tested (concurrent managers spawn exactly one daemon; failed startup kills the child and releases the lock; stale lock recovered) and verified live: two concurrent `create --cli codex` processes produced two sessions sharing one app-server pid/port, and the daemon stopped when the last session was killed.

#### ~~Codex status truthfulness via app-server notification projector~~ ✅
The gateway now owns one long-lived status projector per host. It uses the global `thread/status/changed` notification, so it does not `thread/resume` every stored thread. On startup or reconnect, it reads only stored active/latch records and currently loaded tracked threads with `thread/read { includeTurns: false }`.

Updates run through one ordered event queue and an atomic guarded store update. An old `turn/completed` cannot clear a newer active turn. Duplicate terminal events are no-ops. The client opts out of high-volume item and text notifications and does not retain message text. Gateway health reports projector state, app-server PID/URL/user-agent version, last connection, last reconciliation, and the latest error.

Unit tests cover stale startup repair, false-idle recovery, active/idle events, duplicate and out-of-order completion, two concurrent threads, app-server PID change and reconnect, remote-cache exclusion, 100 idle stored threads with no reads/resumes, the WebSocket initialization contract, and gateway start/stop ownership. Live rollout and per-host gateway installation remain operational work, not source TODOs.

### Architecture

#### ~~Backend adapter interface (#13)~~ ✅
`Backend` interface defined in `src/backends/backend.ts`. `ClaudeBackend` and `CodexBackend` adapters in `src/backends/claude-backend.ts` and `src/backends/codex-backend.ts`. `SessionManager` now routes through a `Map<SessionCli, Backend>` with no `if (session.cli === 'codex')` branches. All 123 tests pass.

### Polish
- [ ] `send --file` with template variables (inject session context)
- [ ] `wait` with multiple session IDs (wait for all/any)
- [x] Auto-cleanup: retire idle active-session records after 48 hours, keep backend task metadata, and allow `resume <task-id>`
- [x] `logs` command — full transcript dump with role labels (Claude: JSONL parse; Codex: thread/read)
- [x] `inspect` command — dump raw stored session record as JSON
- [ ] Better error messages throughout (session not found, tmux not installed, codex not installed)
- [x] Reject nonexistent workspace paths up front instead of creating broken sessions
- [x] Version strings — sourced from `package.json` everywhere (codex clientInfo was hardcoded `0.1.0`)

### Future

#### Replace Claude tmux backend with `--sdk-url` WebSocket protocol
**Why:** `claude-tmux.ts` is the most brittle part of the system — tmux send-keys with base64 encoding, hardcoded sleep delays, JSONL transcript polling, ps-based liveness detection. All replaceable.

**How:** Claude Code accepts `--sdk-url ws://HOST:PORT/PATH`. The CLI connects back as a WebSocket client and speaks NDJSON. Messages include `system/init`, `assistant` (streaming), `result` (turn complete with cost/tokens/stop reason), and `control_request` (auto-approve). Server sends `user` (prompt), `control_response`, and `control_request/interrupt`. This gives push-based status, structured turn results, prompt queuing, and interrupt support — no tmux, no transcript parsing, no polling.

**Quirk:** CLI waits for a `user` message BEFORE sending `system/init`. Must send queued prompt on WebSocket open before waiting for init.

**Reference:** `andrewting19/cc-api` — single-file Bun implementation of this protocol (~500 LOC). Demonstrates full session lifecycle. Would need porting from Bun to Node (`ws` package), stripping the OpenClaw callback, and wiring into existing `Backend` interface + `SessionStore`.

**Replaces:** `claude-tmux.ts`, `transcript/claude-parser.ts`, transcript-based `wait` logic.
**Risk:** `--sdk-url` is undocumented. Keep tmux backend as fallback initially.

- [x] Durable FIFO session messaging with idempotency keys, delivery state, results, and correlated replies
- [x] Durable host-side schedules for resumed tasks and new tasks, with pause/resume/delete/run-now, misfire and overlap policy, and run history
- [ ] Named session groups and fan-out policy on top of durable messages
- [ ] Codex Docker support (`codexed` + tmux + transcript parsing) — P2
- [ ] Mid-turn steerability — explicit `send --interrupt` or `send --queue` flags once `send` is non-blocking
