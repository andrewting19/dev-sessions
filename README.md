# dev-sessions

A CLI tool for coding agents to spawn, manage, and communicate with other coding agent sessions. Built for agent-to-agent delegation — no MCP overhead, just a CLI that agents call via Bash.

## Why

Coding agents (Claude Code, Codex) are increasingly capable of orchestrating parallel work. But the tooling for agent-to-agent communication is either over-engineered (MCP servers, HTTP gateways, SSH tunnels) or too primitive (raw tmux commands).

`dev-sessions` provides a clean CLI interface that lets agents:
- **Spawn** new coding agent sessions (Claude Code or Codex)
- **Send** tasks and messages to those sessions
- **Wait** for turns to complete (transcript-aware, not terminal scraping)
- **Read** structured responses (clean assistant text, not ANSI noise)
- **Check status** (idle, working, waiting for input)

## Architecture

### Claude Code Sessions
- **Backend**: tmux (human-attachable via `tmux attach -t dev-<id>`)
- **Session ID**: Pre-assigned UUID via `claude --session-id <uuid>`
- **Transcript**: `~/.claude/projects/<encoded-path>/<uuid>.jsonl`
- **Message delivery**: tmux send-keys (base64 encoded for safety)
- **Turn detection**: Watches for `system` entries in JSONL transcript (definitive turn-completion signal)

### Codex Sessions
- **Backend**: Persistent `codex app-server` daemon (JSON-RPC 2.0 over WebSocket)
- **Session ID**: Thread ID from `thread/start` response
- **Conversation continuity**: Multiple sends share the same thread — full conversation history preserved
- **Message delivery**: `turn/start` JSON-RPC call
- **Turn detection**: `turn/completed` notification (streaming, no polling)
- **Daemon lifecycle**: Auto-started on first `create --cli codex`, auto-stopped when last Codex session is killed

## Usage

```bash
# Create a session (defaults: --cli claude, --mode yolo)
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
dev-sessions wait $s1
dev-sessions wait $s2
dev-sessions last-message $s1
dev-sessions last-message $s2

# Codex session (persistent app-server, conversation continuity)
sid=$(dev-sessions create --cli codex -q)
dev-sessions send $sid "hello"
dev-sessions send $sid "what did I just say?"   # has context from first message
dev-sessions last-message $sid                   # "You said hello"

# Clean up
dev-sessions kill fizz-top
```

## Installation

```bash
npm install -g dev-sessions
```

Or clone and link:
```bash
git clone https://github.com/andrewting19/dev-sessions
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
| `yolo` | `--mode yolo` | Runs with permission bypass flags — `--dangerously-skip-permissions` for Claude, `approvalPolicy: never` for Codex (default) |
| `native` | `--mode native` | Runs normally, will prompt for permissions |
| `docker` | `--mode docker` | Runs via `clauded` Docker wrapper (Claude Code only — see below) |

## Docker Integration

### Running FROM inside a container

When running inside a Docker container (detected via `IS_SANDBOX=1`), the CLI automatically routes all commands through an HTTP gateway relay on the host. This means you can delegate from inside a container to agents running on the host (or in other containers).

**Setup:**
1. Start the gateway on the host: `dev-sessions gateway --port 6767`
   - Note: port 6767 may conflict with Docker's own port forwarding. Use `DEV_SESSIONS_GATEWAY_PORT=6868` if needed.
2. Inside Docker, set `DEV_SESSIONS_GATEWAY_URL=http://host.docker.internal:6767` (or your chosen port)
3. Set `HOST_PATH` to map the container workspace path to the equivalent host path

### `--mode docker` (spawning Claude in a container)

`docker` mode spawns Claude inside a Docker container via a `clauded` binary. This requires you to have `clauded` available on the host as an executable (not just a shell function).

For a reference implementation, see [claude-ting](https://github.com/andrewting19/claude-ting), which provides a `clauded` Docker wrapper for Claude Code.

> **Note:** If `clauded` is defined as a shell function in your `.zshrc`, you'll need a wrapper script so it's accessible from tmux (which uses bash). Create `~/.local/bin/clauded`:
> ```bash
> #!/bin/zsh
> source ~/.zshrc 2>/dev/null
> claude-docker "$@"
> ```

## Commands

| Command | Description |
|---------|-------------|
| `create [options]` | Spawn a new agent session (`--cli claude\|codex`, `--mode yolo\|native\|docker`, `-q` for quiet) |
| `send <id> <msg>` | Send a message to a session (`--file` to send file contents) |
| `wait <id>` | Block until current turn completes (`--timeout` in seconds) |
| `last-message <id>` | Get last assistant message(s) from transcript (`--count N`) |
| `status <id>` | Get session status: `idle`, `working`, or `waiting_for_input` |
| `list` | List all active sessions |
| `kill <id>` | Terminate a session and clean up |
| `gateway` | Start the Docker relay gateway HTTP server (`--port`) |
| `install-skill` | Install the /dev-sessions skill (`--global\|--local`, `--claude\|--codex`) |

## Session Lifecycle

```
create  →  send  →  [wait / poll status]  →  last-message  →  kill
                ↑                                    |
                └────────────────────────────────────┘
                        (send follow-up)
```

## Known Limitations

- **Claude create → send race condition**: `create` returns as soon as the tmux session starts, but Claude's TUI takes a second or two to initialize. A very fast `send` immediately after `create` may arrive before Claude is ready. In practice a small sleep (`sleep 2`) between create and the first send avoids this.
- **Codex ignores `--mode`**: Codex always runs with `approvalPolicy: never` / full access regardless of the mode flag. `native` mode for Codex is a known gap.
- **`docker` mode is Claude-only**: Codex + Docker is not implemented.
- **Gateway port conflict**: The default gateway port 6767 can conflict with Docker's internal port forwarding. Set `DEV_SESSIONS_GATEWAY_PORT` to use a different port.

## Development

```bash
npm install
npm run build
npm test                  # unit + integration tests (85 tests)
npm run test:integration  # integration tests only
npm link                  # for local CLI testing
```

## License

MIT
