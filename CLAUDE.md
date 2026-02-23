# CLAUDE.md

Instructions for agents working on this codebase. For a full description of how the tool works, see README.md. For current project state and remaining work, see TODO.md.

## Workflow Standards

**Before starting:**
1. Read `README.md` for full project context and architecture
2. Read `TODO.md` to understand current state and what's in scope
3. Run `npm test` to confirm the baseline is green

**While working:**
- Run `npm test` after each meaningful change — don't accumulate failures
- If you add a feature or fix a bug, add a test for it
- Keep changes focused; one concern per commit

**Before finishing:**
1. `npm run build` — confirm TypeScript compiles clean
2. `npm test` — all tests must pass
3. Commit with a short imperative message, e.g. `fix Codex thread status parsing`
4. Update `TODO.md` to reflect what changed

**Publishing:**
```bash
npm version patch --no-git-tag-version   # or minor/major
npm run build
source .env   # loads NPM_TOKEN
npm publish --//registry.npmjs.org/:_authToken=$NPM_TOKEN
git add -A && git commit -m "0.x.y" && git push
# Then rebuild Docker: cd ../claude-ting && ./rebuild.sh
```

## Codebase Map

```
src/
  cli.ts                 # Command parsing (commander.js) — all commands wired here
  session-manager.ts     # Core lifecycle — routes between backends, owns store mutations
  session-store.ts       # JSON persistence at ~/.dev-sessions/sessions.json
  champion-ids.ts        # Human-friendly ID generation (LoL champion + role)
  types.ts               # Shared types
  backends/
    claude-tmux.ts       # Claude: tmux + JSONL transcript parsing
    codex-appserver.ts   # Codex: WebSocket JSON-RPC 2.0 client + daemon management
  transcript/
    claude-parser.ts     # Parses Claude JSONL transcripts
  gateway/
    server.ts            # Express HTTP relay (Docker → host)
    client.ts            # Gateway client (used when IS_SANDBOX=1)
    daemon.ts            # launchd/systemd install/uninstall/status
skills/
  dev-sessions/SKILL.md  # /dev-sessions skill
  handoff/SKILL.md       # /handoff skill
tests/
  unit/                  # Fast, mocked
  integration/           # Hits real tmux, real Codex app-server
```

## Non-Obvious Gotchas

- **Codex `ThreadStatus` JSON shape**: As of codex-cli 0.104.0 (the current stable release), `thread.status` is **absent** when idle — the field doesn't exist in the response at all. `"active"` is `{ "active": { "activeFlags": [...] } }`. Do NOT look for a `.type` field. NOTE: the Rust source in `/tmp/codex` (pinned to the last commit before 0.104.0 was published — `1946a4c4`) shows `thread.status` was added *after* 0.104.0 shipped. When 0.105.0 stable releases, the shape will change to tagged objects like `{"type":"idle"}` and the parser will need updating. Always verify protocol behavior against the pinned `/tmp/codex` source AND the live binary — they may differ across releases.

- **Inspecting Codex protocol source**: `/tmp/codex` is a clone of the openai/codex repo pinned to commit `1946a4c4` (last commit before 0.104.0 was published Feb 18 2026 07:13 UTC). To check what a future version adds, use `git -C /tmp/codex log --oneline --format="%h %aI %s"` to find commits by date. When the installed binary is updated, re-pin `/tmp/codex` to the matching commit.

- **`send` is non-blocking**: Returns after `turn/started` (Codex) or after tmux send-keys (Claude). `wait` is the blocking primitive. Tests that assume send blocks will need updating.

- **Codex state lives in-process**: `assistantHistory`, `lastTurnStatus` etc. are in-memory on the backend instance. Each CLI invocation is a new process — don't trust in-memory state across invocations. Always reconcile against the app-server or session store.

- **Session store has no locking**: Read-modify-write on `~/.dev-sessions/sessions.json` is not atomic. Concurrent CLI calls can race. Known issue, tracked in TODO.md.

- **tmux tri-state liveness**: `sessionExists()` returns `'alive' | 'dead' | 'unknown'`. Only prune on `'dead'`. `'unknown'` (unexpected tmux error) should preserve the session record.

- **Gateway binds to 127.0.0.1**: Security default. Don't change this without a good reason.

- **NVM + launchd**: The gateway daemon plist invokes `node` via `process.execPath` (absolute path). launchd has a minimal PATH and won't find NVM-managed node otherwise.

- **`npm link` means changes are live**: The globally installed `dev-sessions` binary points to `dist/`. Run `npm run build` after source changes or your CLI won't reflect them. This also means bugs in new code will affect the dev-sessions sessions you spin up to do the work.
