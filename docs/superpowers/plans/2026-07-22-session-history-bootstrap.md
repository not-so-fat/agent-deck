# Session-History Playbook Bootstrap — Implementation Plan

> **Historical (2026-07-22)** — This record captures an earlier design, proposal, or verification run. See [the current guide](../../ARCHITECTURE.md) for shipped behavior.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `agent-deck bootstrap` — deterministic local parse of `~/.claude/projects` into size-bounded digests + a committed agent handoff that files playbook *proposals* (no backend LLM).

**Architecture:** Pure `digestSession` in `@agent-deck/backend` (no HTTP/model imports). Zod contracts in `@agent-deck/shared` matching PRD §7. Thin CLI enumerates history, writes timestamped digests + manifest + authoring guide into `$AGENT_DECK_HOME/bootstrap/<ISO>/` (default `~/.agent-deck/bootstrap/`), updates a `latest` pointer file, prints a copy-paste handoff. Agent authors via existing `propose_playbook_patch { kind: "create" }`.

**Tech Stack:** TypeScript, Zod, Vitest, npm workspaces (`@agent-deck/shared`, `@agent-deck/backend`, `@agent-deck/cli`). No new runtime deps.

**PRD:** `docs/session-history-bootstrap/PRD.md`

## Global Constraints

- Zero LLM / network calls in bootstrap parse + CLI write path (PRD F3.4, NFR-5).
- No `register_playbook` from this feature — proposals only (US-3).
- Digest serialized size ≤ 4096 UTF-8 bytes (NFR-2).
- Same input → byte-identical digest (NFR-4).
- `workspaceRoot` = first-seen `cwd`; `workspaceLabel` = `basename(cwd)` — do **not** decode Claude project dir names (F1.5). Fix stale PRD §8 line that still says “decode”.
- Contracts live as **Zod in shared** (repo convention); PRD allows `packages/shared`. Mirror field caps from §7 exactly.
- Closest prior art: `packages/cli/src/import-feedback-signals.ts` (heuristic JSONL) — **do not extend it**; bootstrap is a separate module with stricter predicates.

---

## File map

| File | Responsibility |
|------|----------------|
| `packages/shared/src/schemas/session-bootstrap.ts` | Zod: `SessionDigest`, `FeedbackMoment`, `BootstrapManifest` + inferred types |
| `packages/shared/src/index.ts` | Re-export bootstrap schemas |
| `packages/backend/src/bootstrap/digest-session.ts` | `digestSession(sessionId, lines) → SessionDigest` |
| `packages/backend/src/bootstrap/feedback-lexicon.ts` | Marker lists + polarity hint |
| `packages/backend/src/bootstrap/extractors.ts` | commands / tools / skills / topFiles / outcome helpers |
| `packages/backend/src/bootstrap/real-intent.ts` | F1.2 predicate + text extraction |
| `packages/backend/src/bootstrap/enumerate.ts` | Walk Claude projects dir → session paths |
| `packages/backend/src/bootstrap/run-bootstrap.ts` | Write digests, manifest, guide, `latest` pointer |
| `packages/backend/src/bootstrap/authoring-guide.ts` | `GUIDE_REF`, `AUTHORING_GUIDE_MARKDOWN` |
| `packages/backend/src/bootstrap/handoff.ts` | Fixed stdout handoff block |
| `packages/backend/src/bootstrap/*.test.ts` | Unit + fixture tests |
| `packages/backend/src/bootstrap/fixtures/*.jsonl` | Tiny synthetic transcripts |
| `packages/backend/src/bootstrap/no-llm-imports.test.ts` | Static import ban |
| `packages/backend/package.json` | Export `./bootstrap` subpath |
| `packages/backend/src/bootstrap/index.ts` | Public re-exports for CLI |
| `packages/cli/src/bootstrap.ts` | `runBootstrapCommand` arg parse + invoke |
| `packages/cli/src/bootstrap.test.ts` | Temp-dir integration |
| `packages/cli/src/index.ts` | Register `bootstrap` + usage line |
| `docs/session-history-bootstrap/PRD.md` | Fix §8 decode stale line; link plan |

---

### Task 1: Shared Zod contracts

