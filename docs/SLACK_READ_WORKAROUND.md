# Slack read-only workaround (skip official MCP)

> **Historical (2026-06-28)** — This record captures an earlier design, proposal, or verification run. See [the current guide](OAUTH_AND_HOSTING.md) for shipped behavior.


When the goal is **read recent DMs + channels** without `mcp.slack.com`. **Big picture:** [OAUTH_AND_HOSTING.md](./OAUTH_AND_HOSTING.md).

Official Slack MCP imposes: registered app, MCP toggle, public distribution / Marketplace, confidential OAuth. That’s built for Slack’s partner-scale remote MCP product—not for “let my agent read my threads.”

## What you actually need

| Goal | API | Token | Scopes (user token) |
|------|-----|-------|---------------------|
| List DMs / channels joined | `conversations.list` | `xoxp-…` user token | `im:read`, `mpim:read`, `channels:read`, `groups:read` |
| Read recent messages | `conversations.history` | `xoxp-…` | `im:history`, `mpim:history`, `channels:history`, `groups:history` |
| Resolve names | `users.info` | `xoxp-…` | `users:read` |
| Post (optional) | `chat.postMessage` | `xoxp-…` | `chat:write` |

Use a **user token** (`xoxp-`), not a bot token (`xoxb-`). Bots don’t see your DMs; they only see channels they’re invited to.

## Workaround A — User token in Agent Deck vault (simplest today)

**Best for:** single workspace, read-first, you’re OK with “connect my Slack once.”

1. User creates an **internal** Slack app in **their own workspace** (no public distribution, **no MCP toggle**).
2. Add **User Token Scopes** only (read list above).
3. **Install to workspace** → copy **User OAuth Token** (`xoxp-…`).
4. Store in Agent Deck as a credential (same pattern as `cred_slack` / `SLACK_BOT_TOKEN` in playbooks—use user token instead).

Agent Deck (or a small connector) calls Slack Web API directly—no remote MCP.

**Pros:** No Marketplace, no Agent Deck shared secret, no `mcp.slack.com` policy.  
**Cons:** User still creates a Slack app once (lighter than full MCP setup); paste token unless we add a short OAuth wizard for *their* app only.

Minimal manifest (read-only) — user: **Create from manifest** in **their** workspace:

```json
{
  "display_information": { "name": "Agent Deck (read)" },
  "oauth_config": {
    "redirect_urls": ["http://localhost:8000/api/oauth/callback"],
    "scopes": {
      "user": [
        "channels:read",
        "channels:history",
        "groups:read",
        "groups:history",
        "im:read",
        "im:history",
        "mpim:read",
        "mpim:history",
        "users:read",
        "chat:write"
      ]
    }
  }
}
```

No `bot_user`, no MCP feature—internal app for one workspace only.

## Workaround B — Local stdio Slack MCP + token

**Best for:** want MCP tools without `mcp.slack.com`.

Community servers (e.g. [slack-messages](https://github.com/cardmagic/slack-messages), [slack-mcp-server](https://github.com/korotovsky/slack-mcp-server)) take `SLACK_USER_TOKEN` / `xoxp-` in env.

- Add as Agent Deck **`local-mcp`** service
- Point env at vault credential
- User still obtains `xoxp-` once (same as A)

**Pros:** MCP tool surface without Slack’s remote MCP gate.  
**Cons:** Another package to run; token setup unchanged.

## Workaround C — Official remote MCP (current preset)

**Best for:** parity with Cursor/Claude tool set, posting/canvases/search tools Slack ships on MCP.

**Requires:** [SLACK_OAUTH_APP.md](./SLACK_OAUTH_APP.md) path (shared or BYO app + MCP enabled + distribution).

Keep this as the **full** path; don’t force it for read-only.

## Workaround D — Host-only

Use Slack MCP only inside **Cursor / Claude Code** (partner apps). Agent Deck documents the deck; no Slack proxy.

## Comparison

| Path | Setup pain | Read DMs | Read joined channels | Non-technical UX |
|------|------------|----------|----------------------|------------------|
| A User token + API | Medium (once per user) | ✓ | ✓ | Medium until guided OAuth |
| B Local MCP + token | Medium | ✓ | ✓ | Medium |
| C Official `mcp.slack.com` | High | ✓ | ✓ | Low unless hosted OAuth |
| D Cursor/Claude only | Low | ✓ | ✓ | High in host, none in Deck |

## Rate limit warning (read-heavy)

As of 2025, Slack tightened **`conversations.history`** for apps **not** on Marketplace / internal customer-built: about **1 request/minute**, **limit 15** messages per call. Read-heavy agents may need caching, search APIs, or Marketplace listing.

Plan for pagination + backoff if you build Workaround A/B.

## Recommended product direction for Agent Deck

1. **Near term:** Offer **“Slack (read)”** connection tier — Workaround A with read-only manifest + credential vault + thin tools (`list_conversations`, `recent_messages`). Deprioritize remote MCP preset for this persona.
2. **Medium:** Per-user OAuth wizard using **user’s internal app** (client id/secret once, then click Connect)—no global Agent Deck Slack app required for single-workspace users.
3. **Long term:** Shared app + hosted OAuth for true one-click (see [SLACK_OAUTH_APP.md](./SLACK_OAUTH_APP.md)).

## Related

- [MCP integration strategy](./MCP_INTEGRATION_STRATEGY.md)
- [SLACK_OAUTH_APP.md](./SLACK_OAUTH_APP.md)
