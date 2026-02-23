---
name: delegate
description: Mindset and principles for orchestrating sub-agents well. Read before delegating non-trivial work.
---

# Delegate: Agent Orchestration Mindset

For mechanics, see the `dev-sessions` skill. This is about *how to think* as an orchestrator.

---

## The mental model

Your job as orchestrator is **judgment and synthesis** — holding the big picture, making decisions, staying at the right altitude. Sub-agents are your specialists: highly intelligent, capable of going deep on a focused problem. Your constraint is context window. Theirs is scope.

This division of labor only works if you respect it. Don't burn your context on implementation details sub-agents can handle. Don't make decisions sub-agents are better positioned to make after reading the code. And don't delegate judgment — that's your job.

---

## Alignment before implementation

The most expensive mistake is a sub-agent that implements the wrong thing correctly. Before delegating implementation, make sure the agent's understanding of the problem matches yours.

For anything non-trivial, ask for a proposal or plan first. Read it. If it matches your mental model, say go. If it doesn't, correct the misalignment now — not after a full implementation turn. This is cheap. Rework is expensive.

This isn't a rule to follow — it's a consequence of the mental model. You're verifying shared understanding before the agent goes deep.

For simpler tasks where you already have full context and know exactly what you want, skip straight to implementation. The proposal step only earns its cost when there's real uncertainty about approach.

---

## Prompting: principles over tips

Sub-agents are intelligent. Give them enough to reason from, not a script to follow. The goal is shared understanding, not compliance.

What actually matters in a brief:
- **What success looks like** — verifiable, not subjective. "All tests pass" not "looks clean."
- **What they should read first** — don't make them discover context from scratch
- **Real constraints** — things that genuinely bound the solution, not implementation preferences
- **Always set `--path`** — sub-agents default to their CWD

What to avoid: over-specifying how to implement something when you're not certain it's right. You become responsible for a design decision you made without full context.

---

## Multiple perspectives: worth it sometimes, not always

Getting Claude and Codex to independently explore a design question before you commit is valuable — but it takes time. Reserve it for decisions that are genuinely hard to reverse or high stakes.

```bash
s1=$(dev-sessions create -q --cli claude --path /repo --description "design: X")
s2=$(dev-sessions create -q --cli codex  --path /repo --description "design: X")
dev-sessions send "$s1" --file QUESTION.md
dev-sessions send "$s2" --file QUESTION.md
dev-sessions wait "$s1" && dev-sessions last-message "$s1"
dev-sessions wait "$s2" && dev-sessions last-message "$s2"
```

Keep them independent — agents that see each other's output anchor to it. Synthesize yourself. Both Claude and Codex are strong; Codex tends to be more direct on implementation, Claude tends to reason more carefully about tradeoffs.

For smaller decisions: explore quickly yourself, or just delegate with a clear brief if you already understand the problem.

---

## Synthesizing results

Results come back to you for judgment, not acceptance. Check them against your acceptance criteria. Reconcile conflicts between parallel sessions explicitly — don't merge blindly. If something produced nothing useful, check `last-message -n 5` to understand where it got stuck, then re-engage with a more focused prompt.

The synthesis step is where your value as orchestrator lives. Don't skip it.
