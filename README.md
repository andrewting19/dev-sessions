# dev-sessions

A CLI tool for coding agents to spawn, manage, and communicate with other coding agent sessions. Built for agent-to-agent delegation — no MCP overhead, just a CLI that agents call via Bash.

## Why

Coding agents (Claude Code, Codex) are increasingly capable of orchestrating parallel work. But the tooling for agent-to-agent communication is either over-engineered (MCP servers, HTTP gateways, SSH tunnels) or too primitive (raw tmux commands).

`dev-sessions` provides a clean CLI interface that lets agents:
- **Spawn** new coding agent sessions (Claude Code or Codex)
- **Send** tasks and messages to those sessions
- **Wait** for turns to complete (not just poll terminal output)
- **Read** structured responses from transcripts (not terminal scraping)
- **Check status** (idle, working, waiting for input)

## Architecture

### Claude Code Sessions
- **Backend**: tmux (for human-attachable sessions)
- **Session ID**: Pre-assigned UUID via `claude --session-id <uuid>`
- **Transcript**: `~/.claude/projects/<encoded-path>/<uuid>.jsonl`
- **Message delivery**: tmux send-keys (base64 encoded for safety)
- **Status/output**: Parsed from JSONL transcript

### Codex Sessions
- **Backend**: Codex app-server (JSON-RPC 2.0 over stdio/WebSocket)
- **Session ID**: Thread ID from `thread/start` response
- **Transcript**: Streamed via app-server notifications
- **Message delivery**: `turn/start` JSON-RPC call
- **Status/output**: Structured responses from app-server

## Usage

```bash
# Create a session (defaults: --path ., --cli claude, --mode native-yolo)
dev-sessions create --description "refactor auth module"
# => fizz-top

# Send a task
dev-sessions send fizz-top "Implement JWT auth. See AUTH-SPEC.md for details."
dev-sessions send fizz-top --file BRIEFING.md

# Wait for the agent to finish its turn
dev-sessions wait fizz-top --timeout 300

# Get the agent's response (clean text, not terminal noise)
dev-sessions last-message fizz-top

# Check what's happening
dev-sessions status fizz-top    # idle | working | waiting_for_input
dev-sessions list               # all active sessions

# Synchronous delegation (one-liner)
sid=$(dev-sessions create -q) && dev-sessions send $sid "run tests and fix failures" && dev-sessions wait $sid && dev-sessions last-message $sid

# Fan-out
s1=$(dev-sessions create -q --description "frontend")
s2=$(dev-sessions create -q --description "backend")
dev-sessions send $s1 "build React form per SPEC.md"
dev-sessions send $s2 "add /api/users endpoint per SPEC.md"
dev-sessions wait $s1 $s2
dev-sessions last-message $s1
dev-sessions last-message $s2

# Clean up
dev-sessions kill fizz-top
```

## Installation

```bash
npm install -g dev-sessions
```

Or clone and link:
```bash
git clone <repo-url>
cd dev-sessions
npm install && npm run build && npm link
```

### Skill Installation (Optional)

Install the `/dev-sessions` skill for Claude Code and/or Codex:
```bash
dev-sessions install-skill --global            # Auto-detect available tools
dev-sessions install-skill --global --claude    # Claude Code only
dev-sessions install-skill --global --codex     # Codex CLI only
dev-sessions install-skill --local              # Current directory only
```

The skill teaches agents best practices for task delegation, polling strategies, and fan-out patterns.

## Modes

| Mode | Flag | Description |
|------|------|-------------|
| `native-yolo` | `--mode yolo` | Runs CLI with permission bypass flags (default) |
| `native` | `--mode native` | Runs CLI normally (will prompt for permissions) |
| `docker` | `--mode docker` | Runs via `clauded`/`codexed` Docker wrappers |

## Docker Integration

When running inside a Docker container (detected via `IS_SANDBOX=1`), the CLI communicates with the host via a thin HTTP relay (gateway). The `HOST_PATH` environment variable maps the container's workspace to the host filesystem.

This is an optional integration for users of [claude-ting](https://github.com/anthropics/claude-ting) Docker workflows. The CLI works natively on the host without any gateway.

## Session Lifecycle

```
create  →  send  →  [wait / poll status]  →  last-message  →  kill
                ↑                                    |
                └────────────────────────────────────┘
                        (send follow-up)
```

## License

MIT
