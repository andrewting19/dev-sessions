---
name: dev-sessions
description: Spawn, manage, and communicate with other coding agent sessions for parallel work delegation. Use when tasks can be parallelized or when handing off work.
allowed-tools: Bash(dev-sessions:*)
---

# dev-sessions: Parallel Agent Delegation

Spawn Claude Code sessions, delegate tasks, collect results.

Sessions get auto-generated **champion IDs** (e.g. `fizz-top`) — use these in all commands.

## Standard Workflow

```bash
# Create (defaults: --cli claude --mode yolo --path <cwd>)
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
create   [-p path] [-d desc] [--cli claude|codex] [-m yolo|native|docker] [-q]
send     <id> [message] [-f file]
wait     <id> [-t seconds] [-i interval_seconds]
last-message <id> [-n count]
status   <id>          → idle | working | waiting_for_input
list     [--json]
kill     <id>
```

## Key Flags

- `--mode yolo` (default) — auto-approves all tool calls. **Always use for unattended delegation.**
- `--path` — defaults to your CWD. Set explicitly when delegating to a different repo.
- `-q` on `create` — prints only the champion ID, ideal for `sid=$(...)` capture.

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

## Writing Good Task Briefs

```
Repo: /abs/path/to/repo
Goal: <what to implement>
Read first: src/foo.ts, tests/foo.test.ts
Constraints: do not modify generated files
Acceptance: all tests pass, new behavior verified in <test>
```
