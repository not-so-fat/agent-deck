# Managed CLI install + auto-upgrade — design

**Status:** Approved — P1–P4 implemented (deck); dealer P2 managed install landed  
**Date:** 2026-07-30
**Products:** agent-deck + agent-dealer (same contract, independent implementations)  
**Decision:** **Managed home install (path B)** — we own version trees and a stable launcher; auto-update on by default. npm global remains a compat path, not the recommended always-on path.

**Related:** Cursor IDE / Glass status display stays parked (no host API). Terminal `statusLine` + menubar unchanged except they must invoke the **managed launcher**, never `npx`.

---

## 1. Problem

Users should not need to remember `upgrade`. Claude Code’s native install does this: background check, download beside the running tree, apply on next launch.

Today both products are npm-centric:

| Product | Current behavior |
|---------|------------------|
| agent-deck | 24h notify on `start`; `AGENT_DECK_AUTO_UPGRADE=1` blocks on `npm i -g`; statusline docs push global install to avoid slow `npx` |
| agent-dealer | 24h check + optional TTY prompt; `AGENT_DEALER_AUTO_UPGRADE=1` runs `npm i -g` |

That cannot match Claude’s UX: npm owns the binary, permissions/ABI/`npx` cache stay user landmines, and opt-in env vars mean most installs never auto-update.

---

## 2. Goals / non-goals

### Goals

- **Recommended install** = managed tree under product home + launcher on PATH.
- **Auto-update on by default** for managed installs (check ≤1×/24h; never block `start`/`doctor` on network).
- **Side-by-side versions** — download new version without deleting the running one; flip pointer; next process start uses new build.
- **Same contract** for agent-deck and agent-dealer (dirs, env, commands, doctor messaging).
- **Compat** for existing `npm i -g` users (notify + manual upgrade still work; doctor suggests migrate).
- Statusline / menubar / SwiftBar plugins call the **stable launcher** only.
- **Existing users need no data migration** — managed install only adds `versions/` + a PATH launcher; decks, credentials, MCP/harness config, dealer `.env` / queue data stay where they already are under the product home.

### Non-goals (v1)

- Shipping a Node-free native binary.
- Homebrew / WinGet / apt channels.
- Auto-killing / auto-restarting a live daemon without a clear restart prompt.
- Shared npm package between deck and dealer (duplicate the small module; extract later if painful).
- Cursor Glass / IDE Agent chat deck badge (parked).
- Changing ports, data layout for decks/DB/creds (only add `versions/` + launcher wiring).

---

## 3. Best-practice choices (locked)

| Topic | Choice | Why |
|-------|--------|-----|
| PATH entry | Symlink (or thin shim) at **`~/.local/bin/<cmd>`** | Matches Claude Code / XDG user bin; already on PATH for many macOS/Linux setups; one place for both products |
| Version store | **`~/.agent-deck/versions/<semver>/`** and **`~/.agent-dealer/versions/<semver>/`** | Product home already holds data; versions stay next to config, not mixed into npm global |
| Active version | Symlink **`current` → `versions/<semver>`** | Atomic-enough flip; easy rollback (`ln -sfn` previous) |
| Launcher | `~/.local/bin/agent-deck` → exec Node entry in `current` | Launcher path never changes when versions flip; statusline always uses this path |
| Update apply | **Next process start** (daemon: print restart hint) | Safe; no mid-flight `npm i -g` on a live server |
| Package source | npm registry tarball (`npm pack` / registry tarball URL) for v1 | Already publish there; no second artifact pipeline yet |
| Default auto-update | **On** for managed installs | Claude parity; opt-out via env |
| npm global | Compat only | Do not break existing README commands overnight |

---

## 4. On-disk layout

### agent-deck

```text
~/.agent-deck/
  versions/
    1.2.10/           # unpacked package (cli + deps needed to run)
    1.2.11/
  current -> versions/1.2.11
  bin/                # existing helper scripts (statusline.sh, etc.) — keep
  …existing data (db, credentials metadata, etc.)

~/.local/bin/agent-deck   # stable entry → runs current’s CLI
```

### agent-dealer

```text
~/.agent-dealer/
  versions/
    0.1.13/
    0.1.14/
  current -> versions/0.1.14
  …existing (.env, run.json, logs)

~/.local/bin/agent-dealer
```

