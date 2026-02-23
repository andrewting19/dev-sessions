---
name: delegate
description: Mindset and principles for orchestrating sub-agents well. Read before delegating non-trivial work.
---

# Delegate: Agent Orchestration Mindset

For mechanics, see the `dev-sessions` skill. This is about *how to think* before you delegate.

---

## The core question before delegating

**Do you already have full context on what needs to be done and how?**

- **Yes** → be specific. Precise instructions to a sub-agent with full context are good. Vagueness wastes turns.
- **No, or uncertain** → ask the sub-agent to explore and propose first. Lock in the approach only after you've seen the proposal. Sub-agents read code you haven't; their perspective has value.

Most orchestration failures come from prescribing solutions before having enough context, then getting code that implements the wrong thing correctly.

---

## Prompting principles

- **Goal over method.** State what success looks like, not how to achieve it — unless you're certain of the how.
- **Verifiable acceptance criteria.** "All tests pass" is verifiable. "Looks clean" is not. Sub-agents use these to know when they're done.
- **Point at relevant files.** Don't make sub-agents discover context from scratch.
- **Constraints that actually matter.** "Don't change the public API" is a real constraint. Implementation preferences usually aren't.
- **Always set `--path` explicitly.** Sub-agents default to their CWD, which may not be the repo you mean.

---

## When to get multiple opinions

For non-trivial design decisions, ask Claude and Codex independently before acting. Agents that see each other's output anchor to it — keep them separate.

```bash
s1=$(dev-sessions create -q --cli claude --path /repo --description "design: X")
s2=$(dev-sessions create -q --cli codex  --path /repo --description "design: X")
dev-sessions send "$s1" --file QUESTION.md
dev-sessions send "$s2" --file QUESTION.md
dev-sessions wait "$s1" && dev-sessions last-message "$s1"
dev-sessions wait "$s2" && dev-sessions last-message "$s2"
```

Both Claude and Codex are strong. Codex tends to be more direct on implementation questions; Claude tends to reason more carefully about tradeoffs. For important decisions, hearing both is worth it.

Synthesize yourself — don't outsource the final call to either agent.

---

## When not to delegate

- The task is simple enough to do directly — delegation overhead isn't worth it
- The task requires tight back-and-forth that only you can provide
- You'd spend more time writing the brief than doing the work

---

## Handling results

- Check results against your acceptance criteria — don't just accept because the agent says it's done
- If parallel sessions produced conflicting changes, reconcile explicitly rather than merging blindly
- If a sub-agent ran for a long time and produced nothing useful, check `last-message -n 5` to understand where it got stuck, then re-engage with a more focused prompt
