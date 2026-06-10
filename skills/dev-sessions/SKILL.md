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

# One-shot round trip: send + wait + print reply (exits 124 on timeout)
dev-sessions ask "$sid" "Fix the off-by-one in src/parser.ts and add a test." --timeout 300

# Or step by step:
dev-sessions send "$sid" "Fix the off-by-one in src/parser.ts and add a test."
dev-sessions send "$sid" --file BRIEF.md
dev-sessions wait "$sid" --timeout 300    # blocks; exits 124 on timeout
dev-sessions last-message "$sid"

# Clean up
dev-sessions kill "$sid"
```

## Commands

```
create   [-p path] [-d desc] [--cli claude|codex] [-m native|docker] [--model m] [-q]
ask      <id> [message] [-f file] [-t seconds]   → send + wait + print reply
send     <id> [message] [-f file]
wait     <id> [-t seconds] [-i interval_seconds] [--goal | --next-turn]
last-message <id> [-n count] [--json]
status   <id>          → idle | working | waiting_for_input
goal     <id> [objective] [--budget tokens] [--pause|--resume|--clear] [--json]
list     [--json]
logs     <id>
kill     <id> | --all | --older-than <30m|72h|7d>
```

## Goals (codex only) — autonomous multi-turn objectives

A **goal** makes a codex session work autonomously across turns until the objective
is verifiably complete — the codex runtime keeps re-prompting the agent itself; you
don't need to keep sending messages. This maps to Codex's `/goal` feature.

```bash
sid=$(dev-sessions create -q --cli codex --path /repo)

# Set the objective — the agent starts pursuing it immediately
dev-sessions goal "$sid" "Make all tests in tests/unit pass, then mark the goal complete." --budget 200000

# Block until the goal settles; prints terminal status:
# complete | paused | blocked | usageLimited | budgetLimited
dev-sessions wait "$sid" --goal --timeout 1800

# Or supervise turn-by-turn: returns at the next turn boundary (goal
# continuations are server-initiated, so plain `wait` would ride through them)
dev-sessions wait "$sid" --next-turn --timeout 600
dev-sessions last-message "$sid"      # inspect progress, then loop or intervene

# Inspect anytime (--json for structured: objective, status, tokensUsed, tokenBudget…)
dev-sessions goal "$sid" --json

# Lifecycle control
dev-sessions goal "$sid" --pause
dev-sessions goal "$sid" --resume
dev-sessions goal "$sid" --clear
```

Notes:
- Prefer goals over manual send/wait loops for open-ended objectives ("make X true")
  on codex sessions; use `ask`/`send` for single bounded tasks.
- Phrase the objective as a verifiable end state. The agent marks the goal
  `complete` only when evidence proves it, and `blocked` if truly stuck.
- `--budget` caps token spend; the goal lands in `budgetLimited` when hit
  (resume with `--resume` after raising the budget).
- Setting a new objective always (re)activates the goal, including after a
  previous goal completed.

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
