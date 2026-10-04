# NOT-337 VPS deploy log (operator gate)

Status: **PENDING** — to be completed by the operator on a fresh VPS. This log is
the acceptance evidence for AC5 and the WS5 exit predicate. CI cannot satisfy it.

## Environment

- Date (UTC):
- Host (provider, size, region):
- OS / Docker Engine / Compose plugin versions:
- Deployed commit (immutable tag or SHA, used for both `AGENT_DECK_IMAGE` and `AGENT_DECK_VERSION`):

## Steps run (from `docs/DEPLOYMENT.md`, Docker Compose on a VPS)

```bash
docker compose build --pull backend
docker compose up -d --scale backend=1 --scale mcp=1
docker compose ps
curl --fail http://127.0.0.1:8000/readyz
```

## Observed results (paste)

- `docker compose ps` output (exactly one `backend` and one `mcp`, both healthy):
- `curl http://127.0.0.1:8000/readyz` output (expect `{"status":"ready"}`, HTTP 200):
- Public dashboard sign-in page load at `$AGENT_DECK_PUBLIC_URL` (note HTTPS status):
- `curl https://deck.example.com/readyz` output (expect HTTP 200):

## Single-replica check

- Confirm `--scale backend=1 --scale mcp=1`, one `/data` volume shared by both
  roles, and the backend-to-MCP hop on the private compose network only.

## Secrets handling

Do not paste `AGENT_DECK_VAULT_KEY` or `AGENT_DECK_OWNER_BOOTSTRAP_SECRET` values
into this log. Record only that each was set from the secret manager.
