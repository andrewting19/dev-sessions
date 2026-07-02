# dev-sessions

A CLI tool for coding agents to spawn, manage, and communicate with other coding agent sessions. Built for agent-to-agent delegation — no MCP overhead, just a CLI that agents call via Bash.

## Why

Coding agents (Claude Code, Codex) are increasingly capable of orchestrating parallel work. But the tooling for agent-to-agent communication is either over-engineered (MCP servers, HTTP gateways, SSH tunnels) or too primitive (raw tmux commands).

`dev-sessions` provides a clean CLI interface that lets agents:
- **Spawn** new coding agent sessions (Claude Code or Codex)
- **Send** tasks and messages to those sessions
- **Wait** for turns to complete (transcript-aware, not terminal scraping)
- **Read** structured responses (clean assistant text, not ANSI noise)
- **Check status** (`idle`, `working`, `waiting_for_input`)

## Installation

```bash
npm install -g dev-sessions
```

Or clone and link for local development:
```bash
git clone https://github.com/andrewting19/dev-sessions
cd dev-sessions
npm install && npm run build && npm link
```

### Host Setup (one-time)

Install the gateway as a system daemon so it auto-starts on login:
```bash
dev-sessions gateway install
```

On macOS, grant Full Disk Access to the node binary printed by that command (System Settings → Privacy & Security → Full Disk Access). This is needed if your repos live in ~/Documents or other protected paths.

Install skills for Claude and/or Codex:
```bash
dev-sessions install-skill --global
```

---

## Usage

```bash
# Create a session (defaults: --cli claude, --mode native)
dev-sessions create --description "refactor auth module"
# => fizz-top

# Send a task (returns immediately — non-blocking)
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
dev-sessions wait $s1 & dev-sessions wait $s2 & wait
dev-sessions last-message $s1
dev-sessions last-message $s2

# One-shot round trip (send + wait + print reply)
dev-sessions ask fizz-top "Summarize the failing tests." --timeout 120

# Codex session (persistent app-server, conversation continuity)
sid=$(dev-sessions create --cli codex -q)
dev-sessions send $sid "hello"
dev-sessions send $sid "what did I just say?"   # has context from first message
dev-sessions last-message $sid                   # "You said hello"

# Autonomous goal (codex only) — the agent keeps working across turns until done
dev-sessions goal $sid "Make all unit tests pass, then mark the goal complete." --budget 200000
dev-sessions wait $sid --goal --timeout 1800     # blocks until complete/paused/blocked/limited
dev-sessions goal $sid --json                    # inspect objective, status, token usage

# Clean up
dev-sessions kill fizz-top
```

---

## Architecture

### Claude Code Sessions
- **Backend**: tmux (human-attachable via `tmux attach -t dev-<id>`)
- **Session ID**: Pre-assigned UUID via `claude --session-id <uuid>` — transcript path is known immediately
- **Transcript**: `~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl`
  - Sanitized CWD: path with `/` replaced by `-`, e.g. `-Users-andrew-Documents-git-repos-myproject`
- **Message delivery**: `tmux send-keys` (base64 encoded for safety)
- **Turn detection**: Watches for `system` entries in JSONL (definitive turn-completion signal)
- **Status inference**: last entry is `assistant` → idle; `human/user` → working; tool call to `AskUserQuestion` → waiting_for_input

### Codex Sessions
- **Backend**: Persistent `codex app-server` daemon (JSON-RPC 2.0 over WebSocket)
- **Session ID**: Thread ID from `thread/start` response
- **Conversation continuity**: Multiple sends share the same thread — full history preserved
- **Message delivery**: `turn/start` JSON-RPC call (non-blocking — returns after `turn/started`)
- **Turn detection**: `turn/completed` notification; also `thread/status/changed` (Active → Idle)
- **Message history**: Fetched via `thread/read` with `includeTurns: true` — persisted across process restarts
- **Turn status**: Checked via `thread/resume` which returns live `Thread.status`
- **Session liveness**: Verified via `thread/list` — checks specific thread ID exists, not just daemon PID
- **Daemon lifecycle**: Auto-started on first `create --cli codex`, auto-stopped when last Codex session is killed

### Codex App-Server Protocol

```
initialize → initialized → thread/start → turn/start → [stream notifications] → turn/started → ... → turn/completed
```

