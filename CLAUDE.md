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
    grok-appserver.ts    # Grok Build: authenticated WebSocket ACP client + daemon
  transcript/
    claude-parser.ts     # Parses Claude JSONL transcripts
  gateway/
    server.ts            # Express HTTP relay (Docker → host)
    client.ts            # Gateway client (used when DEV_SESSIONS_SANDBOX=1)
    daemon.ts            # launchd/systemd install/uninstall/status
skills/
  dev-sessions/SKILL.md  # CLI operating guide
tests/
  unit/                  # Fast, mocked
  integration/           # Hits real tmux, real Codex app-server
```

## Non-Obvious Gotchas

- **Codex `ThreadStatus` JSON shape**: The parser in `extractThreadRuntimeStatus` handles three formats: (1) **0.104.0**: `thread.status` is **absent** when idle; `"active"` is `{ "active": { "activeFlags": [...] } }`. (2) **0.105.0+**: tagged objects like `{ "type": "active", "activeFlags": [] }` or `{ "type": "idle" }`. (3) String values like `"idle"`, `"notLoaded"`, `"systemError"`. All three are supported simultaneously. Additionally, `getThreadRuntimeStatus` gracefully handles "no rollout found" errors from `thread/resume` by returning `'notLoaded'` instead of throwing.

- **Inspecting Codex protocol source**: Do not trust an old fixed checkout or the installed CLI version. First read the running app-server version from its `initialize` result, then check both that tag and the installed CLI tag in the OpenAI Codex repository (`rust-vX.Y.Z`). Protocol types live in `codex-rs/app-server-protocol/src/protocol/`; app-server behavior and tests live in `codex-rs/app-server/`.

- **Codex models are account-dependent**: never hardcode a default model — `gpt-5.3-codex` getting rejected (400 on ChatGPT accounts) broke every new session, and the failure is silent (turn persisted as `completed` with no output, thread → `systemError`). dev-sessions omits `model` from `thread/start`/`thread/resume` unless the user passes `create --model`, letting codex resolve its configured default.

- **Grok uses its public ACP server**: use `grok agent serve` on loopback, not tmux or headless-output parsing. The server persists in-flight work across client disconnects. `send` must keep its client-minted prompt ID, and `wait` must prefer the durable replayed `turn_completed` event for that exact ID. The private server secret appears in Grok's startup log, so both the daemon state file and log must remain mode `0600`.

- **Goals (`/goal`)**: `thread/goal/set|get|clear` JSON-RPC methods, stable + default-enabled since codex 0.133.0. Setting an active goal on an idle thread immediately starts an autonomous continuation turn server-side (no `turn/start` needed); the daemon keeps driving turns until the goal is terminal. `dev-sessions goal` always sends `status: 'active'` together with a new objective, because objective-only updates on a `complete` goal leave it complete and nothing runs.

- **`send` is non-blocking**: Returns after `turn/started` (Codex) or after tmux send-keys (Claude). `wait` is the blocking primitive. Tests that assume send blocks will need updating.

- **Codex state lives in-process**: `assistantHistory`, `lastTurnStatus` etc. are in-memory on the backend instance. Each CLI invocation is a new process — don't trust in-memory state across invocations. Always reconcile against the app-server or session store.

- **Session store locking**: All read-modify-write operations on `~/.dev-sessions/sessions.json` use the `mkdir` lock in `SessionStore`. Event code that must compare a current turn ID before it writes must use `updateSessionAtomically()` so the check and update share one lock.

- **Codex status projection**: The gateway owns one projector connection per host. It consumes global `thread/status/changed` notifications and reconciles only active/latch records plus loaded tracked threads. Never resume every stored thread, and never retain item deltas in the projector. Remote Codex work needs a gateway on the remote host.

- **tmux tri-state liveness**: `sessionExists()` returns `'alive' | 'dead' | 'unknown'`. Only prune on `'dead'`. `'unknown'` (unexpected tmux error) should preserve the session record.

- **Gateway binds to 127.0.0.1**: Security default. Don't change this without a good reason.

- **NVM + launchd**: The gateway daemon plist invokes `node` via `process.execPath` (absolute path). launchd has a minimal PATH and won't find NVM-managed node otherwise.

- **`npm link` means changes are live**: The globally installed `dev-sessions` binary points to `dist/`. Run `npm run build` after source changes or your CLI won't reflect them. This also means bugs in new code will affect the dev-sessions sessions you spin up to do the work.
