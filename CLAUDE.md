# CLAUDE.md

## Project Overview

`dev-sessions` is a CLI tool that lets coding agents (Claude Code, Codex) spawn and manage other coding agent sessions. It replaces the previous MCP-based approach (MCP server + HTTP gateway + SSH) with a direct CLI that agents call via Bash.

## Key Design Decisions

### 1. CLI over MCP
Agents already have Bash. Wrapping tmux/app-server operations in an MCP protocol adds overhead with no benefit. A CLI is simpler, faster, and easier to test.

### 2. Transcript-Aware (not terminal-scraping)
Instead of reading raw terminal output via `tmux capture-pane`, we parse the actual JSONL transcripts that Claude Code and Codex produce. This gives us clean structured data — assistant messages, tool calls, status inference — without ANSI codes and terminal noise.

### 3. Dual Backend Strategy
- **Claude Code**: tmux sessions + JSONL transcript parsing. Uses `--session-id <uuid>` to pre-assign session IDs so we know exactly which transcript file to read.
- **Codex**: Codex app-server (JSON-RPC 2.0). Provides streaming notifications, structured responses, and proper turn management. No tmux needed.

### 4. Pre-assigned Session IDs (Claude Code)
When creating a Claude Code session, we generate a UUID and pass it via `claude --session-id <uuid>`. This means:
- We know the transcript path immediately: `~/.claude/projects/<encoded-path>/<uuid>.jsonl`
- No file watching, no race conditions, no hooks needed
- The `wait` and `last-message` commands can read the transcript directly

### 5. Champion IDs for Human-Friendly Names
Sessions get human-readable IDs like `fizz-top`, `riven-jg` (League of Legends champion + role). These map to internal UUIDs/thread IDs but are easier to type and remember.