**Files:**
- Create: `packages/shared/src/schemas/session-bootstrap.ts`
- Create: `packages/shared/src/schemas/session-bootstrap.test.ts`
- Modify: `packages/shared/src/index.ts` — add `export * from './schemas/session-bootstrap'`

**Interfaces:**
- Produces: `SessionDigestSchema`, `FeedbackMomentSchema`, `BootstrapManifestSchema`, types `SessionDigest`, `FeedbackMoment`, `BootstrapManifest`
- Caps (verbatim from PRD): intents/commands/tools/skills maxItems 40; topFiles 20; feedbackMoments 30; intent text 280; command 160; agentAction/followupChange 400; userReaction 600; outcome.signal enum `pr_opened | committed | unknown`

- [ ] **Step 1: Write failing schema tests**

```ts
// packages/shared/src/schemas/session-bootstrap.test.ts
import { describe, expect, it } from 'vitest';
import { SessionDigestSchema, FeedbackMomentSchema, BootstrapManifestSchema } from './session-bootstrap';

describe('session-bootstrap schemas', () => {
  it('rejects abandoned outcome signal', () => {
    const r = SessionDigestSchema.safeParse({
      schemaVersion: 1,
      sessionId: 's1',
      workspaceRoot: '/tmp/w',
      startedAt: '2026-01-01T00:00:00.000Z',
      turnCount: 0,
      intents: [],
      feedbackMoments: [],
      outcome: { signal: 'abandoned' },
    });
    expect(r.success).toBe(false);
  });

  it('accepts minimal valid digest', () => {
    const r = SessionDigestSchema.safeParse({
      schemaVersion: 1,
      sessionId: 's1',
      workspaceRoot: '/tmp/w',
      startedAt: '2026-01-01T00:00:00.000Z',
      turnCount: 0,
      intents: [],
      feedbackMoments: [],
      outcome: { signal: 'unknown' },
    });
    expect(r.success).toBe(true);
  });

  it('requires polarityHint on FeedbackMoment', () => {
    const r = FeedbackMomentSchema.safeParse({
      agentAction: 'Edited foo.ts',
      userReaction: 'no, use basename',
      markers: ['no'],
    });
    expect(r.success).toBe(false);
  });

  it('accepts BootstrapManifest with guideRef', () => {
    const r = BootstrapManifestSchema.safeParse({
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      digestDir: '/tmp/out',
      guideRef: '/tmp/out/authoring-guide.md',
      totalSessions: 0,
      workspaces: [],
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (module missing)**

```bash
cd /Users/not_so_fat/workspace/codes/agent_deck/packages/shared && npx vitest run src/schemas/session-bootstrap.test.ts
```

Expected: FAIL — cannot find module `./session-bootstrap`

- [ ] **Step 3: Implement Zod schemas**

Implement `session-bootstrap.ts` with:
- `FeedbackMomentSchema` — required `agentAction`, `userReaction`, `polarityHint` (`negative|positive|mixed|unknown`), `markers`; optional `followupChange` (string|null), `at`
- `SessionDigestSchema` — required fields from PRD §7.1; `additional` fields optional with defaults empty arrays where helpful for parse output; use `.strict()` / strip unknown via Zod default (`.strict()` to match `additionalProperties: false`)
- `BootstrapManifestSchema` — §7.3
- Export inferred types

Truncate enforcement at **write time** in the parser (Task 2+); schemas use `z.string().max(N)` so invalid oversized digests fail validation in tests.

- [ ] **Step 4: Re-export from shared index; run tests**

```bash
cd /Users/not_so_fat/workspace/codes/agent_deck/packages/shared && npx vitest run src/schemas/session-bootstrap.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/schemas/session-bootstrap.ts packages/shared/src/schemas/session-bootstrap.test.ts packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
feat(shared): add session-bootstrap Zod contracts

