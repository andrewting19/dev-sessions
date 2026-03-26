---
name: delegate
description: Mindset and principles for orchestrating sub-agents well. Read before delegating non-trivial work.
---

# Delegate: Agent Orchestration Mindset

For mechanics, see the `dev-sessions` skill. This is about *how to think* as an orchestrator.

---

## Before you delegate: get clear yourself

The orchestrator's own clarity is the bottleneck. If you delegate before you've thought clearly about what you actually want, no prompting principle saves you. Before writing a brief, ask: do I understand the problem well enough to recognize a good solution when I see one? If not, think it through first — or use a sub-agent to explore, not to implement.

This skill was itself written this way: rather than handing over a spec, the underlying mental model was communicated and refined until there was shared understanding, then execution was trusted. The result is better than any prescriptive brief would have produced.

---

## The mental model

Your job as orchestrator is **judgment and synthesis** — holding the big picture, making decisions, staying at the right altitude. Sub-agents are your specialists: highly intelligent, capable of going deep on a focused problem. Your constraint is context window. Theirs is scope.

This division of labor only works if you respect it. Your context window is finite and irreplaceable mid-session — every line spent on implementation detail is a line you can't spend on judgment later. Let sub-agents handle depth; they have a fresh context for it. But don't delegate judgment — they're optimizing locally and can't see how their piece fits the whole. That's your job.

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
- **Why this matters and what should guide decisions** — the reasoning behind the task, not just the boundaries. Constraints tell an agent what it can't do; principles tell it how to think. An agent that understands *why* you want something makes better calls on everything you didn't think to specify. Hard constraints are worth stating when they exist, but they're a supplement to reasoning, not a replacement.
- **Always set `--path`** — without it, a sub-agent operates on whatever directory it happens to be in, which may not be your repo. Wrong path means it reads wrong context, writes to wrong files, or fails silently.

What to avoid: over-specifying how to implement something when you're not certain it's right. You become responsible for a design decision you made without full context.

---

## Multiple perspectives: worth it sometimes, not always

Getting Claude and Codex to independently explore a design question before you commit is valuable — but each session costs time and context. The payoff is highest for decisions that are hard to reverse or high-stakes, where seeing two independent takes genuinely changes the quality of your decision. For smaller calls, the overhead isn't worth it.

```bash
s1=$(dev-sessions create -q --cli claude --path /repo --description "design: X")
s2=$(dev-sessions create -q --cli codex  --path /repo --description "design: X")
dev-sessions send "$s1" --file QUESTION.md
dev-sessions send "$s2" --file QUESTION.md
dev-sessions wait "$s1" && dev-sessions last-message "$s1"
dev-sessions wait "$s2" && dev-sessions last-message "$s2"
```

Keep them independent — agents that see each other's output anchor to it. Synthesize yourself. Claude is faster and more general-purpose; Codex excels at deep, complex implementation tasks and follows detailed instructions exceptionally well.

For smaller decisions: explore quickly yourself, or just delegate with a clear brief if you already understand the problem.

---

## Synthesizing results

Results come back to you for judgment, not acceptance. Each sub-agent optimized locally within its own scope — it doesn't know what the other agents did or how its work fits the whole. That's why you check results against your acceptance criteria and reconcile conflicts between parallel sessions explicitly. Merging blindly is how you get subtly inconsistent code that passes each agent's local checks but breaks in integration.

If something produced nothing useful, check `last-message -n 5` to understand where it got stuck, then re-engage with a more focused prompt.

The synthesis step is where your value as orchestrator lives. It's the one thing sub-agents structurally cannot do for you.
