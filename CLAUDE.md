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
- Docker integration is for Claude Code sessions only (Codex uses app-server natively)

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
│   │   └── client.ts          # Gateway client (used when IS_SANDBOX=1)
│   └── types.ts               # Shared types
├── skill/
│   └── SKILL.md               # /dev-sessions skill for Claude Code and Codex
└── tests/
    ├── unit/
    └── integration/
```

## Transcript Locations

- **Claude Code**: `~/.claude/projects/<sanitized-cwd>/<session-uuid>.jsonl`
  - Sanitized CWD: path with `/` replaced by `-`, e.g., `-Users-andrew-Documents-git-repos-myproject`
  - Each line is a JSON object with `type` (human/user/assistant), `message.content`, `sessionId`, timestamps

- **Codex**: Structured responses directly from app-server (no transcript file parsing needed)

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
initialize → initialized → thread/start → turn/start → [stream notifications] → turn/completed
```

Key methods: `thread/start`, `turn/start`, `turn/interrupt`, `thread/list`
Key notifications: `turn/started`, `item/agentMessage/delta`, `turn/completed`, `item/fileChange`

## Known Gotchas

- **`clauded` must be a binary**: `docker` mode runs `clauded` via `execFile` in a bash tmux session. If `clauded` is only a zsh shell function, it won't be found. Create a wrapper script at `~/.local/bin/clauded`.
- **Gateway port conflict**: Default port 6767 can conflict with Docker. Use `DEV_SESSIONS_GATEWAY_PORT` env var to override.
- **Codex mode is always yolo**: `approvalPolicy` and `sandbox` are hardcoded to `never`/`danger-full-access` regardless of `--mode`. Known issue, low priority.
- **Claude create → send race**: `create` returns before Claude's TUI is ready. Add a small sleep between create and the first send if hitting issues.
- **Gateway binary resolution**: The gateway resolves its own CLI path from `process.argv[1]` so it works whether installed globally or run via `node dist/index.js`.

## Testing Strategy

- 85 automated tests (unit + integration) across 16 test files
- Unit tests for transcript parsing, champion IDs, session store, gateway client/server
- Integration tests for tmux lifecycle, codex app-server, gateway relay
- Real E2E verified: Claude and Codex sessions (create → send → wait → last-message → kill)
- Real Docker E2E verified: all three paths (container → codex-on-host, container → claude-on-host, container → claude-in-docker)

## Development

```bash
npm install
npm run build
npm test
npm link  # for local testing
```

## Commands Reference

| Command | Description |
|---------|-------------|
| `create` | Spawn a new agent session (`--cli claude\|codex`, `--mode yolo\|native\|docker`, `-q` quiet) |
| `send <id> <msg>` | Send a message/task to a session (`--file` to send file contents) |
| `wait <id>` | Block until current turn completes (`--timeout` seconds) |
| `last-message <id>` | Get last N assistant messages (`-n` count) |
| `status <id>` | Check session status: `idle`, `working`, `waiting_for_input` |
| `list` | List all active sessions (`--json` for machine-readable output) |
| `kill <id>` | Terminate a session |
| `gateway` | Start the Docker relay gateway (`--port`) |
| `install-skill` | Install the /dev-sessions skill (`--global\|--local`, `--claude\|--codex`) |

## Publishing

```bash
npm run build
npm version patch   # or minor/major
npm publish --//registry.npmjs.org/:_authToken=$NPM_TOKEN
git push
```

Token is stored in `.env` (gitignored). Load with `source .env` before publishing.
