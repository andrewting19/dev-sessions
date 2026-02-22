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

### Phase 2b: Docker Gateway ✅
- [x] Thin HTTP relay gateway (`dev-sessions gateway --port <port>`)
- [x] CLI auto-detection: `IS_SANDBOX=1` → route through gateway
- [x] `HOST_PATH` mapping for transcript resolution
- [x] Gateway as subcommand (no separate install needed)
- [x] E2E verified: simulated Docker env routes through gateway correctly

### Phase 3: Codex Backend ✅
- [x] Persistent `codex app-server` daemon (WebSocket, JSON-RPC 2.0)
- [x] One daemon, many threads — conversation continuity across sends
- [x] `create` auto-starts daemon if not running, calls `thread/start`
- [x] `send` connects via WebSocket, calls `turn/start`, waits for `turn/completed`
- [x] `wait`, `last-message`, `status` all work
- [x] `kill` archives thread, stops daemon when last Codex session killed
- [x] Daemon metadata at `~/.dev-sessions/codex-appserver.json`

### Phase 4: Skill & Install ✅
- [x] `/dev-sessions` skill (SKILL.md) with delegation patterns, brief templates, best practices
- [x] `install-skill` command (--global/--local, --claude/--codex, auto-detect)

### Testing ✅
- [x] 83 automated tests (unit + integration) across 15 test files
- [x] Real E2E verified: Claude Code send→wait→last-message (3/3 reliable)
- [x] Real E2E verified: Codex send→wait→last-message with conversation continuity
- [x] Real E2E verified: Docker gateway relay (simulated IS_SANDBOX=1)

---

## Known Issues (to fix)

- [ ] **Gateway assumes global `dev-sessions` binary** — `src/gateway/server.ts` shells out to `dev-sessions` by name. If not globally installed, gateway starts but all requests fail. Should resolve the binary path from the running process.
- [ ] **Poor error when gateway unreachable** — sandbox mode shows generic `fetch failed` with no URL context. Should include gateway URL and suggest checking if gateway is running.
- [ ] **No gateway request logging** — hard to debug routing issues in Docker environments.

## Remaining Work

### clauded/Docker Integration
- [ ] Add `dev-sessions` CLI to `claude-ting/Dockerfile.ubuntu-dev` (currently only installs `dev-sessions-mcp`)
- [ ] Make `clauded` wrapper explicitly pass `DEV_SESSIONS_GATEWAY_URL` (like `codexed` does)
- [ ] Update `claude-ting` entrypoint to start gateway or document manual gateway start
- [ ] Real E2E test from inside an actual `clauded` container (simulated env passed, real Docker untested)

### Polish
- [ ] `send --file` with template variables (inject session context)
- [ ] `wait` with multiple session IDs (wait for all/any)
- [ ] Auto-cleanup: kill sessions older than N hours
- [ ] `logs` command — full transcript dump with formatting
- [ ] Better error messages throughout (session not found, tmux not installed, codex not installed)
- [ ] Publish to npm

### Future
- [ ] Session groups (named collections for fan-out workflows)
- [ ] Codex Docker support (`codexed` + tmux + transcript parsing) — P2
