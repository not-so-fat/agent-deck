# File-Backed Store (Hybrid) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a git-friendly file tree under Agent Deck home the canonical store for cards and decks, with SQLite as a rebuildable cache, migration from existing DBs, auto + manual reindex, and docs-only user-owned git sync.

**Architecture:** Dual-write on every card/deck mutation (SQLite transaction + atomic file flush). On startup: migrate SQLite→files if needed, then reindex files→SQLite when the tree content hash differs from the hash stored in DB. CLI exposes `agent-deck reindex` and `agent-deck store migrate [--dry-run]`. Secrets stay in Keychain; learning-loop tables stay SQLite-only.

**Tech Stack:** TypeScript, Zod (`@agent-deck/shared`), Vitest, npm workspaces, `gray-matter` + `yaml` for playbook `.md` frontmatter, Node `fs` atomic temp+rename. Spec: `docs/superpowers/specs/2026-07-27-file-backed-store-git-sync-design.md`.

## Global Constraints

- Files are source of truth; SQLite is disposable/gitignored.
- Never write secrets, OAuth tokens, `localEnv`, or `Authorization` headers into the tree.
- Never invoke `git` from Agent Deck.
- Preserve entity ids on migrate so Keychain and binds keep working.
- Reindex with duplicate display names: abort, leave previous DB intact, report paths.
- Unknown `manifest.version`: fail closed.
- Hot paths must keep reading SQLite after reindex (no per-request full tree scan).
- Existing `.agent-deck.json` export/import must keep working (SC-6).
- Package manager: **npm** workspaces (not pnpm).
- Tests: `npm --workspace packages/backend run test -- <path> [-t "name"]`.

---

## File map

| File | Responsibility |
|------|----------------|
| `packages/shared/src/schemas/store.ts` | Zod: manifest, store playbook frontmatter, store service, store deck, store credential metadata |
| `packages/shared/src/index.ts` | Re-export store schemas |
| `docs/STORE_FORMAT.md` | Public on-disk format + git sync howto |
| `packages/backend/src/store/paths.ts` | Resolve `manifest.json`, `playbooks/`, `services/`, `decks/`, `credentials/` under home |
| `packages/backend/src/store/atomic-write.ts` | `writeFileAtomic(path, contents)` temp + rename |
| `packages/backend/src/store/content-hash.ts` | Deterministic hash of store tree |
| `packages/backend/src/store/playbook-codec.ts` | Playbook ↔ `.md` (gray-matter) |
| `packages/backend/src/store/service-codec.ts` | Service ↔ sanitized JSON (reuse export sanitize) |
| `packages/backend/src/store/deck-codec.ts` | Deck layout ↔ JSON |
| `packages/backend/src/store/credential-codec.ts` | Read/write credential metadata YAML (extend or wrap yaml-sync) |
| `packages/backend/src/store/writer.ts` | Flush/delete single entities + ensure dirs/manifest |
| `packages/backend/src/store/migrate.ts` | SQLite → full tree dump |
| `packages/backend/src/store/reindex.ts` | Files → rebuild SQLite + validation |
| `packages/backend/src/store/startup.ts` | `ensureStoreReady(db)` migrate-if-needed → maybe-reindex |
| `packages/backend/src/store/index.ts` | Public exports |
| `packages/backend/src/models/database.ts` | `store_meta` table for content hash; bulk replace helpers used by reindex |
| Managers / deck routes | Call store writer after successful DB mutations |
| `packages/backend/src/server/index.ts` | Call `ensureStoreReady` after `DatabaseManager` construct |
| `packages/backend/src/cli-runtime.ts` | `createCliStore()` for reindex/migrate |
| `packages/cli/src/store.ts` | CLI handlers |
| `packages/cli/src/index.ts` | Register `reindex`, `store migrate` |
| `docs/SETUP.md`, `README.md`, `docs/PRD_EXPORT_IMPORT.md` | Link store + git sync |

---

### Task 1: Shared Zod contracts + STORE_FORMAT.md

**Files:**
- Create: `packages/shared/src/schemas/store.ts`
- Create: `packages/shared/src/schemas/store.test.ts`
- Modify: `packages/shared/src/index.ts` — add `export * from './schemas/store'`
- Create: `docs/STORE_FORMAT.md`