Key methods: `thread/start`, `turn/start`, `turn/interrupt`, `thread/list`, `thread/resume`, `thread/read`, `thread/goal/set`, `thread/goal/get`, `thread/goal/clear`
Key notifications: `turn/started`, `item/agentMessage/delta`, `turn/completed`, `thread/status/changed`, `error`, `thread/goal/updated`

**`ThreadStatus` JSON shape** — important, easy to get wrong. The parser supports all
formats that have shipped:
- Plain strings: `"idle"`, `"notLoaded"`, `"systemError"`
- 0.104.0 tagged variant: `{ "active": { "activeFlags": [...] } }`
- 0.105.0+ tagged objects (current): `{ "type": "idle" }`, `{ "type": "active", "activeFlags": [] }`, `{ "type": "systemError" }`

**Goals** (`/goal` in the Codex TUI, stable since codex 0.133.0): a persisted
per-thread objective. While a goal is `active` the app-server itself keeps starting
continuation turns until the model marks the goal `complete` or `blocked` (or a
token budget/usage limit lands it in `budgetLimited`/`usageLimited`). The model gets
`get_goal`/`create_goal`/`update_goal` tools; clients control pause/resume/budget via
`thread/goal/set`. dev-sessions surfaces this as the `goal` command and `wait --goal`.

**Model selection**: no model is sent unless explicitly requested (`create --model`).
Codex resolves its own configured default, which tracks model deprecations across
releases — hardcoding a default here is how sessions silently break (a rejected model
yields a turn recorded as `completed` with no output and a `systemError` thread).

### Champion IDs

Sessions get human-readable IDs like `fizz-top`, `riven-jg` (League of Legends champion + role). These map to internal UUIDs/thread IDs but are easier to type and remember.

### Session Store

Persisted at `~/.dev-sessions/sessions.json`. All mutating operations use file-based locking (`mkdir` as atomic primitive) to serialize concurrent access.

---

## Commands

| Command | Description |
|---------|-------------|
| `create [options]` | Spawn a new agent session (`--cli claude|codex`, `--mode native|docker`, `--model <m>` codex model override, `--host <ssh-target>` remote host, `--json` full record, `-q` quiet) |
| `ask <id> <msg>` | One-shot round trip: send, wait for the reply, print it (`--file`, `--timeout`) |
| `send <id> <msg>` | Send a message — returns immediately after delivery (`--file` to send file contents, `--file -` for stdin) |
| `wait <id>` | Block until current turn completes (`--timeout` seconds, `--interval` poll interval); `--goal` waits until the goal reaches a terminal state; `--next-turn` returns at the next turn boundary (codex only, includes goal continuation turns) |
| `goal <id> [objective]` | Codex only: set/show an autonomous goal (`--budget` tokens, `--pause`, `--resume`, `--clear`, `--json`) |
| `last-message <id>` | Get last N assistant messages (`-n` count, `--json` for a lossless block array) |
| `status <id>` | Get session status: `idle`, `working`, or `waiting_for_input` |
| `list` | List all active sessions with their host (`--json` for machine-readable output) |
| `kill <id>` | Terminate a session and clean up (`--all` for every session, `--older-than 7d|72h|30m` for stale ones) |
| `gateway` | Start the Docker relay gateway HTTP server (`--port`) |
| `gateway install` | Install gateway as system daemon (launchd on macOS, systemd on Linux) |
| `gateway uninstall` | Remove gateway daemon |
| `gateway status` | Check if gateway daemon is running and on which port |
| `install-skill` | Install all skills (`--global\|--local`, `--claude\|--codex`) |

## Modes

| Mode | Flag | Description |
|------|------|-------------|
| `native` | `--mode native` | Runs with `--dangerously-skip-permissions` — auto-approves all tool calls (default) |
| `docker` | `--mode docker` | Runs via `clauded` Docker wrapper (Claude Code only) |

## Session Lifecycle

```
create  →  send  →  [wait / poll status]  →  last-message  →  kill
                ↑                                    |
                └────────────────────────────────────┘
                        (send follow-up)
```

`send` is non-blocking — it returns immediately after the message is delivered. Use `wait` to block until the turn completes.

---

## Remote Hosts (SSH)

Sessions can live on other machines. Create with `--host` and every other
command routes there automatically — the calling convention doesn't change:

```bash
# buildbox is an ~/.ssh/config alias (any ssh target works, e.g. user@10.0.0.5)
sid=$(dev-sessions create -q --host buildbox --path /home/andrew/repo --cli codex)

dev-sessions send $sid --file BRIEFING.md    # file content streams over ssh stdin
dev-sessions goal $sid "Make the tests pass, then mark the goal complete."
dev-sessions wait $sid --goal --timeout 1800
dev-sessions last-message $sid
dev-sessions kill $sid
```

