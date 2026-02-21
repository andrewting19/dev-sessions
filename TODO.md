# TODO — dev-sessions

## Phase 1: Foundation

- [ ] Project scaffolding (TypeScript, tsconfig, package.json, build scripts)
- [ ] Champion ID generation (port from claude-ting, add unit tests)
- [ ] Session store (SQLite or JSON file at `~/.dev-sessions/sessions.json`)
  - Schema: championId, internalId (uuid or threadId), cli, mode, path, description, status, createdAt, lastUsed
- [ ] CLI skeleton with commander.js (all commands stubbed, `--help` works)

## Phase 2: Claude Code Backend (tmux + transcript)

- [ ] `create` — spawn tmux session, launch `claude --session-id <uuid> --dangerously-skip-permissions`
  - Pre-generate UUID, store mapping championId → uuid
  - Handle `--mode docker` (use `clauded` wrapper), `--mode native`, `--mode yolo`
  - Handle `--path` (default: cwd or `HOST_PATH` in Docker)
- [ ] `send` — tmux send-keys with base64 encoding (port safety logic from current impl)
  - Verify claude is running before sending (ps check on tmux pane TTY)
  - Support `--file` flag to send file contents
- [ ] `kill` — tmux kill-session + update store
- [ ] `list` — read store, prune dead tmux sessions, display table

### Claude Code Transcript Parsing

- [ ] Locate transcript file: `~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl`
  - CWD sanitization: `/Users/foo/bar` → `-Users-foo-bar`
  - Handle Docker path mapping (HOST_PATH → sanitized host path)
- [ ] Parse JSONL: extract messages by type (human/user/assistant)
- [ ] `last-message` — read transcript, return last N assistant text blocks
- [ ] `status` — infer from transcript:
  - Last entry is assistant → `idle`
  - Last entry is human/user → `working`
  - Recent tool call to AskUserQuestion/ask_user → `waiting_for_input`
- [ ] `wait` — tail transcript file, resolve when:
  - New assistant message appears after the most recent human message
  - Or timeout reached
  - Poll interval: check file mtime every 2-3 seconds

## Phase 2b: Docker Integration (P0 — required for initial release)

Docker-to-host support is required for the primary use case (agents running inside claude-ting Docker containers).

- [ ] Thin HTTP relay gateway (port from current gateway, strip to essentials)
  - Endpoints: `/create`, `/send`, `/kill`, `/list`, `/status`, `/wait`, `/last-message`
  - No database in gateway — relay commands to host-side CLI
  - Gateway runs on host, listens on port 6767
- [ ] CLI auto-detection: if `IS_SANDBOX=1`, route commands through gateway at `DEV_SESSIONS_GATEWAY_URL` (default `http://host.docker.internal:6767`)
- [ ] `HOST_PATH` → host workspace path mapping for transcript file resolution
- [ ] Gateway can also be run as a simple `dev-sessions gateway` subcommand (no separate install)
- [ ] Integration with claude-ting: document how `clauded`/`codexed` set `HOST_PATH` and gateway URL

## Phase 3: Codex Backend (app-server)

- [ ] Research: pin down exact `codex app-server` invocation and handshake
- [ ] App-server lifecycle: spawn `codex app-server` process, perform JSON-RPC handshake
  - `initialize` → `initialized` → `thread/start`
- [ ] `create` — start app-server process, create thread, store threadId
- [ ] `send` — `turn/start` with text input
- [ ] `wait` — listen for `turn/completed` notification (streaming, not polling)
- [ ] `last-message` — extract from turn completion response or thread state
- [ ] `status` — derive from app-server state (in-turn → working, idle → idle)
- [ ] `kill` — terminate app-server process + update store
- [ ] Decide: one app-server per session, or shared app-server with multiple threads?

## Phase 4: Skill & Polish

- [ ] Write `/dev-sessions` skill (SKILL.md)
  - When to delegate vs do it yourself
  - How to write good task briefs (context, files, constraints, acceptance criteria)
  - Polling strategy guidance (prefer `wait`, fallback to `status` + `last-message`)
  - Fan-out patterns for parallel work
  - Anti-patterns (delegating trivial tasks, insufficient context)
- [ ] `install-skill` command (follows jupyter-cli pattern)
  - Support `--global` (~/.<tool>/skills/) and `--local` (./<tool>/skills/)
  - Support `--claude` and `--codex` flags
  - Auto-detect available tools (~/.claude exists? ~/.codex exists?)
  - Default to global install with auto-detect
  - Skill installed as `dev-sessions/SKILL.md` in both tool skill dirs
- [ ] Pretty output formatting (tables for `list`, colored status indicators)
- [ ] `--quiet` / `-q` flag for scriptable output (just print session ID)

## Phase 5: Advanced Features (future)

- [ ] `send --file` with template variables (inject session context)
- [ ] `wait` with multiple session IDs (wait for all/any)
- [ ] Session groups (named collections for fan-out workflows)
- [ ] Auto-cleanup: kill sessions older than N hours
- [ ] `logs` command — full transcript dump with formatting

---

## Testing Plan

### Unit Tests
- [ ] Champion ID generation: uniqueness, format, round-trip (id ↔ tmux name)
- [ ] Session store: CRUD operations, pruning, persistence
- [ ] Claude transcript parser: message extraction, status inference, edge cases
  - Empty transcript, single message, multi-turn, tool calls, content arrays
- [ ] Codex response parser: turn completion, message extraction
- [ ] CLI argument parsing: all commands, flags, defaults, validation

### Integration Tests (require tmux installed)
- [ ] tmux session lifecycle: create → verify exists → send keys → kill
- [ ] Base64 message encoding/decoding through tmux
- [ ] CLI running detection (ps check on pane TTY)
- [ ] Transcript file discovery (create session, verify file appears at expected path)

### Integration Tests (require codex installed)
- [ ] App-server spawn and handshake
- [ ] Thread creation and turn lifecycle
- [ ] Streaming notification handling

### E2E Tests
- [ ] Claude Code: create → send "echo hello" → wait → last-message contains "hello"
- [ ] Codex: create → send simple task → wait → verify completion
- [ ] List shows created sessions, kill removes them
- [ ] Docker gateway relay (if Docker available)

### Test Infrastructure
- [ ] Mock JSONL transcript fixtures (various scenarios)
- [ ] Test helpers for tmux session cleanup (kill all `dev-*` sessions after tests)
- [ ] CI considerations: tmux available in CI? codex available? Mark tests accordingly