EOF
)"
```

---

### Task 2: Real-intent predicate + digest skeleton

**Files:**
- Create: `packages/backend/src/bootstrap/real-intent.ts`
- Create: `packages/backend/src/bootstrap/digest-session.ts`
- Create: `packages/backend/src/bootstrap/digest-session.test.ts`
- Create: `packages/backend/src/bootstrap/fixtures/qa-only.jsonl`
- Create: `packages/backend/src/bootstrap/fixtures/tool-echo.jsonl`
- Create: `packages/backend/src/bootstrap/index.ts`
- Modify: `packages/backend/package.json` — add `"./bootstrap"` export

**Interfaces:**
- Produces:
  - `isRealUserIntent(line: unknown): boolean`
  - `extractUserText(line: unknown): string | null` — string content, or join text blocks only; if any non-text block in array → not a real intent (F1.2 “all-text blocks”)
  - `digestSession(sessionId: string, lines: unknown[]): SessionDigest`
- Consumes: `SessionDigestSchema` from `@agent-deck/shared`

**Fixture `qa-only.jsonl`:** three user/assistant text turns, no tools, cwd `/Users/x/proj`. Expect 3 intents, 0 feedbackMoments, outcome unknown.

**Fixture `tool-echo.jsonl`:** user line with `toolUseResult` present + a real user string turn. Expect intents exclude the echo.

- [ ] **Step 1: Write failing tests for predicate + skeleton**

```ts
// packages/backend/src/bootstrap/digest-session.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { digestSession } from './digest-session';
import { isRealUserIntent } from './real-intent';
import { SessionDigestSchema } from '@agent-deck/shared';

function loadFixture(name: string): unknown[] {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe('isRealUserIntent', () => {
  it('rejects toolUseResult echoes', () => {
    expect(
      isRealUserIntent({
        type: 'user',
        message: { role: 'user', content: 'ok' },
        toolUseResult: { ok: true },
      }),
    ).toBe(false);
  });

  it('rejects sidechain', () => {
    expect(
      isRealUserIntent({
        type: 'user',
        message: { role: 'user', content: 'hi' },
        isSidechain: true,
      }),
    ).toBe(false);
  });

  it('rejects mixed content blocks (tool_result + text)', () => {
    expect(
      isRealUserIntent({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', content: 'x' },
            { type: 'text', text: 'hi' },
          ],
        },
      }),
    ).toBe(false);
  });
});

