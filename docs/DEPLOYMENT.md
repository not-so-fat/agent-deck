# Single-host deployment

Agent Deck ships one OCI image with two commands: `backend` serves the dashboard/API and
`mcp` serves the authenticated MCP endpoint. Both commands use the same image version.
The supported topology is **one backend replica and one MCP replica on one host**.

Do not scale either role horizontally. The SQLite cache and live MCP session state are
single-host state; multiple replicas can disagree about grants and sessions and can contend
for SQLite. High availability and Kubernetes are intentionally outside this deployment.

## Persistent data and required configuration

Mount one persistent volume at **`/data`** in both roles. It contains the file store,
encrypted vault envelopes, and `agent_deck.db`, the SQLite cache. Back up `/data`, but keep
the vault key separately; a volume backup without its key is intentionally unreadable.

The backend requires these secrets/settings:

| Variable | Purpose |
| --- | --- |
| `AGENT_DECK_VAULT_KEY` | 32 random bytes encoded as base64 or 64 hex characters. Generate with `openssl rand -base64 32`. |
| `AGENT_DECK_OWNER_BOOTSTRAP_SECRET` | One-time owner sign-in/bootstrap secret; store it in the platform secret manager. |
| `AGENT_DECK_PUBLIC_URL` | Public HTTPS origin, for example `https://deck.example.com`. |
| `AGENT_DECK_HOSTED_MODE` | Must be exactly `1`. |

The image fixes `AGENT_DECK_HOME=/data`. The MCP role additionally uses
`AGENT_DECK_BACKEND_URL=http://backend:8000`; that control hop is service-network-only and
must not be routed over the public internet.

## Docker Compose on a VPS

Install Docker Engine with the Compose plugin, clone this repository, and check out the release
tag or commit you intend to deploy. Create an `.env` next to `compose.yaml`; use that same
immutable tag or commit for both image variables:

```dotenv
AGENT_DECK_IMAGE=agent-deck:<version-or-commit>
AGENT_DECK_VERSION=<version-or-commit>
AGENT_DECK_PUBLIC_URL=https://deck.example.com
AGENT_DECK_VAULT_KEY=<base64-or-hex-key>
AGENT_DECK_OWNER_BOOTSTRAP_SECRET=<long-random-bootstrap-secret>
```

Build the one image from that checkout, then start exactly one copy of each role. The MCP
service has no separate build: it uses the image produced by the backend build entry.

```bash
docker compose build --pull backend
docker compose up -d --scale backend=1 --scale mcp=1
docker compose ps
curl --fail http://127.0.0.1:8000/readyz
```

There is currently no published `ghcr.io/not-so-fat/agent-deck` image. Do not run
`docker compose pull` unless your deployment team has separately published the exact image
named by `AGENT_DECK_IMAGE`.

The compose ports bind to loopback by default. Terminate HTTPS in the host's existing reverse
proxy: route the public dashboard origin to `127.0.0.1:8000` and the MCP hostname/path to
`127.0.0.1:3001`. TLS/ingress hardening is handled in WS6; do not expose either plain-HTTP
port directly. After TLS is configured, open `AGENT_DECK_PUBLIC_URL`, verify the owner sign-in
page loads, and verify `https://deck.example.com/readyz` returns 200. Record that dated VPS
check in the pull request; it is an operator gate, not a CI claim.

## Health semantics

- `GET /healthz` is liveness only. A 200 means the HTTP process can answer; it does not say
  the vault or persistent state is usable.
- `GET /readyz` is readiness. It returns 200 only after the vault key parses, `/data` accepts
  a write/delete probe, and SQLite answers a query.
- A 503 body has only a stable, non-secret reason: `vault_key_missing`, `vault_key_invalid`,
  `data_not_writable`, or `sqlite_unavailable`.

Compose uses `/readyz` to gate the MCP role. The image-level OCI health check uses `/healthz`
so process liveness remains distinguishable from operator configuration readiness.

Both processes handle SIGTERM by refusing new connections, draining in-flight work, closing
MCP sessions and SQLite, and exiting zero. Compose gives that drain up to 10 seconds. Runtime
application logs are newline-delimited JSON on stdout.

## Railway template (two services, same image)

Create two Railway services from the same repository revision and Dockerfile; pin both builds
to the same immutable tag or commit. Do not give either service more than one replica:

| Setting | `backend` service | `mcp` service |
| --- | --- | --- |
| Image | Dockerfile build of the pinned revision | same Dockerfile build and revision |
| Start command | `backend` | `mcp` |
| Internal port | `8000` | `3001` |
| Health path | `/readyz` | `/health` |
| Volume | shared persistent disk at `/data` | same disk at `/data` |
| Private env | — | `AGENT_DECK_BACKEND_URL=http://backend.railway.internal:8000` |

Set `AGENT_DECK_HOSTED_MODE=1`, `AGENT_DECK_PUBLIC_URL`,
`AGENT_DECK_OWNER_BOOTSTRAP_SECRET`, and `AGENT_DECK_VAULT_KEY` on the backend service.
Set `AGENT_DECK_HOME=/data` and `AGENT_DECK_MCP_REQUIRE_BEARER=1` on the MCP service. Keep
the backend URL on Railway's private service network. Attach public HTTPS domains only to the
ports that must be reached by the dashboard and MCP clients.

The same contract works on any PaaS that supports two commands from one OCI image, private
service DNS, and one persistent disk visible to both processes. If a provider cannot present
one disk to both roles, use the single-host Compose deployment; do not create independent
SQLite copies or add provider-specific storage behavior to core code.
