# Managed CLI install + auto-upgrade (agent-deck P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship managed home install for agent-deck — version trees under `~/.agent-deck/versions/`, stable `~/.local/bin/agent-deck` launcher, auto-update on by default (download in background, activate on next CLI entry except statusline/menubar), with zero data migration for existing users.

**Architecture:** New `packages/cli/src/managed/` module owns paths, npm-prefix install into a version dir, symlink `current`, PATH launcher, update-state JSON, and activate/prune. `install` / `upgrade` / `start` / `doctor` call it; `statusline` / `menubar` never activate. npm-global remains a compat upgrade path. agent-dealer is **out of this plan** (P2 copies the contract after P1 lands). Spec: `docs/superpowers/specs/2026-07-30-managed-cli-auto-upgrade-design.md`.

**Tech Stack:** TypeScript, Node 20+, Vitest, npm registry + `npm install --prefix`, macOS/Linux v1.

## Global Constraints

- No data migration — only add `versions/`, `current`, `update-state.json`, and `~/.local/bin/agent-deck`.
- Never activate (flip `current`) from `statusline` or `menubar`.
- Auto-updater **on** for managed installs unless `AGENT_DECK_DISABLE_AUTOUPDATER=1`.
- Never block `start` on network for the download path (activate of already-complete pending is sync/fast).
- Unpack via `.partial-<ver>` → rename only after `npm install --prefix` succeeds.
- Prune to last **3** versions after activate.
- Platform v1: **macOS/Linux** only; Windows stays npm-global in docs.
- Tests: `npm --workspace @agent-deck/cli run test -- <path>`.
- Do not commit unless the user asks (ignore “Commit” steps or stop before them).

---

## File map

| File | Responsibility |
|------|----------------|
| `packages/cli/src/managed/paths.ts` | Resolve home, versions dir, current link, local bin, update-state path |
| `packages/cli/src/managed/install-kind.ts` | Detect `managed` \| `npm-global` \| `unknown` |
| `packages/cli/src/managed/launcher.ts` | Write executable `~/.local/bin/agent-deck` shim |
| `packages/cli/src/managed/npm-prefix-install.ts` | Install `@agent-deck/cli@ver` into version dir via npm `--prefix` |
| `packages/cli/src/managed/activate.ts` | Point `current`, write launcher, prune old versions |
| `packages/cli/src/managed/update-state.ts` | Read/write `update-state.json` (checkedAt, latest, pendingVersion) |
| `packages/cli/src/managed/updater.ts` | check → download pending → maybeActivateOnCliEntry; respect disable env |
| `packages/cli/src/managed/index.ts` | Public exports |
| `packages/cli/src/install.ts` | `agent-deck install [--migrate-cli] [--to VER] [--purge-global]` |
| `packages/cli/src/upgrade.ts` | Branch managed vs npm-global; keep `--check` |
| `packages/cli/src/start.ts` | Call activate-on-entry + kick background fetch; drop opt-in-only auto npm path as primary |
| `packages/cli/src/index.ts` | Register `install`; help text |
| `scripts/install.sh` | curl\|bash bootstrap → `npx`/`node` one-shot into managed home |
| `docs/PUBLISHING.md`, `docs/SETUP.md`, `README.md` | Recommend managed install; npm-global as compat |
| Spec status line | Mark design **Approved** |

---

### Task 1: Paths + install-kind detection

**Files:**
- Create: `packages/cli/src/managed/paths.ts`
- Create: `packages/cli/src/managed/install-kind.ts`
- Create: `packages/cli/src/managed/paths.test.ts`
- Create: `packages/cli/src/managed/install-kind.test.ts`
- Create: `packages/cli/src/managed/index.ts`

