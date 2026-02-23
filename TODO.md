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
- [x] 120 automated tests (unit + integration) across 17 test files
- [x] Real E2E verified: Claude Code send→wait→last-message
- [x] Real E2E verified: Codex send→wait→last-message (PONG test)
- [x] Real E2E verified: Docker gateway relay

---

## Known Issues (open)

- [ ] **Codex ignores `--mode` flag** — `approvalPolicy` and `sandbox` are hardcoded to `never`/`danger-full-access` regardless of mode. Low priority since we always use yolo.
- [ ] **No `respond`/`approve` command** — when a session hits `waiting_for_input`, the orchestrator has no structured way to respond. Only matters for non-yolo modes.
- [ ] **Claude permission prompts undetectable** — TUI elements, not in JSONL transcript. `status` reports `working` instead of `waiting_for_input`. Only affects `native` mode.

---

## Remaining Work

### High Priority

#### ~~Make `send` non-blocking~~ ✅
`send` now returns immediately after `turn/start` is accepted (Codex) or after tmux send-keys (Claude). `wait` is the dedicated blocking primitive. Overlap guard removed — app-server queues turns naturally.

#### Tmux tri-state liveness (#6)
**Why:** `sessionExists()` for Claude converts all tmux errors to `false`, causing `listSessions()` to prune valid sessions on any transient error (tmux slow, PATH issue, etc.).
**What:** Return a tri-state: `'alive' | 'dead' | 'unknown'`. Only prune on `'dead'` (explicit "session not found" from tmux). `'unknown'` (unexpected error) should preserve the session record and log a warning.
**Files:** `src/backends/claude-tmux.ts` (`sessionExists`), `src/session-manager.ts` (`listSessions`)
**Scope:** Small — ~20-30 lines changed.

### Medium Priority

#### Session store locking (#2/#3)
**Why:** Concurrent CLI invocations do read-modify-write on `~/.dev-sessions/sessions.json` with no locking. Two parallel `create` calls can both pick the same champion ID, and concurrent writes can lose updates. The fixed temp filename (`sessions.json.tmp`) also creates write collisions.
**What:** Add cross-process file locking (e.g. `proper-lockfile` or a custom lockfile approach), use unique temp filenames for atomic writes, add retry logic.
**Alternative:** Migrate store to SQLite — solves locking, atomicity, and query performance in one go.
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

#### Backend adapter interface (#13)
**Why:** `SessionManager` currently mixes persistence, transcript parsing, and backend-specific lifecycle logic. Claude and Codex paths are handled with `if/else` branches scattered through the manager rather than proper polymorphism. This makes bugs harder to fix cleanly and testing more complex.
**What:** Define a normalized `Backend` interface:
```typescript
interface Backend {
  create(options): Promise<{ internalId: string; tmuxWindow?: string }>
  send(session, message): Promise<void>
  wait(session, timeoutMs): Promise<WaitResult>
  status(session): Promise<AgentTurnStatus>
  exists(session): Promise<'alive' | 'dead' | 'unknown'>
  getLastMessages(session, count): Promise<string[]>
  kill(session): Promise<void>
}
```
Then `SessionManager` routes to the right backend without knowing about tmux or WebSockets. Store mutations stay in a separate coordinator layer.
**Impact:** Prerequisite for clean fixes of #2/#3/#6/#8/#9. Makes adding new backends trivial.
**Files:** New `src/backends/types.ts`, refactor `src/session-manager.ts`, update both backends.
**Note:** Do this before #2/#3/#8/#9 — those fixes will be much cleaner on top of the new structure.

### Polish
- [ ] `send --file` with template variables (inject session context)
- [ ] `wait` with multiple session IDs (wait for all/any)
- [ ] Auto-cleanup: kill sessions older than N hours
- [ ] `logs` command — full transcript dump with formatting
- [ ] Better error messages throughout (session not found, tmux not installed, codex not installed)
- [ ] Version strings — source from `package.json` in one place (currently duplicated in cli.ts and codex clientInfo)

### Future
- [ ] Session groups (named collections for fan-out workflows)
- [ ] Codex Docker support (`codexed` + tmux + transcript parsing) — P2
- [ ] Mid-turn steerability — explicit `send --interrupt` or `send --queue` flags once `send` is non-blocking