**Install detection:** if `~/.agent-deck/current` (or dealer equivalent) exists and resolves, treat as **managed**. Else if `which agent-deck` resolves inside npm global prefix → **npm-global**. Else **unknown** (dev checkout, npx).

---

## 5. User flows

### F1 — First install (recommended)

```bash
curl -fsSL https://…/install.sh | bash
# or: npx @agent-deck/cli@latest install   # one-shot bootstrap into managed home
```

Steps:

1. Ensure `~/.local/bin` exists; warn if not on PATH (print one-line export).
2. Resolve latest version from npm.
3. Download + unpack into `versions/<ver>/`.
4. Point `current` at it.
5. Write/update `~/.local/bin/agent-deck` (or dealer).
6. Print `agent-deck doctor` / `start` next steps.

Same script shape for dealer (`install-agent-dealer.sh` or shared template with product name substituted).

### F2 — Everyday start (managed)

1. `agent-deck start` via `~/.local/bin`.
2. Fire **non-blocking** update check (or sync check with hard timeout ≤1.5s if simpler in v1 — prefer async/background write to a pending file).
3. If newer version fully downloaded and staged: on this invocation, either (a) flip `current` **before** spawning the server if no daemon is running, or (b) if daemon already up, leave `current` pending and print restart hint.
4. Start proceeds on whatever `current` is now.

**Preferred v1 rule (simple):**  
- Check + download in background to `versions/<new>/` (incomplete dir named `.partial-<ver>` until verified).  
- On next CLI entry (`start`, `doctor`, `statusline` is **read-only** — do not flip during statusline): if pending complete version exists and auto-updater enabled, flip `current` then continue.  
- **Never flip during `statusline` / `menubar`** — those must stay fast and side-effect free.

### F3 — Manual upgrade

```bash
agent-deck upgrade          # latest
agent-deck upgrade --check  # report only
agent-deck upgrade --to 1.2.11
```

Managed: download + flip immediately (if daemon running → flip + tell user to restart).  
npm-global: keep today’s `npm install -g …@version` behavior.

### F4 — Opt-out / pin

| Env | Effect |
|-----|--------|
| `AGENT_DECK_DISABLE_AUTOUPDATER=1` | No background check/download/flip (manual `upgrade` still works) |
| `AGENT_DEALER_DISABLE_AUTOUPDATER=1` | Same for dealer |
| `AGENT_DECK_MINIMUM_VERSION` / dealer twin (optional v1.1) | Refuse to install below floor — defer if it slows v1 |

Deprecate reliance on `*_AUTO_UPGRADE=1` as the *only* way to get updates: for managed installs, auto is default; that env may mean “upgrade immediately on this start” (aggressive) or be retired — document in CHANGELOG.

### F5 — Switch CLI binary to managed (not a data migration)

**Invariant:** Product home data is untouched. Same `~/.agent-deck/` / `~/.agent-dealer/` for DB, creds, decks, `.env`, logs, run state, statusline scripts already under `bin/`. Cursor/Claude MCP + harness files under `~/.cursor` / `~/.claude` are also untouched — they keep calling `agent-deck` / MCP URLs as today.

Running the new installer (or `agent-deck install`) on a machine that already used `npm i -g` only:

1. Unpacks the CLI into `versions/<ver>/` and points `current`.
2. Writes `~/.local/bin/agent-deck` (or dealer).
3. Leaves all existing home data and host configs alone.

`doctor` may detect npm-global still shadows PATH and print:

```text
Managed install ready (your decks/data are unchanged). Prefer PATH order:
  ~/.local/bin before npm global   — or: agent-deck install --migrate-cli
```

`--migrate-cli` means **switch which binary runs**, not migrate user data. Do not uninstall npm global unless `--purge-global`.

---

## 6. Architecture

```text
┌──────────────────────────────┐
│  ~/.local/bin/agent-deck     │  stable PATH entry
└──────────────┬───────────────┘
               │ exec
               ▼
┌──────────────────────────────┐
│  ~/.agent-deck/current       │  symlink → versions/<ver>
│  (CLI + bundled runtime)     │
└──────────────┬───────────────┘
               │
     ┌─────────┴─────────┐
     ▼                   ▼
 start / doctor      upgrade / updater
 (use current)       fetch npm tarball →
                     versions/<new> →
                     flip current
```

