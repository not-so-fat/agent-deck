# Durable dashboard session and recovery (NOT-67)

**Status:** Implemented · **Target:** next release after v1.7.6

## Problem

Dashboard bootstrap nonces are intentionally valid for two minutes and can be consumed once, but `start` and `status` printed them as ordinary URLs. Dashboard sessions then lived only in backend memory and the cookie was browser-session-only. A reused URL, backend restart, browser restart, or fixed 12-hour expiry could therefore leave a healthy dashboard displaying `No valid workspace grant`, followed by incorrect daemon-restart guidance.

## Design

1. `agent-deck open` remains the authority-bearing entry action. It mints a short-lived nonce using the local admin secret and opens it directly; the nonce is not printed.
2. `start` and `status` print `agent-deck open` as the durable recovery instruction and never mint credentials solely for display.
3. Exchanged dashboard tokens are random opaque values. Only their SHA-256 hashes are stored in SQLite.
4. Server-side dashboard authority has a 24-hour sliding inactivity lease. Validation touches at most once per minute to avoid write amplification. Expired rows are rejected and swept.
5. The HttpOnly, SameSite=Strict cookie has a 30-day browser retention window. The server-side inactivity lease remains authoritative, so retaining a cookie does not retain expired authority.
6. The SPA always removes `bootstrap` from the address bar after an exchange attempt. It then lets protected API requests determine whether an older valid cookie already authorizes the browser.
7. `GRANT_REQUIRED` or `DASHBOARD_REQUIRED` from dashboard data loads produces `agent-deck open` recovery. Network and server errors retain health/restart troubleshooting.

## Security invariants

- A bare loopback origin never grants dashboard authority.
- Bootstrap nonce creation still requires the local admin secret.
- Nonces remain short-lived and one-shot.
- Cookie values are never stored in plaintext or printed by the CLI.
- Dashboard-session persistence does not grant MCP workspace authority.