**Interfaces:**
- Produces: `StoreManifestSchema`, `StorePlaybookFileSchema`, `StoreServiceSchema`, `StoreDeckSchema`, `StoreCredentialMetaSchema`, types with same names minus `Schema`
- `StoreManifest`: `{ format: "agent-deck-store", version: 1, migratedFrom?: "sqlite" }`
- `StorePlaybookFile`: playbook fields including `id`, `title`, `body`, `triggers`, deps, optional `exec`/`skill`, `createdAt`, `updatedAt` (datetime ISO)
- `StoreServiceSchema`: same create-safe fields as `BundleServiceSchema` (import/reuse or duplicate with shared shape)
- `StoreDeckSchema`: `{ id: uuid, name, serviceIds: string[], credentialIds: string[], playbookIds: string[], createdAt, updatedAt }`
- `StoreCredentialMetaSchema`: `{ id, label, scheme, headerName?, envName, tags, docsUrl? }` matching yaml-sync payload (camelCase in Zod; codec maps snake if needed)

- [ ] **Step 1: Write failing schema tests**

```ts
// packages/shared/src/schemas/store.test.ts
import { describe, expect, it } from 'vitest';
import { StoreManifestSchema, StorePlaybookFileSchema, StoreDeckSchema } from './store';

describe('store schemas', () => {
  it('accepts manifest v1', () => {
    expect(
      StoreManifestSchema.parse({
        format: 'agent-deck-store',
        version: 1,
        migratedFrom: 'sqlite',
      }),
    ).toMatchObject({ format: 'agent-deck-store', version: 1 });
  });

  it('rejects unknown format', () => {
    expect(
      StoreManifestSchema.safeParse({ format: 'other', version: 1 }).success,
    ).toBe(false);
  });

  it('requires playbook timestamps', () => {
    const r = StorePlaybookFileSchema.safeParse({
      id: 'pb_x',
      title: 'X',
      body: '',
      triggers: [],
      dependsOnCredentialIds: [],
      dependsOnServiceIds: [],
    });
    expect(r.success).toBe(false);
  });

  it('parses deck with ordered ids', () => {
    const deck = StoreDeckSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'dev',
      serviceIds: [],
      credentialIds: [],
      playbookIds: ['pb_x'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(deck.playbookIds).toEqual(['pb_x']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace packages/shared run test -- src/schemas/store.test.ts`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement schemas + re-export**

```ts
// packages/shared/src/schemas/store.ts
import { z } from 'zod';
import { PlaybookIdSchema, PlaybookTriggersSchema } from './playbook';
import { BundleServiceSchema } from './export-bundle';

export const StoreManifestSchema = z
  .object({
    format: z.literal('agent-deck-store'),
    version: z.literal(1),
    migratedFrom: z.literal('sqlite').optional(),
  })
  .strict();

export const StorePlaybookFileSchema = z
  .object({
    id: PlaybookIdSchema,
    title: z.string().min(1),
    body: z.string().default(''),
    triggers: PlaybookTriggersSchema,
    dependsOnCredentialIds: z.array(z.string()).default([]),
    dependsOnServiceIds: z.array(z.string()).default([]),
    exec: z.string().optional(),
    skill: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

// Reuse bundle service shape (already create-safe)
export const StoreServiceSchema = BundleServiceSchema;

export const StoreDeckSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    serviceIds: z.array(z.string()).default([]),
    credentialIds: z.array(z.string()).default([]),
    playbookIds: z.array(z.string()).default([]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const StoreCredentialMetaSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    scheme: z.enum(['bearer', 'header', 'http_basic_user']),
    headerName: z.string().nullable().optional(),
    envName: z.string().min(1),
    tags: z.array(z.string()).default([]),
    docsUrl: z.string().nullable().optional(),
  })
  .strict();

export type StoreManifest = z.infer<typeof StoreManifestSchema>;
export type StorePlaybookFile = z.infer<typeof StorePlaybookFileSchema>;
export type StoreService = z.infer<typeof StoreServiceSchema>;
export type StoreDeck = z.infer<typeof StoreDeckSchema>;
export type StoreCredentialMeta = z.infer<typeof StoreCredentialMetaSchema>;
```

