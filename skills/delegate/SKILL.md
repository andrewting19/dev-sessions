---
name: delegate
description: Philosophy and best practices for orchestrating sub-agents. Use before delegating work to dev-sessions to reason about how to structure the delegation well.
---

# Delegate: Agent Orchestration Philosophy

This skill teaches you *how to think* about delegation, not just which commands to run.
For the mechanics (create, send, wait), see the `dev-sessions` skill.

---

## The Core Mistake: Prescribing Instead of Thinking

The most common orchestration failure is treating sub-agents as dumb executors.

**Bad:** "Rewrite `src/auth.ts` to use JWT tokens. Use jsonwebtoken@9. Store the secret in `process.env.JWT_SECRET`. Return 401 on expiry."

**Good:** "The app uses server-side sessions for auth (`src/auth.ts`). We need stateless tokens to support horizontal scaling. Propose an approach — what library, what token structure, what migration path? Don't implement yet."

The difference: the first locks in decisions before the sub-agent has read the code. The second gets you a proposal you can evaluate before committing. Sub-agents often know things you don't — they'll read the code; you may not have.

**Rule:** When in doubt, ask sub-agents to *propose* before you *prescribe*.

---

## When to Delegate vs. Do It Yourself

Delegation has overhead. Only delegate when the benefit outweighs the cost.

**Delegate when:**
- The task is genuinely parallelizable (two independent concerns)
- You want an independent opinion, not just execution
- The task requires deep reading of a part of the codebase you haven't loaded
- You want to avoid polluting your context with implementation details

**Don't delegate when:**
- The task is a single focused change you can make directly
- You'd spend more time writing the brief than doing the work
- The task requires tight back-and-forth that only you can provide
- The sub-agent will need clarification on things only you know

---

## Writing Briefs That Work

A good brief gives the sub-agent enough to succeed autonomously.

### The four elements

**1. Goal (what, not how)**
State the outcome, not the implementation. "Users should be able to reset their password by email" — not "Add a POST /reset-password endpoint that calls SendGrid."

**2. Context (what to read first)**
Point at the relevant files. Don't make the sub-agent discover everything from scratch.
```
Read first: src/auth/, tests/auth.test.ts, README.md
```

**3. Constraints (the real limits)**
Only state constraints that actually matter: "do not change the public API", "must work without a DB migration", "keep bundle under 50kb". Don't list implementation preferences as constraints.

**4. Acceptance criteria (verifiable)**
How will you know it worked? "`npm test` exits 0 and the new endpoint returns 401 for expired tokens" is verifiable. "The code looks clean" is not.

### Anti-patterns
- **Over-specification**: Telling the agent which functions to write defeats the purpose. You become responsible for the design.
- **Under-specification**: "Make auth better" produces guesswork.
- **Missing repo path**: Sub-agents default to their CWD. Always set `--path` explicitly.
- **Skipping acceptance criteria**: Without them, the agent decides when it's done. Often it decides too early or too late.

---

## Independent Review: Getting Real Signal

For non-trivial design decisions, get opinions from multiple agents *independently* before acting. Agents that see each other's output will anchor to it.

```bash
s1=$(dev-sessions create -q --cli claude --path /repo --description "auth design - claude")
s2=$(dev-sessions create -q --cli codex  --path /repo --description "auth design - codex")

dev-sessions send "$s1" --file DESIGN_QUESTION.md
dev-sessions send "$s2" --file DESIGN_QUESTION.md

dev-sessions wait "$s1" && dev-sessions last-message "$s1"
dev-sessions wait "$s2" && dev-sessions last-message "$s2"
```

Then *you* synthesize. Look for:
- Points both agree on → probably right
- Points only one raises → worth investigating, not automatically wrong
- Direct contradictions → make an explicit decision; don't average them

Do not ask one agent to review the other's output unless you specifically want critique of that output.

**Claude vs. Codex:** Both are strong but have different strengths. Codex tends to be more direct on implementation-heavy questions. Claude tends to reason more carefully about tradeoffs. For important decisions, get both.

---

## Prescriptive vs. Exploratory

Two modes. Know which you're in before writing the brief.

**Exploratory:** You want the sub-agent's judgment. You should be genuinely open to the answer. If you're not, don't ask — it wastes the turn.

**Prescriptive:** You've already decided the approach and need execution. Now be specific: exact files, exact interfaces, exact acceptance criteria. Ambiguity here causes drift.

The common mistake: sending an exploratory question when you want prescriptive execution (you get a proposal when you wanted code), or sending a prescriptive brief when you haven't thought it through (you get code implementing your half-formed idea).

---

## Synthesizing Results

When sub-agents return, your job is synthesis — not acceptance.

**Check:**
- Does the result satisfy the acceptance criteria you specified?
- Does it introduce new problems (security, performance, API breakage)?
- Is it consistent with decisions made in parallel sessions?

**When sub-agents produced conflicting changes:** Reconcile explicitly. Don't merge blindly. Understand why each made its choices, then pick the better approach.

**When a sub-agent asks a question mid-task:** Read it carefully. If it's a real ambiguity in your brief, answer it. If it's asking you to make a decision you already made, re-send the relevant constraint.

---

## Quick Reference

| Situation | Action |
|---|---|
| Non-trivial design decision | Ask agents to propose; review before prescribing |
| Need independent opinions | Fan out Claude + Codex independently; synthesize yourself |
| Parallel independent tasks | Fan out; collect; reconcile conflicts explicitly |
| Simple focused change | Just do it yourself |
| Sub-agent blocked on a question | Answer the real ambiguity; re-send constraints if it already existed |
| Sub-agents produced conflicting results | Reconcile explicitly — don't merge blindly |
| Sub-agent ran a long time but produced nothing | Check `last-message -n 5`; re-engage with a more focused prompt |