describe('digestSession', () => {
  it('parses qa-only fixture', () => {
    const d = digestSession('sess-qa', loadFixture('qa-only.jsonl'));
    expect(SessionDigestSchema.safeParse(d).success).toBe(true);
    expect(d.workspaceRoot).toBe('/Users/x/proj');
    expect(d.workspaceLabel).toBe('proj');
    expect(d.intents.length).toBeGreaterThanOrEqual(1);
    expect(d.feedbackMoments).toEqual([]);
    expect(d.outcome.signal).toBe('unknown');
  });

  it('skips malformed lines without throwing', () => {
    const d = digestSession('s', [{ type: 'user' }, 'not-json-object', { type: 'assistant' }]);
    expect(d.skippedLineCount).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic', () => {
    const lines = loadFixture('qa-only.jsonl');
    expect(JSON.stringify(digestSession('s', lines))).toBe(JSON.stringify(digestSession('s', lines)));
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd /Users/not_so_fat/workspace/codes/agent_deck/packages/backend && npx vitest run src/bootstrap/digest-session.test.ts
```

- [ ] **Step 3: Implement real-intent + digest skeleton**

`digestSession` must:
1. Iterate lines; JSON already parsed by caller OR accept unknown and count skips for non-objects / missing type.
2. Capture first `cwd` → `workspaceRoot` / `basename` → `workspaceLabel`; first `gitBranch` if any.
3. Collect intents from real user turns (truncate text to 280).
4. Set `startedAt`/`endedAt` from first/last timestamps when present; else ISO epoch placeholders consistent for determinism (prefer: require first timestamp or use `'1970-01-01T00:00:00.000Z'` only when absent — document choice in code comment; same input → same output).
5. `turnCount` = count of real user intents (or user+assistant pairs — pick **real user intent count** and stick to it).
6. Stub empty `commands`, `tools`, `skills`, `topFiles`, `feedbackMoments`; `outcome: { signal: 'unknown' }` until Task 3–4.
7. Never throw — wrap per-line try/catch → `skippedLineCount++`.

Add `package.json` export:

```json
"./bootstrap": {
  "types": "./dist/bootstrap/index.d.ts",
  "default": "./dist/bootstrap/index.js"
}
```

`index.ts` re-exports `digestSession` (more exports in later tasks).

- [ ] **Step 4: Tests PASS**

```bash
cd /Users/not_so_fat/workspace/codes/agent_deck/packages/backend && npx vitest run src/bootstrap/digest-session.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/bootstrap packages/backend/package.json
git commit -m "$(cat <<'EOF'
feat(backend): add digestSession skeleton and real-intent predicate

EOF
)"
```

---

### Task 3: Extractors — tools, commands, skills, topFiles, outcome

**Files:**
- Create: `packages/backend/src/bootstrap/extractors.ts`
- Create: `packages/backend/src/bootstrap/extractors.test.ts`
- Create: `packages/backend/src/bootstrap/fixtures/with-tools.jsonl`
- Modify: `packages/backend/src/bootstrap/digest-session.ts` — wire extractors

**Interfaces:**
- Produces helpers used inside `digestSession`:
  - `summarizeAssistantAction(line) → { summary: string; filePaths: string[]; toolNames: string[]; bashCommands: string[]; skills: string[] }`
  - `normalizeBashCommand(cmd: string): string` — first significant token(s): strip env assigns / leading flags conservatively; e.g. `git commit -m "x"` → `git commit`; `gh pr create` → `gh pr create` (keep two tokens when first is `git`/`gh`/`npm`/`npx`)
  - `deriveOutcome(commands: {command,count}[]): { signal; evidence? }` — F1.6: any command string includes `gh pr create` → `pr_opened`; else includes `git commit` → `committed`; else `unknown`. Prefer `pr_opened` if both.

**Fixture `with-tools.jsonl`:** assistant Bash `git commit -m hi`, Edit `src/a.ts`, Skill `input.skill: "review"`, user slash `/commit` text, user correction turn (for Task 4).

- [ ] **Step 1: Failing extractor + digest tests**

```ts
it('counts tools, files, skills, and outcome from with-tools', () => {
  const d = digestSession('sess-tools', loadFixture('with-tools.jsonl'));
  expect(d.tools.some((t) => t.name === 'Bash')).toBe(true);
  expect(d.commands.some((c) => c.command === 'git commit')).toBe(true);
  expect(d.topFiles.some((f) => f.path.endsWith('a.ts') && f.edits >= 1)).toBe(true);
  expect(d.skills.some((s) => s.name === 'review' || s.name === 'commit')).toBe(true);
  expect(d.outcome.signal).toBe('committed');
  expect(d.outcome.evidence).toMatch(/git commit/);
});
```

Skills sources (F1.3): `Skill` tool_use `input.skill` **and** user-content slash (`/^\/([a-z0-9][\w-]*)/i` on intent text) **and** `<command-name>...</command-name>` if present in text.

- [ ] **Step 2: Implement extractors; wire into digestSession; sort maps deterministically** (e.g. by count desc then name asc) before capping `maxItems`.

- [ ] **Step 3: Tests PASS + commit**

```bash
cd /Users/not_so_fat/workspace/codes/agent_deck/packages/backend && npx vitest run src/bootstrap
git add packages/backend/src/bootstrap
git commit -m "$(cat <<'EOF'
feat(backend): extract tools, commands, skills, files, outcome in digests

EOF
)"
```

---

### Task 4: Feedback moments (F2)

**Files:**
- Create: `packages/backend/src/bootstrap/feedback-lexicon.ts`
- Create: `packages/backend/src/bootstrap/feedback-moments.ts`
- Create: `packages/backend/src/bootstrap/feedback-moments.test.ts`
- Create: `packages/backend/src/bootstrap/fixtures/feedback-negative.jsonl`
- Create: `packages/backend/src/bootstrap/fixtures/feedback-reedit.jsonl`
- Modify: `packages/backend/src/bootstrap/digest-session.ts`

**Interfaces:**
- Produces: `extractFeedbackMoments(events) → FeedbackMoment[]` (max 30)
- Lexicon (starter English, PRD §12):  
  - negative: `no`, `don't`, `do not`, `actually`, `instead`, `wrong`, `revert`, `undo`, `never`, `stop`  
  - positive: `perfect`, `works`, `great`, `ship it`, `lgtm`, `exactly`  
  Word-boundary match, case-insensitive; collect which markers fired.
- Polarity: only negative → `negative`; only positive → `positive`; both → `mixed`; none → `unknown` (moments with no markers only qualify via structural re-edit — F2.1).

**Qualification (F2.1):** real user intent **after** an assistant action that had `tool_use` (or Edit/Write), **and** (≥1 marker **or** next assistant action re-edits a `file_path` touched in the preceding assistant action).

- [ ] **Step 1: Failing tests**

```ts
it('qa-only yields zero moments', () => {
  expect(digestSession('s', loadFixture('qa-only.jsonl')).feedbackMoments).toEqual([]);
});

it('captures negative marker moment', () => {
  const d = digestSession('s', loadFixture('feedback-negative.jsonl'));
  expect(d.feedbackMoments.length).toBeGreaterThanOrEqual(1);
  expect(d.feedbackMoments[0].polarityHint).toBe('negative');
  expect(d.feedbackMoments[0].markers.length).toBeGreaterThan(0);
  expect(d.feedbackMoments[0].agentAction.length).toBeGreaterThan(0);
});

it('captures structural re-edit without markers', () => {
  const d = digestSession('s', loadFixture('feedback-reedit.jsonl'));
  expect(d.feedbackMoments.some((m) => m.followupChange != null)).toBe(true);
});
```

- [ ] **Step 2: Implement; truncate strings to schema maxLength; tests PASS; commit**

```bash
git commit -m "$(cat <<'EOF'
feat(backend): extract feedback moments with lexicon and re-edit signal

EOF
)"
```

---

### Task 5: Size budget, pathological transcript, no-LLM import guard

**Files:**
- Create: `packages/backend/src/bootstrap/size.test.ts`
- Create: `packages/backend/src/bootstrap/no-llm-imports.test.ts`
- Modify: `digest-session.ts` if caps not yet applied after sort

- [ ] **Step 1: Pathological size test**

```ts
it('keeps digest ≤ 4096 bytes for a huge transcript', () => {
  const lines: unknown[] = [];
  for (let i = 0; i < 2000; i++) {
    lines.push({
      type: 'user',
      cwd: '/w',
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      message: { role: 'user', content: 'x'.repeat(500) + ` turn ${i}` },
    });
    lines.push({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: `echo ${i}` } }],
      },
    });
  }
  const d = digestSession('huge', lines);
  const bytes = Buffer.byteLength(JSON.stringify(d), 'utf8');
  expect(bytes).toBeLessThanOrEqual(4096);
  expect(SessionDigestSchema.safeParse(d).success).toBe(true);
});
```

- [ ] **Step 2: no-LLM import guard**

```ts
// Scan bootstrap/*.ts (exclude *.test.ts) source text — fail if matches
// /openai|anthropic|@ai-sdk|fetch\(|axios|node-fetch|undici/i
// Allow comments? Prefer ban even in comments for simplicity, or only import lines:
// /^import .+ from ['"].*(openai|anthropic)/ 
```

- [ ] **Step 3: PASS + commit**

```bash
git commit -m "$(cat <<'EOF'
test(backend): enforce digest byte budget and no-LLM imports in bootstrap

EOF
)"
```

---

### Task 6: Enumerate history + write digests/manifest/guide/latest

**Files:**
- Create: `packages/backend/src/bootstrap/enumerate.ts`
- Create: `packages/backend/src/bootstrap/run-bootstrap.ts`
- Create: `packages/backend/src/bootstrap/authoring-guide.ts`
- Create: `packages/backend/src/bootstrap/handoff.ts`
- Create: `packages/backend/src/bootstrap/run-bootstrap.test.ts`
- Modify: `packages/backend/src/bootstrap/index.ts` — export `runBootstrap`, `formatHandoffBlock`, `GUIDE_REF`

**Interfaces:**

```ts
export type BootstrapOptions = {
  projectsDir: string;       // default: ~/.claude/projects ; env AGENT_DECK_CLAUDE_PROJECTS_DIR
  outDir?: string;           // --out; else $AGENT_DECK_HOME/bootstrap/<ISO-timestamp>/
  bootstrapRoot?: string;    // parent of timestamp dirs; default $AGENT_DECK_HOME/bootstrap
  workspace?: string;        // --workspace absolute path filter (match digest cwd / session cwd)
  since?: string;            // ISO date; filter by session file mtime or first timestamp
  limit?: number;            // max sessions
  now?: () => Date;          // inject for tests
};

export type BootstrapResult = {
  outDir: string;
  manifestPath: string;
  guidePath: string;
  latestPointerPath: string;
  manifest: BootstrapManifest;
  warning?: string;          // e.g. under 5 sessions
};

export function runBootstrap(opts: BootstrapOptions): BootstrapResult;
export function formatHandoffBlock(result: BootstrapResult): string;
```

**Enumerate rules:**
- Walk `projectsDir/*/*.jsonl` (one level of workspace dirs).
- Skip non-`.jsonl`.
- Read file line-by-line (streaming ok; for v1 `readFileSync` + split is fine if tests stay small).
- Session id = basename without `.jsonl`.

**Write layout:**
```
<outDir>/
  authoring-guide.md          # copy of AUTHORING_GUIDE_MARKDOWN
  manifest.json
  digests/<workspaceLabel>__<sessionId>.json   # sanitize label for filename
$AGENT_DECK_HOME/bootstrap/latest          # pointer FILE containing absolute outDir + newline (not symlink)
```

**Handoff block (F3.5)** — exact shape (stdout must end with this; tests match):

```
--- agent-deck bootstrap handoff ---
1. Load the authoring guide: <absolute guidePath>
   (guideRef: pb_session_bootstrap_authoring)
2. Read the manifest: <absolute manifestPath>
3. Bind the workspace you are in, then propose playbooks for the bound deck only
   (load digests whose workspaceRoot matches; hold others).
--- end handoff ---
```

**Privacy line** (PRD §8): print once **before** the handoff:

```
Note: digests include verbatim user-reaction excerpts. Parsing is local; digests enter your agent context when authoring.
```

**Authoring guide body (F4.2–F4.4)** — must include numbered steps citing field names:

1. Read manifest at handoff path  
2. For bound deck workspace, load matching digests (`workspaceRoot`)  
3. Cluster by task shape (not wording)  
4. Per cluster draft playbook: triggers ← recurring `intents`; Gotchas ← `negative` `feedbackMoments`; Techniques ← `positive`; generalize names/paths  
5. File only via `propose_playbook_patch` with `kind: "create"` and `new_playbook: { title, triggers, body }` — never `register_playbook`  
6. Multi-workspace: one bound deck per run; re-bind + re-run authoring for other workspaces  

Set `manifest.guideRef` to the **absolute** `authoring-guide.md` path written into `outDir` (loadable artifact). Logical id `pb_session_bootstrap_authoring` appears in handoff + guide title.

- [ ] **Step 1: Integration test with temp projects dir**

```ts
it('writes digests, manifest, guide, latest pointer', () => {
  const projects = makeTempProjects(/* copy fixtures into fake workspace dirs */);
  const root = fs.mkdtempSync(...);
  const result = runBootstrap({
    projectsDir: projects,
    bootstrapRoot: root,
    now: () => new Date('2026-07-22T12:00:00.000Z'),
  });
  expect(fs.existsSync(result.manifestPath)).toBe(true);
  expect(fs.existsSync(result.guidePath)).toBe(true);
  expect(fs.readFileSync(path.join(root, 'latest'), 'utf8').trim()).toBe(result.outDir);
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  expect(BootstrapManifestSchema.safeParse(manifest).success).toBe(true);
  expect(formatHandoffBlock(result)).toContain('--- agent-deck bootstrap handoff ---');
  expect(formatHandoffBlock(result)).toContain(result.manifestPath);
});

it('second run creates a new dir and updates latest', () => {
  // two now() values → two out dirs; latest → second
});
```

- [ ] **Step 2: Implement enumerate + runBootstrap + guide + handoff**

- [ ] **Step 3: PASS + commit**

```bash
git commit -m "$(cat <<'EOF'
feat(backend): runBootstrap writes digests, manifest, guide, and latest pointer

EOF
)"
```

---

### Task 7: CLI `agent-deck bootstrap`

**Files:**
- Create: `packages/cli/src/bootstrap.ts`
- Create: `packages/cli/src/bootstrap.test.ts`
- Modify: `packages/cli/src/index.ts` — case `'bootstrap'` + usage
- Modify: `packages/cli/src/backend-runtime.ts` or resolve via `require.resolve('@agent-deck/backend/bootstrap')` (match existing lazy-load pattern)

**Args:**
```
agent-deck bootstrap [--workspace <path>] [--since <ISO-date>] [--limit <n>] [--out <dir>] [--projects-dir <path>]
```

Env: `AGENT_DECK_CLAUDE_PROJECTS_DIR` overrides default projects dir when `--projects-dir` omitted.

- [ ] **Step 1: CLI test with temp dirs** (invoke `runBootstrapCommand` directly; do not spawn network)

```ts
it('exits 0 and prints handoff', async () => {
  const code = await runBootstrapCommand([
    '--projects-dir', projects,
    '--out', out,
  ]);
  expect(code).toBe(0);
  // capture stdout via mock or return string from helper — prefer testing
  // formatHandoffBlock via backend unit tests; CLI test checks exit 0 + files exist
});
```

- [ ] **Step 2: Implement CLI; register in `runCli` + `printUsage`**

Usage blurb:

```
bootstrap [--workspace <path>] [--since <date>] [--limit <n>] [--out <dir>]
  Mine local Claude Code session history into playbook-proposal digests (offline).
```

- [ ] **Step 3: Ensure turbo build exports work**

```bash
cd /Users/not_so_fat/workspace/codes/agent_deck && npm run build --workspace=@agent-deck/shared --workspace=@agent-deck/backend
cd packages/cli && npx vitest run src/bootstrap.test.ts
```

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(cli): add agent-deck bootstrap command with offline handoff

EOF
)"
```

---

### Task 8: PRD sync + M3 smoke checklist

**Files:**
- Modify: `docs/session-history-bootstrap/PRD.md` — §8 “decode for workspaceLabel” → match F1.5 (`basename` of first `cwd` only)
- Create: `docs/session-history-bootstrap/SMOKE.md` — human-run M3 checklist (not CI)

**SMOKE.md contents (exact checklist):**
1. Backend + MCP running; deck bound to a workspace that appears in digests  
2. `agent-deck bootstrap --workspace <that-root>`  
3. Paste handoff into agent chat  
4. Confirm ≥3 `create` proposals in dashboard queue  
5. Spot-check ≥1 Gotcha/Technique cites a digest `feedbackMoment`  
6. Confirm no playbook auto-registered  

- [ ] **Step 1: Edit PRD §8; add SMOKE.md**
- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
docs: sync bootstrap PRD workspace rule and add M3 smoke checklist

EOF
)"
```

---

### Task 9: Full package test pass (CI gate for M1–M2)

- [ ] **Step 1: Run**

```bash
cd /Users/not_so_fat/workspace/codes/agent_deck
npm test --workspace=@agent-deck/shared --workspace=@agent-deck/backend --workspace=@agent-deck/cli
```

Expected: all green. If bootstrap CLI needs built backend, rely on turbo `test` → `^build` or document `npm run build` first.

- [ ] **Step 2: Optional offline proof (manual / script under `.temporal/`)**

```bash
# with network disabled if available on the host:
agent-deck bootstrap --projects-dir <fixture-tree> --out .temporal/bootstrap-out
```

- [ ] **Step 3: Do not claim M3 done until SMOKE.md is human-run**

---

## Spec coverage (self-review)

| PRD item | Task |
|----------|------|
| F1.1–F1.6 parser | 2–5 |
| F2 feedback | 4 |
| F3.1–F3.5 CLI + handoff + timestamped dirs + latest | 6–7 |
| F4 authoring guide | 6 (`authoring-guide.ts`) |
| NFR-2/3/4/5 | 5, 6–7, 9 |
| US-1 CI | 7, 9 |
| US-2/3/4 agent | 8 smoke (M3) |
| §8 privacy note | 6 handoff preamble |
| Open: lexicon / min-5 warning / pointer file | 4 lexicon; 6 warning + pointer file |

## Out of scope (do not implement)

- Stop-hook ongoing capture  
- Backend LLM / embeddings  
- Decoding Claude project directory names  
- Auto-register playbooks  
- Extending `import-feedback-signals` instead of new module  

---

## Execution notes

- Prefer **TDD per task**; do not start CLI until `digestSession` + `runBootstrap` are green.
- When reading real `~/.claude/projects` during local smoke, never commit those digests.
- If fixture shapes diverge from a real transcript line, add one **sanitized** real-line fixture (strip secrets) under `fixtures/real-snippet.jsonl` and assert the predicate still holds — keep PII out of git.
