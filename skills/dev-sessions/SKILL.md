---
name: dev-sessions
description: Spawn, manage, and communicate with other coding agent sessions for parallel work delegation. Use when tasks can be parallelized or when handing off work.
allowed-tools: Bash(dev-sessions:*)
---

# dev-sessions: Parallel Agent Delegation

This tool is for **you** (the agent) to use silently. Spawn sessions, send tasks, wait for results, and handle any `waiting_for_input` states yourself. Do not narrate the commands you're running or tell the user to monitor sessions — manage the full lifecycle and report outcomes when done.

Sessions get auto-generated **champion IDs** (e.g. `fizz-top`) — use these in all commands.

## Standard Workflow

```bash
# Create (defaults: --cli claude --mode native --path <cwd>)
sid=$(dev-sessions create -q --path /abs/path/to/repo --description "fix parser bug")

# Send task (inline or from file)
dev-sessions send "$sid" "Fix the off-by-one in src/parser.ts and add a test."
dev-sessions send "$sid" --file BRIEF.md

# Wait for completion (blocks; exits 124 on timeout)
dev-sessions wait "$sid" --timeout 300

# Read result
dev-sessions last-message "$sid"

# Clean up
dev-sessions kill "$sid"
```

## Commands

```
create   [-p path] [-d desc] [--cli claude|codex] [-m native|docker] [-q]
send     <id> [message] [-f file]
wait     <id> [-t seconds] [-i interval_seconds]
last-message <id> [-n count]
status   <id>          → idle | working | waiting_for_input
list     [--json]
kill     <id>
```

## Key Flags

- `--mode native` (default) — runs with `--dangerously-skip-permissions`, auto-approves all tool calls. **Always use for unattended delegation.**
- `--mode docker` — spawns the agent in a new Docker container on the host.
- `--path` — defaults to your CWD. Set explicitly when delegating to a different repo. **Inside Docker:** container paths (e.g. `/workspace/subdir`) are automatically translated to the corresponding host path — no need to know host-side paths.
- `-q` on `create` — prints only the champion ID, ideal for `sid=$(...)` capture.

## Docker Note

When running inside a Docker container, all commands are transparently relayed to the host via the gateway. Sessions spawn on the host (or in new containers via `--mode docker`), and you interact with them the same way. Container paths under `/workspace` are auto-mapped to the host project directory — just use paths as you see them locally.

## Handling `waiting_for_input`

The agent asked a question and is blocked. Send a reply to unblock:

```bash
dev-sessions last-message "$sid"          # read the question
dev-sessions send "$sid" "Yes, proceed."  # unblock
dev-sessions wait "$sid"
```

## Fan-Out Pattern

```bash
s1=$(dev-sessions create -q --description "frontend" --path /repo)
s2=$(dev-sessions create -q --description "backend"  --path /repo)
dev-sessions send "$s1" --file FRONTEND.md
dev-sessions send "$s2" --file BACKEND.md
dev-sessions wait "$s1" && dev-sessions last-message "$s1"
dev-sessions wait "$s2" && dev-sessions last-message "$s2"
```

See the `delegate` skill for how to think about structuring tasks and prompting sub-agents effectively.
