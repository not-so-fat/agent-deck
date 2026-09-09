# Dashboard bootstrap entry (1.7.1)

**Status:** Approved · **Ship:** v1.7.1

## Problem

After trusted sessions (1.7.0), the dashboard requires an HttpOnly cookie from `/?bootstrap=<nonce>`. Bare `http://127.0.0.1:1111` always shows **Error Loading Data / No valid workspace grant** — that is a **dashboard session cookie** miss (fix: `start` / `open`), not MCP `GRANT_REQUIRED` (fix: `agent-deck use <deck>`). Most entry points still printed or linked that bare URL (`start` without `--open`, `setup --start`, `status`, menubar).

## Design (approach B)

Never treat a bare dashboard origin as a useful user link.

1. **`agent-deck start`** opens the browser with a bootstrap URL **by default** (foreground + daemon). Opt out: `--no-open` or `AGENT_DECK_NO_OPEN=1`. `--open` remains accepted (no-op when already default).
2. **`setup --start`** starts with `openBrowser: true`.
3. **`agent-deck open [--path <path>]`** mints a nonce and opens the system browser (menubar / recovery).
4. **Printed Dashboard lines** (`start`, daemon, `status`) prefer a fresh bootstrap URL; on mint failure, print bare origin plus `agent-deck open`.
5. **Menubar** uses `bash=agent-deck` / `param1=open` (and `--path` for approval deep links) so each click gets a fresh nonce — no nonce spam on every SwiftBar refresh.
6. **Frontend** awaits bootstrap session exchange **before** mounting `QueryClientProvider` / first API queries.

## Out of scope

- Persisting dashboard cookies across process restarts
- `get_playbook` / workspace-grant MCP launcher issues (separate)
