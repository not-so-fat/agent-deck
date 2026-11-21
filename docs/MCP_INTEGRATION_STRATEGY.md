# MCP integration strategy

> **Historical (2026-06-28)** — This record captures an earlier design, proposal, or verification run. See [the current guide](OAUTH_AND_HOSTING.md) for shipped behavior.


Product notes on MCP OAuth and connection tiers. **Requirements overview:** [OAUTH_REQUIREMENTS.md](./OAUTH_REQUIREMENTS.md). **Operational setup:** [OAUTH_AND_HOSTING.md](./OAUTH_AND_HOSTING.md). **Node / install:** [SETUP.md](./SETUP.md).

## OAuth and status (shipped vs deferred)

### Shipped

| Area | Behavior |
|------|----------|
| **Token without expiry** | Access tokens with no `expires_at` are treated as valid (`isOAuthAccessTokenExpired` returns false when expiry is missing). |
| **Status endpoint** | `GET /api/oauth/:serviceId/status` returns `authenticated: hasToken && !isExpired` plus `hasToken`, `isExpired`, `hasRefreshToken`, `expiresAt`. |
| **Collection warnings** | MCP OAuth warnings use stored token + discovery context; dashboard calls use `x-agent-deck-client: dashboard` so warnings do not require an `Authorization` header on the API. |
| **Frontend status query** | Service details modal polls `/api/oauth/:id/status` when MCP discovery reports OAuth required; stops polling once `authenticated` is true. |
| **Token storage** | Client secrets + access/refresh tokens in macOS Keychain (`OAuthClientSecretVault`, `OAuthTokenVault`); see [SETUP.md](./SETUP.md#secrets--oauth-storage). |

### Deferred

- **Auth profiles on presets** — seeded cards do not carry per-vendor OAuth app presets or connection tiers.
- **RFC 8707 resource parameter** — not sent on authorize/token requests yet.
- **CIMD (Client ID Metadata Documents)** — dynamic registration without stored client secret not implemented.
- **Post-callback polish** — deep-link back to dashboard, clearer error surfaces, and idempotent callback handling if gaps appear in the field.

## Architecture direction (not implemented)

### MCP hub is the right shape

Agent Deck should remain an **MCP hub**: one agent-facing endpoint, deck-scoped tool surface. The hard part is **OAuth policy per vendor**, not the MCP protocol itself.

### Tiered connection catalog

| Tier | User action | Examples |
|------|-------------|----------|
| **Auto** | DCR + PKCE, minimal setup | Linear, Notion (when vendor allows) |
| **BYO OAuth app** | User creates OAuth app, pastes client id/secret | Google, Slack |
| **BYO credential / PAT** | API key or personal token in vault | GitHub PAT, custom MCP |
| **Host-only** | Auth delegated to Cursor / Claude | Native connectors in IDE |
| **Local stdio** | User runs process locally | Obsidian, custom scripts |

### Provider reality (default seeded cards)

| Card | Typical auth path | Notes |
|------|-------------------|-------|
| Linear | Auto (DCR/PKCE) | Works with current auto-setup flow |
| Notion | Auto | Similar to Linear |
| GitHub | BYO OAuth or PAT | Hosted at api.githubcopilot.com; all GitHub users; Copilot only for specific tools |
| Google (Gmail / Calendar / Drive) | Local stdio or BYO remote | Not seeded — remote MCP needs GCP + preview APIs; see GOOGLE_DRIVE_WORKAROUND.md |
| Slack | BYO OAuth app | Slack requires a registered app for non-partner MCP clients; see below |
| Draw.io | Variable | Remote MCP may have no OAuth; may need alternate auth |
| Figma | BYO OAuth app | Not seeded — vendor allowlist blocks third-party OAuth today |
| Docmost | BYO instance URL | Not seeded (self-hosted) |
| Obsidian | Local stdio | Not seeded as remote preset |

### Alternatives considered

| Approach | Pros | Cons |
|----------|------|------|
| **Native plugins / connectors** | Best UX per host; uses host OAuth | Fragmented; not deck-portable |
| **OAuth broker (Nango, etc.)** | Faster vendor coverage | Extra dependency, cost, trust boundary |
| **Delegate auth to host app** | Zero secret handling in Agent Deck | Deck tools not portable across clients |
| **Single SaaS OAuth app (Agent Deck-owned)** | One-click for users | Vendor approval, compliance, rate limits |

### Recommended hybrid

- **MCP** = stable agent-facing interface (tools, resources, deck binding).
- **Connectors** = per-app modules that own auth tier, discovery, and token refresh.
- Preset cards advertise **connection tier + setup steps**, not only a URL.

## Connection capability matrix (default presets)

| Preset | MCP remote | OAuth auto | BYO app | PAT / header | Local stdio |
|--------|------------|------------|---------|--------------|-------------|
| Linear | ✓ | ✓ | — | — | — |
| Notion | ✓ | ✓ | — | — | — |
| GitHub | ✓ | — | ✓ | ✓ | — |
| Google Drive (manual local) | — | — | — | — | ✓ |
| Google remote MCP (manual) | ✓ | — | ✓ | — | — |
| Slack | ✓ | — / managed | ✓ | — | — |
| Figma | ✓ | — | ✓ (allowlist) | — | — |
| Draw.io | ✓ | ? | ✓ | ✓ | — |
| Obsidian (manual) | — | — | — | ✓ | ✓ |

Legend: **✓** = supported path today or planned first-class; **?** = vendor-dependent; **—** = not applicable.

## Slack MCP — why a “Slack app” is required

Slack’s hosted MCP (`https://mcp.slack.com/mcp`) does **not** support Dynamic Client Registration. Official docs state that MCP clients must be backed by a **registered Slack app** with a fixed client ID ([Slack MCP server](https://docs.slack.dev/ai/slack-mcp-server/)).

| Client | What the user sees |
|--------|-------------------|
| **Cursor, Claude Code, Claude.ai, Perplexity** | One-click — Slack pre-registered OAuth apps for these partners |
| **Agent Deck (and other third-party hubs)** | Must supply **your** app’s Client ID + Secret, then complete user OAuth |

This is **OAuth client identity**, not “building a Slack product.” You are registering who is allowed to run the MCP OAuth flow on your behalf. Workspace admins can approve that app like any other internal Slack app.

**On api.slack.com/apps:** choose **Create New App → From scratch** (one-time). Name it, pick workspace, then enable MCP under Agents & AI Apps, set redirect URL and scopes, copy Client ID/Secret into Agent Deck.

**Required beyond redirect URL + scopes (easy to miss):**

- **Agents & AI Apps → enable MCP** on the Slack app
- **PKCE** opt-in under OAuth & Permissions (recommended)
- App must be **internal** or **marketplace-published** (unlisted apps cannot use MCP)
- Some authorize flows need a minimal **bot user** even though MCP uses user tokens at runtime

| **Managed (Agent Deck–owned app)** | One-click when env/host holds secret | Slack (when `AGENT_DECK_SLACK_*` set) |

### Slack: path to non-technical users

1. **Now (maintainers):** Register one Slack app — see [SLACK_OAUTH_APP.md](./SLACK_OAUTH_APP.md). Set `AGENT_DECK_SLACK_CLIENT_ID` + `AGENT_DECK_SLACK_CLIENT_SECRET` → `setupMode: managed`.
2. **Next (hosted):** OAuth callback on `agent-deck.dev` so end users never touch env vars or manifests.
3. **Long-term:** Slack Marketplace / partner listing (Cursor-style).
4. **Alternatives if hosted is not ready:** OAuth broker; host-only Slack in Cursor/Claude; do not promise one-click Slack on pure local OSS without secrets.

## Helping users with hard setups (shipped vs planned)

| Help | Status | Notes |
|------|--------|-------|
| Pre-filled Slack app manifest + Copy manifest / Open creator | Shipped | `docs/examples/slack-mcp.manifest.json`; UI buttons in OAuth panel |
| Connection tier badge on cards (“~10 min manual”) | Planned | Surface `setupMode` on preset cards |
| Agent Deck–owned OAuth apps | Shipped (Slack env) | Hosted HTTPS + secrets; see SLACK_OAUTH_APP |
| OAuth broker integration | Planned | Nango-style; tradeoffs in alternatives table |
| Bearer token / vault credential path | Planned | Skip OAuth UI for power users |
| Interactive `agent-deck setup slack` CLI wizard | Planned | Same steps, terminal checklist |

## Next implementation steps (suggested)

1. Tag each preset with `connectionTier` in seed data and surface it in the service details UI.
2. Split OAuth flows: `auto-setup` vs `manual-credentials` vs `vault-token`.
3. Add RFC 8707 `resource` when discovery provides resource metadata.