Add `export * from './schemas/store'` to `packages/shared/src/index.ts`.

Write `docs/STORE_FORMAT.md` covering layout table from the design spec, playbook example, gitignore snippet, and “Agent Deck never runs git” workflow (pull → `agent-deck reindex` / restart).

- [ ] **Step 4: Run tests**

Run: `npm --workspace packages/shared run test -- src/schemas/store.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/schemas/store.ts packages/shared/src/schemas/store.test.ts packages/shared/src/index.ts docs/STORE_FORMAT.md
git commit -m "feat(shared): add agent-deck-store v1 schemas and STORE_FORMAT docs"
```

---

### Task 2: Store paths, atomic write, content hash

**Files:**
- Create: `packages/backend/src/store/paths.ts`
- Create: `packages/backend/src/store/atomic-write.ts`
- Create: `packages/backend/src/store/content-hash.ts`
- Create: `packages/backend/src/store/paths.test.ts`
- Create: `packages/backend/src/store/content-hash.test.ts`
- Create: `packages/backend/src/store/atomic-write.test.ts`

**Interfaces:**
- Produces:
  - `getStoreRoot(home?: string): string` — defaults to `resolveAgentDeckHome()`
  - `storePaths(home?: string): { root, manifest, playbooksDir, servicesDir, decksDir, credentialsDir }`
  - `writeFileAtomic(filePath: string, contents: string): Promise<void>`
  - `hashStoreTree(home?: string): Promise<string>` — sha256 hex of sorted relative path + content pairs; empty tree → stable empty hash
- Consumes: `resolveAgentDeckHome` from `../lib/paths`

- [ ] **Step 1: Write failing tests**

```ts
// packages/backend/src/store/atomic-write.test.ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write';

describe('writeFileAtomic', () => {
  it('writes final file and leaves no .tmp sibling', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-atomic-'));
    const file = path.join(dir, 'x.json');
    await writeFileAtomic(file, '{"a":1}\n');
    expect(await fs.readFile(file, 'utf8')).toBe('{"a":1}\n');
    const names = await fs.readdir(dir);
    expect(names.filter((n) => n.includes('.tmp'))).toEqual([]);
  });
});
```

```ts
// packages/backend/src/store/content-hash.test.ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashStoreTree } from './content-hash';
import { writeFileAtomic } from './atomic-write';
import { storePaths } from './paths';

describe('hashStoreTree', () => {
  it('changes when a playbook file changes', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-hash-'));
    process.env.AGENT_DECK_HOME = home;
    const { playbooksDir, manifest } = storePaths(home);
    await fs.mkdir(playbooksDir, { recursive: true });
    await writeFileAtomic(manifest, JSON.stringify({ format: 'agent-deck-store', version: 1 }));
    await writeFileAtomic(path.join(playbooksDir, 'pb_a.md'), '---\nid: pb_a\n---\none');
    const h1 = await hashStoreTree(home);
    await writeFileAtomic(path.join(playbooksDir, 'pb_a.md'), '---\nid: pb_a\n---\ntwo');
    const h2 = await hashStoreTree(home);
    expect(h1).not.toBe(h2);
  });
});
```

Also assert `storePaths(home).playbooksDir === path.join(home, 'playbooks')`.

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npm --workspace packages/backend run test -- src/store/atomic-write.test.ts src/store/content-hash.test.ts`

- [ ] **Step 3: Implement**

`atomic-write.ts`: mkdir parent; write `${filePath}.${process.pid}.${Date.now()}.tmp`; `rename` to final.

`paths.ts`:

```ts
import path from 'node:path';
import { resolveAgentDeckHome } from '../lib/paths';

export function getStoreRoot(home = resolveAgentDeckHome()): string {
  return home;
}

export function storePaths(home = resolveAgentDeckHome()) {
  const root = getStoreRoot(home);
  return {
    root,
    manifest: path.join(root, 'manifest.json'),
    playbooksDir: path.join(root, 'playbooks'),
    servicesDir: path.join(root, 'services'),
    decksDir: path.join(root, 'decks'),
    credentialsDir: path.join(root, 'credentials'),
  };
}
```

`content-hash.ts`: if dirs missing, treat as empty; collect files under the four dirs + `manifest.json` only; sort by relative path; `createHash('sha256')` update `path\0` + content for each; return hex. Do **not** include `agent_deck.db` or icons.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/store/paths.ts packages/backend/src/store/atomic-write.ts packages/backend/src/store/content-hash.ts packages/backend/src/store/*.test.ts
git commit -m "feat(backend): store paths, atomic write, and content hash"
```