**Interfaces:**
- Produces:
  - `agentDeckHome(): string`
  - `versionsDir(): string` → `{home}/versions`
  - `versionDir(version: string): string` → `{versions}/{version}`
  - `partialVersionDir(version: string): string` → `{versions}/.partial-{version}`
  - `currentLinkPath(): string` → `{home}/current`
  - `updateStatePath(): string` → `{home}/update-state.json`
  - `localBinDir(): string` → `{homedir}/.local/bin`
  - `localBinLauncherPath(): string` → `{localBin}/agent-deck`
  - `resolveCurrentVersionDir(): string | null` — realpath of `current` if exists
  - `InstallKind = 'managed' | 'npm-global' | 'unknown'`
  - `detectInstallKind(options?: { whichPath?: string; npmGlobalPrefix?: string }): InstallKind` — managed if `current` resolves; else npm-global if `whichPath` is under npm global prefix; else unknown

- [ ] **Step 1: Write failing tests**

```ts
// packages/cli/src/managed/paths.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentDeckHome,
  currentLinkPath,
  partialVersionDir,
  versionDir,
  versionsDir,
} from './paths';

describe('managed paths', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-managed-'));
    process.env.AGENT_DECK_HOME = tmp;
  });
  afterEach(() => {
    delete process.env.AGENT_DECK_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('nests versions under AGENT_DECK_HOME', () => {
    expect(versionsDir()).toBe(path.join(tmp, 'versions'));
    expect(versionDir('1.2.3')).toBe(path.join(tmp, 'versions', '1.2.3'));
    expect(partialVersionDir('1.2.3')).toBe(path.join(tmp, 'versions', '.partial-1.2.3'));
    expect(currentLinkPath()).toBe(path.join(tmp, 'current'));
  });
});
```

```ts
// packages/cli/src/managed/install-kind.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectInstallKind } from './install-kind';

describe('detectInstallKind', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-kind-'));
    process.env.AGENT_DECK_HOME = tmp;
  });
  afterEach(() => {
    delete process.env.AGENT_DECK_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns managed when current symlink resolves', () => {
    const target = path.join(tmp, 'versions', '1.0.0');
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, path.join(tmp, 'current'));
    expect(detectInstallKind()).toBe('managed');
  });

  it('returns npm-global when which path is under prefix', () => {
    expect(
      detectInstallKind({
        whichPath: '/usr/local/lib/node_modules/@agent-deck/cli/dist/bin.js',
        npmGlobalPrefix: '/usr/local',
      }),
    ).toBe('npm-global');
  });

  it('returns unknown otherwise', () => {
    expect(detectInstallKind({ whichPath: '/repo/packages/cli/dist/bin.js' })).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npm --workspace @agent-deck/cli run test -- src/managed/paths.test.ts src/managed/install-kind.test.ts`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement paths + install-kind + index barrel**

Implement the interfaces above. `agentDeckHome` mirrors `upgrade.ts` today: `process.env.AGENT_DECK_HOME ?? path.join(os.homedir(), '.agent-deck')`.

- [ ] **Step 4: Run tests — expect PASS**

---

### Task 2: npm prefix install + activate + launcher + prune

**Files:**
- Create: `packages/cli/src/managed/npm-prefix-install.ts`
- Create: `packages/cli/src/managed/launcher.ts`
- Create: `packages/cli/src/managed/activate.ts`
- Create: `packages/cli/src/managed/activate.test.ts`
- Modify: `packages/cli/src/managed/index.ts`