**Updater module (per repo):** `check` → `download` → `verify` (integrity from npm metadata / shasum) → `activate` (symlink flip) → `prune` (keep last N versions, default 3).

**statusline / menubar:** resolve `~/.local/bin/agent-deck` or `~/.agent-deck/current/...` explicitly in setup scripts — never `npx @agent-deck/cli`.

---

## 7. Cross-product contract

Identical semantics; only names/paths differ:

| Concept | agent-deck | agent-dealer |
|---------|------------|--------------|
| Home | `AGENT_DECK_HOME` / `~/.agent-deck` | `AGENT_DEALER_HOME` / `~/.agent-dealer` |
| npm package | `@agent-deck/cli` (as published today) | `agent-dealer` |
| PATH cmd | `agent-deck` | `agent-dealer` |
| Disable auto | `AGENT_DECK_DISABLE_AUTOUPDATER` | `AGENT_DEALER_DISABLE_AUTOUPDATER` |
| Version cache file | `~/.agent-deck/update-state.json` | `~/.agent-dealer/update-state.json` |

Commands both expose: `install` (managed bootstrap), `upgrade [--check\|--to]`, `doctor` (report install kind + pending update).

---

## 8. Publishing / release impact

- Keep publishing to npm — managed installer consumes the published tarball.
- Install script URL: ship from GitHub Release assets and/or raw docs; must be **version-agnostic** (script always pulls latest from npm unless pinned).
- Release smoke: after pack, run managed install into a temp home + `~/.local/bin` under that home, assert `current` + launcher + `--version`.
- CHANGELOG “After upgrade”: for managed users, “restart daemon”; setup/harness re-run rules unchanged when wording changes.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| `~/.local/bin` not on PATH | Install prints export line; doctor checks PATH |
| Partial download corrupts `current` | Unpack to `.partial-<ver>`, rename/swap only after verify |
| statusline flips version mid-refresh | Forbid activate in statusline/menubar code paths |
| Two copies (global + managed) confuse which runs | doctor prints resolved path + install kind; migrate docs |
| Disk growth | Prune to last 3 versions after successful activate |
| Windows | v1 = macOS/Linux; document Windows as npm-global until shim exists |

---

## 10. Phased delivery

| Phase | Exit criteria |
|-------|----------------|
| **P0** | Spec approved; shared contract frozen in this doc |
| **P1** | agent-deck: managed `install`, launcher, `upgrade` activates managed tree, background check+download, doctor install-kind |
| **P2** | agent-dealer: same contract |
| **P3** | Setup scripts (statusline/menubar) point at managed launcher; PUBLISHING/README recommend managed; npm-global demoted to compat |
| **P4** | Release smoke for managed install; prune; optional migrate `--purge-global` |

Implement deck first so dealer can copy a known-good module.

---

## 11. Success criteria

| # | Criterion |
|---|-----------|
| SC-1 | Fresh managed install: `~/.local/bin/agent-deck` runs without `npm i -g` |
| SC-2 | With auto-updater on, publishing N+1 then waiting ≤24h + one new CLI invocation activates N+1 without user running `upgrade` |
| SC-3 | `statusline` / `menubar` never perform activate; p95 latency unchanged vs today when already managed |
| SC-4 | `DISABLE_AUTOUPDATER=1` never downloads or flips |
| SC-5 | npm-global installs still `upgrade` via `npm i -g`; doctor explains managed path |
| SC-6 | agent-dealer matches SC-1–SC-5 with its names |
| SC-7 | Pre-existing `~/.agent-deck/` (or dealer home) data + host MCP/harness configs work after managed install with **zero** data/import step |

---

## 12. Open follow-ups (not blocking P1)

- GitHub Release tarball as primary artifact (bypass npm for airgapped).
- `minimumVersion` / release channels (`latest` vs `stable`).
- Windows `%LOCALAPPDATA%` layout + shim.
- Extract `@agent-toolkit/managed-updater` shared package.

---

## Appendix — source notes

- User decision 2026-07-30: path **B** (managed home), apply to agent-deck and agent-dealer; statusline/Cursor display held.
- Claude Code setup docs: background update, apply next start, `~/.local/bin` launcher, `DISABLE_AUTOUPDATER`.
- Existing: `packages/cli/src/upgrade.ts` (deck), `packages/cli/src/update-check.ts` + `upgrade.ts` (dealer).