---

### Task 3: Playbook / service / deck / credential codecs

**Files:**
- Modify: `packages/backend/package.json` — add dependencies `gray-matter`, `yaml`
- Create: `packages/backend/src/store/playbook-codec.ts` + `playbook-codec.test.ts`
- Create: `packages/backend/src/store/service-codec.ts` + test (thin wrap of `sanitizeServiceForExport`)
- Create: `packages/backend/src/store/deck-codec.ts` + test
- Create: `packages/backend/src/store/credential-codec.ts` + test (parse yaml-sync format; write via same line format or `yaml` stringify matching fields)

**Interfaces:**
- `serializePlaybook(p: StorePlaybookFile): string` / `parsePlaybookMarkdown(raw: string): StorePlaybookFile`
- `serializeService(s: StoreService): string` / `parseServiceJson(raw: string): StoreService`
- `serializeDeck(d: StoreDeck): string` / `parseDeckJson(raw: string): StoreDeck`
- `serializeCredentialMeta(c: StoreCredentialMeta): string` / `parseCredentialYaml(raw: string): StoreCredentialMeta`
- Round-trip must preserve id, title/body, ordered deck ids

- [ ] **Step 1: Install deps**

```bash
npm install gray-matter yaml --workspace packages/backend
```

- [ ] **Step 2: Write failing round-trip tests**

```ts
// packages/backend/src/store/playbook-codec.test.ts
import { describe, expect, it } from 'vitest';
import { parsePlaybookMarkdown, serializePlaybook } from './playbook-codec';

describe('playbook-codec', () => {
  it('round-trips body and frontmatter', () => {
    const input = {
      id: 'pb_demo',
      title: 'Demo',
      body: 'Hello\n\nworld',
      triggers: ['demo'],
      dependsOnCredentialIds: [],
      dependsOnServiceIds: ['svc-1'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const raw = serializePlaybook(input);
    expect(raw.startsWith('---\n')).toBe(true);
    expect(parsePlaybookMarkdown(raw)).toEqual(input);
  });
});
```

Similar tests for service JSON (no `localEnv`), deck JSON, credential YAML (`label: "OpenAI"` style compatible with existing yaml-sync files).

- [ ] **Step 3: Implement codecs**

Playbook: `gray-matter` stringify/parse; validate with `StorePlaybookFileSchema`.  
Service: `JSON.stringify(StoreServiceSchema.parse(...), null, 2) + '\n'`; parse + Zod. Building from DB `Service` uses `sanitizeServiceForExport`.  
Deck: JSON + Zod.  
Credential: prefer reading both hand-rolled yaml-sync files and `yaml.parse`; writing should match `CredentialYamlSync.write` field set so existing files remain valid (implement `parseCredentialYaml` robustly; `serializeCredentialMeta` can call shared helper used by yaml-sync — refactor yaml-sync to use codec serialize if clean).