**Interfaces:**
- Produces:
  - `PACKAGE_NAME = '@agent-deck/cli'`
  - `installCliVersionToPrefix(version: string, options?: { npmSpawn?: … }): Promise<{ ok: true; dir: string } | { ok: false; error: string }>`  
    - rm partial if exists; `mkdir` partial; run `npm install --prefix <partial> @agent-deck/cli@<version>` (stdio pipe); on success rename partial → `versionDir(version)` (replace if exists); on failure rm partial and return error
  - `writeLocalBinLauncher(): void` — write executable shim:
    ```bash
    #!/usr/bin/env bash
    set -euo pipefail
    HOME_DIR="${AGENT_DECK_HOME:-$HOME/.agent-deck}"
    CURRENT="$HOME_DIR/current"
    BIN="$CURRENT/node_modules/@agent-deck/cli/dist/bin.js"
    if [ ! -f "$BIN" ]; then
      echo "agent-deck: managed install broken (missing $BIN). Re-run: agent-deck install" >&2
      exit 1
    fi
    exec node "$BIN" "$@"
    ```
    chmod `0o755`; ensure `localBinDir` exists
  - `activateVersion(version: string): void` — `ln -sfn` equivalent (`fs.symlinkSync` with unlink of old `current`); call `writeLocalBinLauncher()`; call `pruneOldVersions(keep: 3)`
  - `pruneOldVersions(keep: number): void` — list semver dirs under versions (ignore `.partial-*`), sort descending, delete extras not equal to current target
  - `cliEntryInVersionDir(versionDir: string): string` → `…/node_modules/@agent-deck/cli/dist/bin.js`

- [ ] **Step 1: Write failing activate/prune tests** (mock install: manually mkdir fake `node_modules/@agent-deck/cli/dist/bin.js`)

