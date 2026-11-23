# Changelog

## 0.7.2 - 2026-11-23

Tested end to end with Claude Code 2.1.321 and Codex CLI 0.167.0 on macOS,
natively and from a Docker container through the gateway.

- `logs` for Claude sessions no longer shows tool results or injected meta
  messages as `[HUMAN]` turns. Only text that was sent to the session appears.
- `npm run build` marks `dist/index.js` executable, so an `npm link` install
  works directly after a build.

Includes the 0.7.1 changes, which were tagged but not published to npm:

- Names with open durable messages stay reserved after the session record is
  removed, so a new task cannot inherit an older task's queue. Local and remote
  `create` and `resume` check these reservations.
- A Codex `thread not loaded` result is treated as unknown liveness. `list`
  keeps the record and its queued work.
- Retry Claude startups that produce a blank session.
- Avoid duplicate Codex poll output.
- `DEV_SESSIONS_STORE_PATH`, `DEV_SESSIONS_CODEX_DAEMON_STATE_PATH`, and
  `DEV_SESSIONS_CODEX_DAEMON_LOG_PATH` isolate state for E2E tests.