- [ ] **Step 4: Run codec tests — PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/backend/package.json package-lock.json packages/backend/src/store/*codec*
git commit -m "feat(backend): codecs for store playbooks, services, decks, credentials"
```

---

### Task 4: Store writer + `store_meta` hash in SQLite

**Files:**
- Modify: `packages/backend/src/models/database.ts` — add table + getters/setters
- Create: `packages/backend/src/store/writer.ts` + `writer.test.ts`

**Interfaces:**
- DB:
  - Table `store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
  - `getStoreMeta(key: string): string | null`
  - `setStoreMeta(key: string, value: string): void`
  - Key constant `STORE_CONTENT_HASH = 'store_content_hash'`
- Writer:
  - `class FileStoreWriter { constructor(private home?: string) }`
  - `ensureLayout(manifest?: StoreManifest): Promise<void>`
  - `writePlaybook(p: StorePlaybookFile): Promise<void>`
  - `deletePlaybook(id: string): Promise<void>`
  - same for service / deck / credential
  - After each successful write/delete that changes tree: caller may update hash; or writer exposes `async touchHash(db: DatabaseManager)`

- [ ] **Step 1: Failing test — writer creates `playbooks/pb_x.md` and manifest**

Use temp `AGENT_DECK_HOME`, `FileStoreWriter`, assert file exists and parses.

- [ ] **Step 2: Implement DB `store_meta` in `createTables` + methods**

```sql
CREATE TABLE IF NOT EXISTS store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

- [ ] **Step 3: Implement `FileStoreWriter`** using codecs + `writeFileAtomic`; deletes unlink with ENOENT ok; `ensureLayout` mkdirs + writes manifest if missing (`version: 1`).

- [ ] **Step 4: Tests PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/models/database.ts packages/backend/src/store/writer.ts packages/backend/src/store/writer.test.ts
git commit -m "feat(backend): FileStoreWriter and store_meta content hash"
```

---

### Task 5: Migrate SQLite → files

**Files:**
- Create: `packages/backend/src/store/migrate.ts`
- Create: `packages/backend/src/store/migrate.test.ts`

**Interfaces:**
- `export type StoreMigrateResult = { wrote: { playbooks: number; services: number; credentials: number; decks: number }; dryRun: boolean; paths: string[] }`
- `export async function migrateSqliteToStore(db: DatabaseManager, opts?: { home?: string; dryRun?: boolean }): Promise<StoreMigrateResult>`
- Behavior:
  - If `manifest.json` exists and all entity files already present for current DB ids → no-op (or repair missing only); still return counts of would-write/wrote
  - Else dump all services (sanitized), playbooks (full), credentials (meta), decks (ordered membership from junctions)
  - Write `manifest.json` with `migratedFrom: "sqlite"`
  - Preserve ids
  - `dryRun: true` → list paths, write nothing
  - Update `store_meta` hash after real migrate

- [ ] **Step 1: Failing integration test**

Pattern from `export-import/round-trip.test.ts`: create temp home + temp db path under that home (`path.join(home, 'agent_deck.db')`), seed service/playbook/deck/credential, call migrate, assert files exist with same ids, assert dryRun writes nothing.

- [ ] **Step 2: Implement `migrateSqliteToStore`**

Use `db.getAllServices()`, `getAllPlaybooks()`, `getAllCredentials()`, `getAllDecks()` (or equivalent). For each deck, read ordered junction ids. Map through codecs + writer.

- [ ] **Step 3: Tests PASS**

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/store/migrate.ts packages/backend/src/store/migrate.test.ts
git commit -m "feat(backend): migrate SQLite collection to file store"
```

---

### Task 6: Reindex files → SQLite

**Files:**
- Create: `packages/backend/src/store/reindex.ts`
- Create: `packages/backend/src/store/reindex.test.ts`
- Modify: `packages/backend/src/models/database.ts` — add transactional helpers if needed:
  - `replaceCollectionFromStore(snapshot)` **or** clear-and-insert helpers for services/playbooks/credentials/decks/junctions **without** wiping `playbook_patches`, `playbook_versions`, `playbook_events`, `feedback_signals`, `exec_runs`, `deck_workspaces` unless orphaned

**Interfaces:**
- `export type StoreReindexResult = { ok: true; counts: {...}; warnings: string[]; contentHash: string } | { ok: false; error: string; conflicts?: Array<{ kind: string; value: string; paths: string[] }> }`
- `export async function reindexStoreToSqlite(db: DatabaseManager, opts?: { home?: string; force?: boolean }): Promise<StoreReindexResult>`
- Validation order:
  1. Read manifest — missing → error; bad version → error
  2. Parse all files; collect Zod errors as abort
  3. Detect duplicate titles/names/labels across files → `{ ok: false, conflicts }` — **do not mutate DB**
  4. In one SQLite transaction: upsert/replace card tables + junctions from snapshot; delete DB cards whose ids are absent from files (files win); leave learning-loop rows (orphaned patch rows may remain — acceptable v1; document)
  5. Set `store_content_hash`
- Credential secrets: only metadata rows; `hasSecret` / keychain untouched

- [ ] **Step 1: Failing tests**

1. migrate → delete db file → new DatabaseManager on same path → reindex → decks/playbooks/services match (ids preserved).  
2. Two playbooks same title in files → reindex fails, original DB row counts unchanged.  
3. Unknown manifest version → fail.

- [ ] **Step 2: Implement reindex carefully**

Prefer: build in-memory snapshot → validate → `db.transaction(() => { ... })`.  
For replacing cards: implement `DatabaseManager.applyStoreSnapshot(snapshot)` that deletes from `deck_*` junctions, then deletes services/credentials/playbooks/decks not in snapshot (or delete all card+deck+junction rows and reinsert — **do not** delete patches/events tables). Order: clear junctions → clear decks/cards → insert cards → insert decks → insert junctions.

- [ ] **Step 3: Tests PASS**

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/store/reindex.ts packages/backend/src/store/reindex.test.ts packages/backend/src/models/database.ts
git commit -m "feat(backend): reindex file store into SQLite with conflict abort"
```

---

### Task 7: Dual-write on mutations

**Files:**
- Modify: `packages/backend/src/playbooks/playbook-manager.ts` — after create/update/delete success, flush/delete playbook file; refresh hash
- Modify: `packages/backend/src/services/service-manager.ts` — same for services (sanitized)
- Modify: `packages/backend/src/vault/credential-manager.ts` — ensure yaml write remains the store credential file (already writes `credentials/`); after write, update store hash; on delete already removes yaml
- Modify: `packages/backend/src/routes/decks.ts` — after create/update/delete deck and after membership mutations (add/remove/reorder services, credentials, playbooks), rewrite that deck’s JSON
- Create: `packages/backend/src/store/dual-write.test.ts` — manager-level: create playbook → file exists; update body → file changes; delete → file gone

**Interfaces:**
- Inject or construct `FileStoreWriter` inside managers (same pattern as `CredentialYamlSync` in credential manager). Prefer optional `storeWriter?: FileStoreWriter` for tests.
- After dual-write: `db.setStoreMeta('store_content_hash', await hashStoreTree())` so startup does not needlessly reindex.

- [ ] **Step 1: Failing dual-write test with temp home + PlaybookManager**

- [ ] **Step 2: Wire writers**

PlaybookManager create/update/delete → serialize from DB row.  
ServiceManager → sanitize + write.  
Deck routes: helper `async function flushDeck(db, deckId, writer)` loads ordered ids and writes. Call from every membership endpoint that succeeds.

- [ ] **Step 3: Tests PASS** (also run existing playbook/service route tests if quick)

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/playbooks/playbook-manager.ts packages/backend/src/services/service-manager.ts packages/backend/src/vault/credential-manager.ts packages/backend/src/routes/decks.ts packages/backend/src/store/dual-write.test.ts
git commit -m "feat(backend): dual-write cards and decks to file store"
```

---

### Task 8: Startup `ensureStoreReady` + CLI

**Files:**
- Create: `packages/backend/src/store/startup.ts` + `startup.test.ts`
- Create: `packages/backend/src/store/index.ts` — re-export migrate, reindex, ensureStoreReady, writer
- Modify: `packages/backend/src/server/index.ts` — after `new DatabaseManager`, before seed (or after seed — prefer **after** seed so defaults get dumped on first run): `await ensureStoreReady(db)`
- Modify: `packages/backend/src/cli-runtime.ts` — add store helpers
- Create: `packages/cli/src/store.ts` + `store.test.ts` (arg parse)
- Modify: `packages/cli/src/index.ts` — usage + cases

**Interfaces:**
- `export async function ensureStoreReady(db: DatabaseManager, opts?: { home?: string }): Promise<{ migrated: boolean; reindexed: boolean }>`
  1. If no complete store (no manifest) and DB has any card/deck → `migrateSqliteToStore`
  2. Else if manifest exists and `hashStoreTree() !== db.getStoreMeta('store_content_hash')` → `reindexStoreToSqlite`
  3. If reindex fails validation → log error and **keep serving previous DB** (do not crash process); CLI `reindex` should exit non-zero
- CLI:
  - `agent-deck reindex` → force reindex, print JSON or human summary, exit 1 on failure
  - `agent-deck store migrate [--dry-run]` → migrate

```ts
// ensureStoreReady sketch
export async function ensureStoreReady(db: DatabaseManager, opts?: { home?: string }) {
  const home = opts?.home ?? resolveAgentDeckHome();
  const { manifest } = storePaths(home);
  const hasManifest = fs.existsSync(manifest);
  const hasData = /* db has any service|playbook|credential|deck */;
  let migrated = false;
  let reindexed = false;
  if (!hasManifest && hasData) {
    await migrateSqliteToStore(db, { home });
    migrated = true;
  }
  if (fs.existsSync(manifest)) {
    const disk = await hashStoreTree(home);
    const cached = db.getStoreMeta('store_content_hash');
    if (disk !== cached) {
      const result = await reindexStoreToSqlite(db, { home, force: true });
      if (!result.ok) {
        console.error('Store reindex failed:', result.error, result.conflicts);
      } else {
        reindexed = true;
      }
    }
  }
  return { migrated, reindexed };
}
```

- [ ] **Step 1: Tests for ensureStoreReady (migrate then hash match skips reindex)**

- [ ] **Step 2: Wire server + CLI**

Mirror export-import CLI pattern: `createCliStore` in cli-runtime opens DB at `resolveDatabasePath()`, calls migrate/reindex.

- [ ] **Step 3: Manual smoke (dev)**

```bash
# with backend stopped, using dev home
AGENT_DECK_DEV=1 npx agent-deck store migrate --dry-run
AGENT_DECK_DEV=1 npx agent-deck store migrate
AGENT_DECK_DEV=1 npx agent-deck reindex
```

Expected: files under `~/.agent-deck/dev/playbooks` etc.; reindex ok.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/store/startup.ts packages/backend/src/store/index.ts packages/backend/src/server/index.ts packages/backend/src/cli-runtime.ts packages/cli/src/store.ts packages/cli/src/store.test.ts packages/cli/src/index.ts
git commit -m "feat: startup store ready + CLI reindex and store migrate"
```

