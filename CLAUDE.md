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
This is a standalone tool. Docker integration (for claude-ting's `clauded`/`codexed` wrappers) is optional and handled via:
- `IS_SANDBOX=1` env var detection (signals we're in Docker)
- `HOST_PATH` env var (maps container workspace to host path)
- A thin HTTP gateway relay for Docker-to-host communication

## Architecture

```
dev-sessions CLI
├── src/
│   ├── cli.ts                 # Command parsing (commander.js or similar)
│   ├── session-manager.ts     # Core session lifecycle (create/send/wait/kill)
│   ├── backends/
│   │   ├── claude-tmux.ts     # Claude Code: tmux + transcript parsing
│   │   └── codex-appserver.ts # Codex: app-server JSON-RPC client
│   ├── transcript/
│   │   ├── claude-parser.ts   # Parse Claude Code JSONL transcripts
│   │   └── codex-parser.ts    # Parse Codex responses from app-server
│   ├── session-store.ts       # SQLite or JSON file for session metadata
│   ├── champion-ids.ts        # Human-friendly ID generation
│   └── gateway-client.ts      # Optional: HTTP relay for Docker environments
├── skill/
│   └── delegate.md            # Claude Code skill for guided delegation
├── gateway/                   # Optional: thin HTTP relay for Docker
│   └── ...
└── tests/
    ├── unit/
    └── integration/
```

## Transcript Locations

- **Claude Code**: `~/.claude/projects/<sanitized-cwd>/<session-uuid>.jsonl`
  - Sanitized CWD: path with `/` replaced by `-`, e.g., `-Users-andrew-Documents-git-repos-myproject`
  - Each line is a JSON object with `type` (human/user/assistant), `message.content`, `sessionId`, timestamps

- **Codex**: `~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-*.jsonl`
  - But with app-server, we get structured responses directly — no file parsing needed

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

## Testing Strategy

See TODO.md for the full testing plan. Key principles:
- Unit tests for transcript parsing (mock JSONL data)
- Unit tests for champion ID generation
- Integration tests for tmux session lifecycle (requires tmux installed)
- Integration tests for codex app-server (requires codex installed)
- E2E tests: create session → send message → wait → read response

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
| `create` | Spawn a new agent session |
| `send <id> <msg>` | Send a message/task to a session |
| `wait <id>` | Block until current turn completes |
| `last-message <id>` | Get last N assistant messages from transcript |
| `status <id>` | Check session status (idle/working/waiting) |
| `list` | List all active sessions |
| `attach <id>` | Attach to tmux session (Claude Code only) |
| `read <id>` | Raw terminal output fallback (Claude Code only) |
| `kill <id>` | Terminate a session |
| `install-skill` | Install the /delegate skill for Claude Code |
