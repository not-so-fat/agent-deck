# Google Drive workaround

> **Historical (2026-06-28)** — This record captures an earlier design, proposal, or verification run. See [the current guide](OAUTH_AND_HOSTING.md) for shipped behavior.


Official Google Workspace **remote** MCP (`drivemcp.googleapis.com`) is powerful but painful in Agent Deck: Google Cloud project, OAuth consent screen, **two** API enables, test users, exact redirect URI, and (as of 2026) Drive MCP is still labeled **Developer Preview**.

**Agent Deck no longer seeds Gmail, Calendar, or Drive remote cards.** For Drive, use [Workaround A](#workaround-a--local-google-drive-mcp-recommended) below.

Context: [OAUTH_REQUIREMENTS.md](./OAUTH_REQUIREMENTS.md) · [MCP integration strategy](./MCP_INTEGRATION_STRATEGY.md)

## What you actually need (Drive)

| Goal | Remote MCP (`drivemcp.googleapis.com`) | Local MCP (community) |
|------|----------------------------------------|------------------------|
| Search / read files | OAuth + GCP setup | One-time Google login (Desktop OAuth) |
| Create / upload | Same | Same |
| Works in Agent Deck deck | Yes, after OAuth (register manually) | Yes — register as **local MCP** |
| Gmail / Calendar | Separate remote cards + scopes | Use separate local servers or skip |

## Workaround A — Local Google Drive MCP (recommended)

Run a **community stdio MCP server** on your machine. OAuth is handled **inside that Node process**, not by Agent Deck’s Connect button.

### Important: this is not Agent Deck OAuth

When Google shows **“Google hasn’t verified this app”**, that refers to **your Google Cloud OAuth project** (the name you chose when creating credentials), **not** Agent Deck. Agent Deck has no Google verification and does not participate in this flow.

Agent Deck only **spawns** the local MCP process over stdio. It cannot complete the browser login for you. You must authenticate **once in your terminal** before the card will work.

### Step 1 — Google Cloud (Desktop app, not Web)

1. [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → **Enable** Google Drive API (and Docs/Sheets if you need them).
2. **OAuth consent screen** → External → **Publishing status: Testing**
   - Add **your Google account under Test users** (required while app is unverified).
   - Add scopes the server needs (`drive`, `drive.readonly`, `documents`, etc.).
3. **Credentials** → Create OAuth client → Application type: **Desktop app** (not Web application).
4. Download JSON → save as e.g. `~/gcp-oauth.keys.json`.

Using a **Web application** client (meant for Agent Deck remote OAuth) will fail here.

### Step 2 — Authenticate in terminal first (required)

Run this **before** opening the card in Agent Deck:

```bash
export GOOGLE_DRIVE_OAUTH_CREDENTIALS="$HOME/gcp-oauth.keys.json"
# Avoid port clash with Agent Deck dashboard (dev uses :3000)
export GOOGLE_DRIVE_MCP_AUTH_PORT=3100

npx @piotr-agier/google-drive-mcp auth
```

When the browser opens:

1. Pick your Google account (must be a **Test user** on the consent screen).
2. On **“Google hasn’t verified this app”** → **Advanced** → **Go to … (unsafe)** — normal for personal Testing apps.
3. Approve scopes. Tokens are saved under `~/.config/google-drive-mcp/tokens.json`.

If auth fails with port errors, try another `GOOGLE_DRIVE_MCP_AUTH_PORT` (e.g. `3200`).

### Step 3 — Register in Agent Deck (Local tab)

Paste the **whole** JSON block:

```json
{
  "mcpServers": {
    "google-drive": {
      "command": "npx",
      "args": ["-y", "@piotr-agier/google-drive-mcp"],
      "env": {
        "GOOGLE_DRIVE_OAUTH_CREDENTIALS": "/Users/YOU/gcp-oauth.keys.json",
        "GOOGLE_DRIVE_MCP_TOKEN_PATH": "/Users/YOU/.config/google-drive-mcp/tokens.json",
        "GOOGLE_DRIVE_MCP_AUTH_PORT": "3100"
      }
    }
  }
}
```

Use **absolute paths**. After step 2, the server should start without opening OAuth again.

4. Add the card to your deck; bind workspace.

### If it still opens OAuth or fails from Agent Deck

| Symptom | Fix |
|---------|-----|
| Browser opens OAuth when you open the card | Step 2 not done, or token path in `localEnv` ≠ where `auth` saved tokens |
| “App not verified” / access blocked | Add your email as **Test user**; use Advanced → Continue |
| `redirect_uri_mismatch` | Wrong client type — recreate as **Desktop app** |
| Auth hangs / port error | Set `GOOGLE_DRIVE_MCP_AUTH_PORT=3100` (dashboard may use `:3000`) |
| Org Google account | Admin may block unverified third-party apps |

**Pros:** Desktop OAuth, Drive-focused, no `drivemcp.googleapis.com` preview API.  
**Cons:** One-time terminal auth; Node on your machine; Testing apps need re-auth about every 7 days (Google policy).

Other community servers (`google-mcp`, etc.) follow the same pattern: **auth in terminal first**, then register as local MCP.

## Workaround B — Remote Google Drive card (advanced BYO OAuth)

Use this only if you explicitly register the remote URL (`https://drivemcp.googleapis.com/mcp/v1`) as a custom **remote** MCP card. That flow **does** use Agent Deck’s OAuth Connect panel (Web application client).

See checklist in previous versions — enable `drivemcp.googleapis.com`, Web redirect to Agent Deck callback, etc.

## Workaround C — Drive only in Cursor / Claude (no deck)

If you only need Drive inside one IDE and not mixed with deck tools (Linear, Slack, …):

- Use the host app’s **built-in Google Drive connector** or MCP entry (one-click OAuth there).
- Keep Agent Deck for other cards; skip Google in the deck.

This matches **Tier D** in [MCP integration strategy](./MCP_INTEGRATION_STRATEGY.md): delegate auth to the host app.

## Product note (Agent Deck)

Remote Google MCP stays **manual BYO OAuth**. Local Google MCP stays **out-of-band auth** (your terminal + your GCP Desktop app). Agent Deck cannot verify your Google Cloud project for you.