---

### Task 9: Docs sync + export/import regression

**Files:**
- Modify: `docs/SETUP.md` — short “File store & git sync” section linking `STORE_FORMAT.md`
- Modify: `README.md` — one paragraph under data/portability
- Modify: `docs/PRD_EXPORT_IMPORT.md` — note complementary file-store sync (not a replacement)
- Modify: `docs/superpowers/specs/2026-07-27-file-backed-store-git-sync-design.md` — Status → Approved / Implemented-in-progress as appropriate
- Run: existing export-import tests unchanged

- [ ] **Step 1: Update docs** (no git commands claimed as product features; show user-owned workflow)

- [ ] **Step 2: Regression**

```bash
npm --workspace packages/backend run test -- src/export-import/
npm --workspace packages/backend run test -- src/store/
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add docs/SETUP.md README.md docs/PRD_EXPORT_IMPORT.md docs/superpowers/specs/2026-07-27-file-backed-store-git-sync-design.md
git commit -m "docs: explain file store and user-owned git sync"
```

---

## Spec coverage checklist

| Spec item | Task |
|-----------|------|
| Files canonical; SQLite cache | 4–8 |
| Layout + manifest v1 | 1, 2, 4 |
| Playbook `.md` + timestamps in frontmatter | 1, 3 |
| Sanitized services; credential meta; decks with credentialIds | 1, 3, 5 |
| Atomic write | 2 |
| Content hash freshness (not mtime-only) | 2, 6, 8 |
| Migrate SQLite → files, preserve ids, dry-run | 5, 8 |
| Auto reindex on start + manual CLI | 6, 8 |
| Duplicate name abort, no partial apply | 6 |
| Dual-write mutations | 7 |
| No built-in git; docs only | 1 (`STORE_FORMAT.md`), 9 |
| Secrets / OAuth local | 3 sanitize, 6 meta-only credentials |
| Export/import still works | 9 regression |
| Learning-loop not in tree | 6 (tables preserved, not dumped) |

## Placeholder / consistency notes

- Credential path stays `credentials/` (same as today’s yaml-sync) — store root **is** Agent Deck home, not a nested `store/` folder (matches design §4).
- `BundleServiceSchema` reuse for `StoreServiceSchema` keeps export and store aligned.
- Startup reindex failure must not crash the API (log + keep DB); forced CLI reindex exits non-zero.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-27-file-backed-store-git-sync.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute tasks in this session with executing-plans checkpoints  

Which approach?