```ts
// packages/cli/src/managed/activate.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activateVersion, pruneOldVersions } from './activate';
import { currentLinkPath, localBinLauncherPath, versionDir } from './paths';

function seedVersion(ver: string) {
  const dir = versionDir(ver);
  const bin = path.join(dir, 'node_modules', '@agent-deck', 'cli', 'dist', 'bin.js');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, 'console.log("ok")\n');
}

describe('activateVersion', () => {
  let tmp: string;
  let localBin: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-act-'));
    localBin = path.join(tmp, 'local-bin');
    process.env.AGENT_DECK_HOME = tmp;
    process.env.AGENT_DECK_LOCAL_BIN = localBin; // paths.ts must honor this for tests
  });
  afterEach(() => {
    delete process.env.AGENT_DECK_HOME;
    delete process.env.AGENT_DECK_LOCAL_BIN;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('points current and writes launcher without touching sibling data files', () => {
    fs.writeFileSync(path.join(tmp, 'agent_deck.db'), 'keep-me');
    seedVersion('1.0.0');
    activateVersion('1.0.0');
    expect(fs.realpathSync(currentLinkPath())).toBe(fs.realpathSync(versionDir('1.0.0')));
    expect(fs.readFileSync(path.join(tmp, 'agent_deck.db'), 'utf8')).toBe('keep-me');
    expect(fs.existsSync(localBinLauncherPath())).toBe(true);
    const launcher = fs.readFileSync(localBinLauncherPath(), 'utf8');
    expect(launcher).toContain('node_modules/@agent-deck/cli/dist/bin.js');
  });

  it('prunes to last 3 versions', () => {
    for (const v of ['1.0.0', '1.0.1', '1.0.2', '1.0.3']) seedVersion(v);
    activateVersion('1.0.3');
    pruneOldVersions(3);
    expect(fs.existsSync(versionDir('1.0.0'))).toBe(false);
    expect(fs.existsSync(versionDir('1.0.1'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement** — honor `AGENT_DECK_LOCAL_BIN` in `paths.localBinDir()` for tests (document as test/override only). Use `fs.renameSync` for partial→final; on Windows skip (v1 mac/linux).

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Manual smoke (optional in CI):** in temp home, `installCliVersionToPrefix` against a published version if network allowed — otherwise unit-test with injected `npmSpawn` mock that creates the tree.

Add unit test with mock spawn that fabricates the prefix tree so CI needs no network.

---

### Task 3: Update state + updater (download pending, activate on CLI entry)

**Files:**
- Create: `packages/cli/src/managed/update-state.ts`
- Create: `packages/cli/src/managed/updater.ts`
- Create: `packages/cli/src/managed/updater.test.ts`
- Modify: `packages/cli/src/managed/index.ts`

**Interfaces:**
- Produces:
  - `UpdateState = { checkedAt: string; latest: string | null; pendingVersion: string | null }`
  - `readUpdateState()` / `writeUpdateState(state)`
  - `isAutoupdaterDisabled(): boolean` — true when `AGENT_DECK_DISABLE_AUTOUPDATER` is `1`/`true`
  - `maybeActivatePendingVersion(): { activated: string | null }` — if managed + pending dir complete (`cliEntry` exists) + not disabled → `activateVersion(pending)` and clear pending; else no-op
  - `ensurePendingDownload(latest: string): Promise<void>` — if version dir or partial complete missing, call `installCliVersionToPrefix`; set `pendingVersion` in state (do not activate)
  - `scheduleBackgroundUpdateCheck(): void` — if disabled or not managed, return; if checkedAt within 24h, skip network; else void-promise: fetch latest (reuse `fetchLatestVersion` from upgrade or move to shared), write state, `ensurePendingDownload` without throwing to caller
  - `runManagedCliEntryHooks(options: { allowActivate: boolean }): { activated: string | null }` — if `allowActivate`, `maybeActivatePendingVersion`; always `scheduleBackgroundUpdateCheck()` when managed; **callers:** start/doctor/upgrade/install with `allowActivate: true`; statusline/menubar never call this

- [ ] **Step 1: Failing tests** — pending activate; disable env skips; status that `schedule` does not activate

```ts
it('activates pending when version dir is complete', () => { /* seed 1.0.1 dir + state.pendingVersion; maybeActivatePendingVersion; expect current → 1.0.1 */ });
it('does nothing when DISABLE_AUTOUPDATER=1', () => { /* … */ });
```

- [ ] **Step 2–4:** Implement + pass tests. Move `fetchLatestVersion` / `compareSemver` into `packages/cli/src/managed/npm-registry.ts` (or keep in upgrade and import) so updater + upgrade share one fetch.

---

### Task 4: `agent-deck install` command

**Files:**
- Create: `packages/cli/src/install.ts`
- Create: `packages/cli/src/install.test.ts`
- Modify: `packages/cli/src/index.ts` — `case 'install': return runInstall(rest)`; update `printUsage`

**Interfaces:**
- Produces: `runInstall(args: string[]): Promise<number>`
- Flags: `--to <ver>`, `--migrate-cli` (alias behavior: same as install; print PATH hint), `--purge-global` (optional: `npm uninstall -g @agent-deck/cli` after success; only if flag set)
- Flow: resolve version (arg or fetch latest) → `installCliVersionToPrefix` → `activateVersion` → print:
  ```
  Installed agent-deck@X to ~/.agent-deck (data home unchanged).
  Launcher: ~/.local/bin/agent-deck
  If command not found: export PATH="$HOME/.local/bin:$PATH"
  Next: agent-deck doctor && agent-deck start --open
  ```
- Must not delete `agent_deck.db` or other home files (assert in test with pre-seeded file).

- [ ] **Step 1–4:** TDD with mocked `installCliVersionToPrefix` via dependency injection **or** seed fake version dirs and only test activate path from `runInstall` with `--to` when version already present (add `--activate-only` **only if needed for tests** — prefer injecting install fn in `runInstall` options for tests, defaulting to real impl).

Prefer:

```ts
export async function runInstall(
  args: string[],
  deps?: { installVersion?: typeof installCliVersionToPrefix; fetchLatest?: () => Promise<string | null> },
): Promise<number>
```

---

### Task 5: Branch `upgrade` + wire `start` / `doctor`

**Files:**
- Modify: `packages/cli/src/upgrade.ts`
- Modify: `packages/cli/src/start.ts` (where `runDoctor` / `runStart` live)
- Create: `packages/cli/src/upgrade.managed.test.ts`

**Behavior:**

`runUpgrade`:
- Parse `--check`, `--to <ver>`
- If `detectInstallKind() === 'managed'` (or `current` exists): managed download+activate (or check-only print); print restart hint if daemon pid file / status says running (reuse existing status helpers if any; else soft message “Restart agent-deck if it is running”)
- Else: existing `npm install -g` path
- Respect `DISABLE_AUTOUPDATER` for **background** only — manual `upgrade` always allowed

`runStart` / `runDoctor`:
- First line of real work: `runManagedCliEntryHooks({ allowActivate: true })`; if activated, log `[agent-deck] Activated managed version X`
- Replace `maybeAutoUpgradeOnStart` npm-global blocking behavior: for managed, hooks handle it; for npm-global keep `notifyIfUpdateAvailable` and optional `AGENT_DECK_AUTO_UPGRADE` as today
- `runDoctor`: print install kind, `current` target, launcher path, whether launcher is on PATH, pending version; if managed ready and npm-global also installed, print F5 PATH hint (data unchanged)

**statusline / menubar:** confirm they do **not** import updater activate. Grep test or comment in statusline.ts.

- [ ] **Step 1:** Test upgrade managed `--check` with seeded current + mocked fetch
- [ ] **Step 2–4:** Implement + pass
- [ ] **Step 5:** Grep `runManagedCliEntryHooks` / `activateVersion` — must not appear in `statusline.ts` / `menubar.ts`

---

### Task 6: `scripts/install.sh` + docs

**Files:**
- Create: `scripts/install.sh`
- Modify: `docs/PUBLISHING.md` — Auto-upgrade section → managed primary
- Modify: `docs/SETUP.md` — friend install path
- Modify: `README.md` — install one-liner
- Modify: `docs/superpowers/specs/2026-07-30-managed-cli-auto-upgrade-design.md` — Status: Approved / P1 implementing

**install.sh:**

```bash
#!/usr/bin/env bash
set -euo pipefail
export AGENT_DECK_HOME="${AGENT_DECK_HOME:-$HOME/.agent-deck}"
mkdir -p "$HOME/.local/bin"
# Bootstrap via npx once (does not require prior global):
npx --yes @agent-deck/cli@latest install "$@"
echo "Ensure ~/.local/bin is on your PATH"
```

Document Windows: use `npm i -g` until managed shim exists.

- [ ] **Step 1:** Write script + docs
- [ ] **Step 2:** `bash -n scripts/install.sh` (syntax check)
- [ ] **Step 3:** Mark CHECKLIST SC-1/SC-4/SC-5/SC-7 covered by unit tests; SC-2/SC-3 manual / later release smoke (P4)

---

### Task 7: Plan self-check + dealer handoff note

- [ ] Confirm spec SC-1–SC-5, SC-7 have tasks (SC-6 = dealer P2 — add stub plan file `docs/superpowers/plans/2026-07-30-managed-cli-auto-upgrade-dealer.md` that says “copy agent-deck managed/ after P1”)
- [ ] Update design status to Approved
- [ ] No `activate` from statusline (Task 5 grep)

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| Managed layout + `~/.local/bin` | 1–2 |
| npm tarball/prefix install | 2 |
| Activate + prune 3 | 2 |
| Auto-update default + disable env | 3 |
| No activate on statusline | 5 |
| `install` + no data migration | 4 |
| `upgrade` managed + npm compat | 5 |
| doctor install-kind | 5 |
| install.sh + docs | 6 |
| Dealer P2 | 7 stub |
| Release smoke P4 | deferred (note in Task 6) |

## Out of this plan

- agent-dealer implementation (P2)
- statusline/menubar path rewrite to managed launcher only (P3 — can be quick follow-up once launcher exists)
- Release-smoke managed install in `scripts/release-smoke.sh` (P4)
- `--purge-global` polish if time-boxed — implement minimal in Task 4

---

## Execution

After plan save: prefer **inline execution** in this session (user already said go ahead) or subagent-driven per task.