### 6. Decoupled from claude-ting
This is a standalone tool. Docker integration (for claude-ting's `clauded` wrapper) is optional and handled via:
- `IS_SANDBOX=1` env var detection (signals we're in Docker)
- `HOST_PATH` env var (maps container workspace to host path)
- A thin HTTP gateway relay for Docker-to-host communication

### 7. send is non-blocking
`send` returns immediately after confirming the message was delivered (Codex: after `turn/started`; Claude: after tmux send-keys). `wait` is the dedicated blocking primitive. This enables mid-turn steerability and avoids timeout errors on long-running tasks.

## Architecture

```
dev-sessions CLI
├── src/
│   ├── cli.ts                 # Command parsing (commander.js)
│   ├── session-manager.ts     # Core session lifecycle (create/send/wait/kill)
│   ├── backends/
│   │   ├── claude-tmux.ts     # Claude Code: tmux + transcript parsing
│   │   └── codex-appserver.ts # Codex: app-server JSON-RPC client
│   ├── transcript/
│   │   └── claude-parser.ts   # Parse Claude Code JSONL transcripts
│   ├── session-store.ts       # JSON file at ~/.dev-sessions/sessions.json
│   ├── champion-ids.ts        # Human-friendly ID generation (LoL champion + role)
│   ├── gateway/
│   │   ├── server.ts          # Express HTTP gateway (for Docker → host relay)
│   │   ├── client.ts          # Gateway client (used when IS_SANDBOX=1)
│   │   └── daemon.ts          # launchd/systemd daemon install/uninstall/status
│   └── types.ts               # Shared types
├── skills/
│   ├── dev-sessions/SKILL.md  # /dev-sessions skill for Claude Code and Codex
│   └── handoff/SKILL.md       # /handoff skill for handing off long sessions
└── tests/
    ├── unit/
    └── integration/
```

## Transcript Locations

- **Claude Code**: `~/.claude/projects/<sanitized-cwd>/<session-uuid>.jsonl`
  - Sanitized CWD: path with `/` replaced by `-`, e.g., `-Users-andrew-Documents-git-repos-myproject`
  - Each line is a JSON object with `type` (human/user/assistant), `message.content`, `sessionId`, timestamps

- **Codex**: Message history fetched directly from app-server via `thread/read` RPC (no transcript file)

## Claude Code Transcript Format (key fields)

```jsonl
{"type":"human","message":{"content":"do the thing"},"sessionId":"<uuid>","timestamp":"..."}
{"type":"assistant","message":{"content":[{"type":"text","text":"I'll do the thing..."}]},"sessionId":"<uuid>","timestamp":"..."}
```

- Assistant content is an array of blocks: `[{"type":"text","text":"..."}]`
- User messages: content can be string or array of text blocks
- Status inference: if last entry is assistant → idle; if user → working; if tool call to AskUserQuestion → waiting_for_input

## Codex App-Server Protocol (key methods)

```
initialize → initialized → thread/start → turn/start → [stream notifications] → turn/started → ... → turn/completed
```

Key methods: `thread/start`, `turn/start`, `turn/interrupt`, `thread/list`, `thread/resume`, `thread/read`
Key notifications: `turn/started`, `item/agentMessage/delta`, `turn/completed`, `thread/status/changed`

**ThreadStatus JSON shape** (important — easy to get wrong):
- `"idle"`, `"notLoaded"`, `"systemError"` serialize as plain strings
- `"active"` serializes as `{ "active": { "activeFlags": [...] } }` (tagged enum variant)
- Do NOT look for a `.type` field — that's wrong. Check the value directly.

## Known Gotchas

- **`clauded` must be a binary**: `docker` mode runs `clauded` via `execFile` in a bash tmux session. If `clauded` is only a zsh shell function, it won't be found. Create a wrapper script at `~/.local/bin/clauded`.
- **Gateway port conflict**: Default port 6767 can conflict with Docker. Use `DEV_SESSIONS_GATEWAY_PORT` env var to override.
- **Gateway binds to 127.0.0.1**: Security default — not exposed beyond loopback.
- **Codex mode is always yolo**: `approvalPolicy` and `sandbox` are hardcoded to `never`/`danger-full-access` regardless of `--mode`. Known issue, low priority.
- **Gateway daemon needs Full Disk Access on macOS**: The node binary running the gateway needs Full Disk Access in System Settings → Privacy & Security if sessions use repos in ~/Documents or other protected paths. `gateway install` prints the exact binary path to add.
- **NVM node path in launchd**: The gateway daemon plist explicitly invokes `node` via `process.execPath` so launchd finds it regardless of NVM/PATH.
- **Session store has no locking**: Concurrent CLI invocations can race on `~/.dev-sessions/sessions.json`. Known issue, tracked in TODO.md. Avoid concurrent `create` calls for now.

## Developer Workflow

**Before starting work:**
1. Read `TODO.md` to understand current state and what's in scope
2. Run `npm test` to confirm baseline is green

**While working:**
- Run `npm test` after each meaningful change — don't accumulate failures
- Keep changes focused; one concern per commit
- If you add a new feature or fix a bug, add a test for it

**Before finishing:**
1. `npm run build` — confirm TypeScript compiles clean
2. `npm test` — all tests must pass
3. Commit with a descriptive message
4. If behavior changed, update `TODO.md` to reflect current state
5. If publishing: `npm version patch|minor|major --no-git-tag-version`, then `npm publish`

**Commit style:** short imperative subject, e.g. `fix Codex thread status parsing`, `add gateway daemon install command`. No need for body unless the change is non-obvious.

## Testing Strategy

- 123 automated tests (unit + integration) across 17 test files
- Unit tests for transcript parsing, champion IDs, session store, gateway client/server/daemon, backends
- Integration tests for tmux lifecycle, codex app-server, gateway relay
- Real E2E verified: Claude and Codex sessions (create → send → wait → last-message → kill)
- Real Docker E2E verified: all three paths (container → codex-on-host, container → claude-on-host, container → claude-in-docker)

## Development

```bash
npm install
npm run build
npm test
npm link  # for local testing — links global dev-sessions to this repo's dist/
```

## Commands Reference

| Command | Description |
|---------|-------------|
| `create` | Spawn a new agent session (`--cli claude\|codex`, `--mode yolo\|native\|docker`, `-q` quiet) |
| `send <id> <msg>` | Send a message/task to a session — returns immediately (`--file` to send file contents) |
| `wait <id>` | Block until current turn completes (`--timeout` seconds, `--interval` poll interval) |
| `last-message <id>` | Get last N assistant messages (`-n` count) |
| `status <id>` | Check session status: `idle`, `working`, `waiting_for_input` |
| `list` | List all active sessions (`--json` for machine-readable output) |
| `kill <id>` | Terminate a session |
| `gateway` | Start the Docker relay gateway (`--port`) |
| `gateway install` | Install gateway as system daemon (launchd/systemd), auto-starts on login |
| `gateway uninstall` | Remove gateway daemon |
| `gateway status` | Check if gateway daemon is running |
| `install-skill` | Install all skills for Claude Code and/or Codex (`--global\|--local`, `--claude\|--codex`) |

## Publishing

```bash
npm run build
npm version patch --no-git-tag-version   # or minor/major
npm publish --//registry.npmjs.org/:_authToken=$NPM_TOKEN
git add -A && git commit -m "0.x.y"
git push
```

Token is stored in `.env` (gitignored). Load with `source .env` before publishing.