**How it works:** the local CLI relays each command as
`ssh <host> dev-sessions <cmd> --json` and passes results through. The local
registry (`~/.dev-sessions/sessions.json`) records which host each session ID
lives on and pre-allocates IDs, so they stay unique across hosts. `list` shows
a HOST column, merges live remote state, and prunes sessions that died remotely.

**Requirements:** dev-sessions installed on the remote (same minor version — the
CLI warns on mismatch at create time), key-based ssh auth (`BatchMode=yes`; no
prompts, no secrets in argv — auth is entirely ssh config's business). Remote
commands run via `bash -lc` so login-shell PATH additions (npm globals, nvm)
apply; if the binary still isn't found, set `DEV_SESSIONS_REMOTE_BIN` to its
absolute path before `create --host` (it's remembered per session).

**Durability:** the session and any `/goal` driver run entirely on the remote
(tmux / app-server daemon, detached). A dropped connection or closed laptop
doesn't touch them — `wait` is a pure polling reattach, safe to re-run.

**Exit codes:** preserved exactly (`wait` exits 124 on timeout). Exit **255**
means the SSH transport failed — distinct from "the session failed" — so
orchestrators can retry network errors specifically. Connections are multiplexed
(`ControlMaster` with 60s persistence) to keep per-command latency low; first
contact with an unknown host is accepted automatically (`accept-new`), changed
host keys still fail hard.

---

## Docker Integration

### Running FROM inside a container

When running inside a Docker container (detected via `DEV_SESSIONS_SANDBOX=1`), the CLI automatically routes all commands through an HTTP gateway relay on the host.

**Setup:**
1. On the host: `dev-sessions gateway install` (or manually `dev-sessions gateway --port 6767`)
2. Inside Docker, set `DEV_SESSIONS_GATEWAY_URL=http://host.docker.internal:6767`
3. Set `HOST_PATH` to the host-side project path (e.g. `/Users/you/project`)

**Path translation:** Container paths are automatically mapped to host paths. When an agent inside Docker passes `--path /workspace/subdir`, it's translated to `HOST_PATH/subdir` before being sent to the gateway. This means agents can use paths as they see them locally without knowing the host filesystem layout.

| Environment Variable | Default | Purpose |
|---|---|---|
| `DEV_SESSIONS_SANDBOX` | — | Set to `1` to enable gateway mode |
| `HOST_PATH` | — | Host-side path that `/workspace` maps to |
| `CONTAINER_WORKSPACE` | `/workspace` | Container mount point (override if using a different mount path) |
| `DEV_SESSIONS_GATEWAY_URL` | `http://host.docker.internal:6767` | Gateway endpoint |

The gateway binds to `127.0.0.1` only — not exposed beyond loopback.

### `--mode docker` (spawning Claude in a container)

Spawns Claude inside Docker via a `clauded` binary on the host. See [claude-ting](https://github.com/andrewting19/claude-ting) for a reference Docker wrapper.

> **Note:** If `clauded` is defined as a shell function in `.zshrc`, create a wrapper script so tmux (bash) can find it:
> ```bash
> #!/bin/zsh
> source ~/.zshrc 2>/dev/null
> claude-docker "$@"
> ```
> at `~/.local/bin/clauded`.

---

## Known Limitations

- **Codex ignores `--mode`**: Always runs with `approvalPolicy: never` / full access regardless of mode flag.
- **`docker` mode is Claude-only**: Codex + Docker not implemented.
- **Session store uses file locking**: Concurrent operations are serialized via lockfile. A crashed process holding the lock is auto-recovered after 30 seconds.
- **Gateway port conflict**: Default port 6767 can conflict with Docker. Use `DEV_SESSIONS_GATEWAY_PORT` to override.
- **No `respond` command**: No structured way to respond to `waiting_for_input` sessions. Only matters for non-native modes.
- **Claude permission prompts undetectable**: TUI-level prompts aren't written to JSONL — `status` reports `working` instead of `waiting_for_input`. Only affects `native` mode.

---

## Development

```bash
npm install
npm run build
npm test        # 123 unit + integration tests
npm link        # link global dev-sessions to this repo's dist/
```

See `CLAUDE.md` for developer workflow standards and `TODO.md` for current project state and remaining work.

## License

MIT
