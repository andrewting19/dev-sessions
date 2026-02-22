---
name: dev-sessions
description: Spawn, manage, and communicate with other coding agent sessions for parallel work delegation. Use when tasks can be parallelized or when handing off work.
allowed-tools: Bash(dev-sessions:*)
---

# dev-sessions: Parallel Agent Delegation

Use `dev-sessions` to offload work to other coding-agent sessions while you continue orchestrating, reviewing, and integrating.

## Quick Reference

```bash
# Create sessions
dev-sessions create --description "backend API hardening"
dev-sessions create --path /path/to/repo --mode native -q

# Send work
dev-sessions send fizz-top "Implement task from TODO.md"
dev-sessions send fizz-top --file BRIEF.md

# Monitor and collect
dev-sessions status fizz-top
dev-sessions wait fizz-top --timeout 600 --interval 3
dev-sessions last-message fizz-top --count 2
dev-sessions list

# Cleanup
dev-sessions kill fizz-top

# Install this skill
dev-sessions install-skill --global
dev-sessions install-skill --local --claude
dev-sessions install-skill --global --codex
```

## Delegate vs Do It Yourself

Delegate when:
- The task can run in parallel with your current work.
- The scope is large enough to benefit from independent execution.
- A different expertise area is needed (for example frontend vs backend).
- Your own context window is getting long and you want to isolate sub-work.

Do it yourself when:
- The task is trivial or faster to complete directly.
- The task depends heavily on your current conversation context.
- The change is a quick fix where delegation overhead would dominate.

## Writing Strong Task Briefs

Include:
- Context: repo path, subsystem, and what the delegate is expected to own.
- Constraints: coding standards, forbidden changes, environment limitations.
- Acceptance criteria: exact behavior or checks that define done.
- File pointers: specific files to read first.
- Why: the intent behind the task so the delegate can make good tradeoffs.

Brief template:

```text
Repo: /abs/path/to/repo
Goal: <what to implement>
Why: <business/technical reason>
Read first:
- src/moduleA.ts
- tests/moduleA.test.ts
Constraints:
- Do not modify generated files
- Preserve existing CLI behavior
Acceptance criteria:
- All related tests pass
- New behavior verified in <specific test>
```

## Delegation Patterns

### Fire-and-Forget (Handoff)

Use when user will check output later.

```bash
sid=$(dev-sessions create -q --description "handoff")
dev-sessions send "$sid" --file HANDOFF.md
# Done for now; no immediate follow-up needed.
```

### Synchronous Delegation

Use when you need result before continuing.

```bash
sid=$(dev-sessions create -q --description "implement parser fix")
dev-sessions send "$sid" "Fix parser bug in src/parser.ts and add tests."
dev-sessions wait "$sid"
dev-sessions last-message "$sid"
```

### Fan-Out

Use when independent tasks can run in parallel.

```bash
s1=$(dev-sessions create -q --description "frontend")
s2=$(dev-sessions create -q --description "backend")
dev-sessions send "$s1" --file FRONTEND_BRIEF.md
dev-sessions send "$s2" --file BACKEND_BRIEF.md
dev-sessions wait "$s1"
dev-sessions wait "$s2"
dev-sessions last-message "$s1"
dev-sessions last-message "$s2"
```

### Iterative Delegation

Use when delegate output informs the next prompt.

```bash
sid=$(dev-sessions create -q --description "iterative refactor")
dev-sessions send "$sid" "Step 1: propose refactor plan for src/cache.ts."
dev-sessions wait "$sid"
dev-sessions last-message "$sid"
dev-sessions send "$sid" "Step 2: implement approved plan and add tests."
dev-sessions wait "$sid"
dev-sessions last-message "$sid"
```

## Polling Best Practices

- Prefer `dev-sessions wait <id>` instead of manual polling loops.
- If polling manually:
  - Check `dev-sessions status <id>` first.
  - Read output with `dev-sessions last-message <id>` only when status is `idle`.
- For complex tasks, wait 30-60 seconds between status checks.

## Anti-Patterns

- Delegating tasks that are quicker to do directly.
- Sending vague briefs without file references or acceptance criteria.
- Polling every few seconds for long-running work (wastes tokens).
- Reading `last-message` repeatedly without checking status first.
