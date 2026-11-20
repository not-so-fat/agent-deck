---
id: npm-release-integration-smoke
triggers:
  - ship release
  - publish npm
  - release smoke
  - before tag
connections: []
exec: "npm run smoke:release"
skill: docs/PUBLISHING.md
---

# npm release integration smoke

**Agent Deck–specific.** Generic pattern: [user-path-integration-smoke.md](./user-path-integration-smoke.md) (registered playbook `pb_user_path_integration_smoke`). Cursor rule: `.cursor/rules/release-integration-smoke.mdc`.

**Run before every npm publish.** Catches “code exists but user path is broken” bugs that unit tests miss.

## Case study: 1.2.3 status line

| What shipped | What users expected |
|--------------|---------------------|
| `agent-deck statusline` command | Footer shows bound deck |
| CHANGELOG listed “CLI statusline” | `setup` creates `statusline.sh` |
| Docs showed manual `settings.json` | One command wires everything |

**Root cause:** feature split across command + installer + docs; only the command was in the tarball. No test exercised **fresh install → setup → artifact on disk → clean stdout**.

## Invariants (non‑negotiable)

For every **user-visible surface**, define and verify the **full path**:

```
CHANGELOG claim  →  command/API exists in tarball  →  setup wires it  →  artifact on disk  →  runtime output contract
```

### Surface checklist (copy per feature)

| # | Question | Fail example |
|---|----------|--------------|
| 1 | What is the **one command** a user runs? | “run statusline” but no installer |
| 2 | What **files** does that command create? | `~/.agent-deck/bin/statusline.sh` missing |
| 3 | What **config keys** does it write? | `statusLine` never merged into settings |
| 4 | What does **stdout/stderr** look like? | `npm warn` on stdout → blank Claude footer |
| 5 | Does it work when **prod API ≠ dev data**? | bind in `dev/bindings.json`, API on `:1111` unbound |
| 6 | Is the claim in **CHANGELOG** under “on npm” or “pending”? | “setup installs” listed as shipped when it wasn’t |
| 7 | Does **`npm pack` tarball** include the module? | `statusline-setup.ts` never built/shipped |

## Automated gate

```bash
npm run build:release   # includes smoke:release via prepare-release
# or alone after build:
npm run smoke:release
```

Logs: `.temporal/logs/release-smoke.log`

**Publish is blocked** if `smoke:release` fails. Fix or move the CHANGELOG bullet to **Pending publish**.

## Manual pass (5 min, human or agent)

Do this when the release touches **CLI setup**, **agent surfaces** (Claude/Cursor), or **cross-package** behavior:

1. **Tarball fidelity** — `cd packages/cli && npm pack`, extract, run `node package/dist/bin.js setup --client claude` in a **clean `HOME`** (temp dir). Never only test from monorepo `packages/cli/dist` without packing.
2. **Artifact inventory** — list every path the feature docs mention; `test -f` each after setup.
3. **Stdout contract** — pipe stdin like the host app does:
   ```bash
   echo '{"cwd":"'"$PWD"'"}' | ~/.agent-deck/bin/statusline.sh | wc -l   # must be 1
   ```
   No `npm warn`, no ANSI, no second line.
4. **Host app matrix** — state explicitly where the feature works:
   - Claude Code **terminal** footer ✓
   - Cursor **CLI** terminal footer ✓
   - Cursor **IDE Agent chat** ✗ — no host API; do not imply otherwise in CHANGELOG
5. **CHANGELOG honesty** — bullets under `X.Y.Z` are **only** what passed `smoke:release`. Everything else → `### Pending publish`.
6. **Tag = tarball** — `git show vX.Y.Z:path` must contain the same files as `npm pack` at that version.
7. **GitHub Release** — `gh release view vX.Y.Z` exists with notes from the matching `CHANGELOG.md` section (created by `release.yml` after `release:finish` pushes the tag).

## Anti-patterns

1. **Ship the library, skip the installer** — command without `setup` wiring.
2. **Test only in monorepo dev** — `npm run dev:all` masks prod paths (`:8000` vs `:1111`, `dev/bindings.json`).
3. **Doc-only integration** — “add this to settings.json” without `setup` doing it.
4. **Polluted stdout** — wrappers that call `npx` without `NO_COLOR` + stderr redirect.
5. **CHANGELOG as wishlist** — features listed as shipped before `smoke:release` passes.
6. **Replace entire user config** — merge JSON; document merge in setup code.
7. **Tag without GitHub Release** — `vX.Y.Z` exists but `gh release view` fails; users see no release notes on GitHub.

## When to extend this playbook

Add a row to the surface checklist and an assertion in `scripts/release-smoke.sh` when a new user path appears (new MCP tool, new `setup --client`, etc.).

## Related

- [PUBLISHING.md](../../PUBLISHING.md) — publish order and `smoke:release`
- [PRD_DECK_DISPLAY.md](../../PRD_DECK_DISPLAY.md) — deck display surfaces
- `.cursor/rules/release-integration-smoke.mdc` — Agent Deck cursor rule
- `.cursor/rules/npm-release-workflow.mdc` — agent release steps
- Generic playbook: `pb_user_path_integration_smoke` in Agent Deck collection
