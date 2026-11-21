---

> **Historical (2026-07-22)** — This record captures an earlier design, proposal, or verification run. See [the current guide](../ARCHITECTURE.md) for shipped behavior.

title: Session-History Playbook Bootstrap — PRD
status: draft
supersedes: null
sources:
  - brainstorm: 2026-07-22 session (this conversation)
  - brainstorm: 2026-07-22 Cursor host extension
  - memory: playbook-learning-loop-direction (phase 3 "capture escalation")
  - playbooks: pb_ai_codegen_prd, pb_product_principle
  - inspection: ~/.claude/projects JSONL; ~/.cursor/projects/*/agent-transcripts JSONL
---

# Session-History Playbook Bootstrap

**Value statement:** A first-time Agent Deck user gets a starter set of playbook *proposals* — mined from their own past **Claude Code and/or Cursor** agent sessions, including the real corrections they gave — without the backend ever calling an LLM.

## 1. Product overview

Agent Deck's value compounds once a user has playbooks: the learning loop refines them, triggers surface them, and the agent stops re-deriving how the user works. But a **new user starts empty**, and an empty deck can't demonstrate any of that. This is the cold-start problem.

Users already carry dense local history:

- **Claude Code:** `~/.claude/projects/<encoded-workspace>/<sessionId>.jsonl`
- **Cursor:** `~/.cursor/projects/<projectSlug>/agent-transcripts/<sessionId>/<sessionId>.jsonl` (and legacy flat layouts)

Both hold requests, tool calls, and — critically — corrections. This feature turns that history into playbook proposals.

The split is load-bearing and matches Agent Deck's architecture: the **backend parses and reduces with zero LLM** (one digest schema, **per-host adapters**); the **user's own agent authors** the playbooks from the reduced digests, landing them in the existing propose-first review queue.

**One-liner:** Parse local Claude and/or Cursor session history into compact digests (deterministically), then let the user's agent draft playbook proposals from them.

**Success criteria (time-boxed):** split by what verifies each — deterministic parts by **CI**, the agent loop by **smoke** (§11 M3).
- **Deterministic exit (CI):** On ≥10 real sessions in ≥1 workspace **per enabled host**, `agent-deck bootstrap` exits 0, writes a valid manifest + digests, makes zero network/LLM calls, and prints a committed handoff block (F3.5). Covered by F1–F3 + NFR checks. Host matrix: Claude fixtures **and** Cursor fixtures both required.
- **Agent exit (smoke, human-run):** Following the printed handoff, a bound agent files ≥3 playbook `create` proposals, each carrying ≥1 Gotcha/Technique traceable to a specific `feedbackMoment` — under 5 minutes wall time. Smoke may use Claude-only, Cursor-only, or mixed digests (§11 / [SMOKE.md](./SMOKE.md)).

## 2. Target users & roles

**Persona — "Dana, the first-run user":** has used Claude Code and/or Cursor Agent for weeks across a few repos, just installed Agent Deck, has an empty deck, and doesn't yet see why playbooks matter. Dana will not hand-write playbooks cold.

| Role | Goal | v1 surface |
|---|---|---|
| First-run user | Get useful playbooks without authoring from scratch | `agent-deck bootstrap [--host …]` CLI + dashboard review queue |
| Returning user | Backfill playbooks from history accumulated before install | Same CLI, re-runnable |
| Reviewer (same human) | Accept/edit/reject proposals | Existing propose-first dashboard queue |

**PM opener:** the job is *cold-start*, not *ongoing capture*. Success is "the empty state is no longer empty and the proposals are worth keeping," not "we captured everything." Host coverage is about **where history already lives**, not about unifying product UX across IDEs.

**Voice rules:** CLI output is a cold-reader contract (stdout parsed by the agent and read by a human); no memo-to-reviewer tone.

## 3. User stories (testable)

**US-1 — Bootstrap from history.**
As a first-run user, I want to run one command that scans my past sessions, so that I get candidate playbooks without writing any.
- [ ] `agent-deck bootstrap` exits 0 and writes a manifest + per-session digests to a known path.
- [ ] The command makes **zero** network/LLM calls (verifiable: runs offline).
- [ ] Output names how many sessions/workspaces were processed and where digests landed.

**US-1b — Choose host(s).**
As a user who works in Claude Code, Cursor, or both, I want to select which local history trees to mine, so that bootstrap matches how I actually work.
- [ ] `--host claude|cursor|all` is honored (default **`all`** when both trees exist; if only one tree exists, that host alone is enough for exit 0).
- [ ] Manifest/digests identify the source host (F1.0 / §7.1 `host`).
- [ ] Cursor runs exclude `**/subagents/**` transcripts (F1C.2).

**US-2 — Feedback becomes lessons.**
As a user, I want the corrections I gave in past sessions to seed playbook Gotchas/Techniques, so that proposals reflect what actually went wrong/right for me.
- [ ] Each digest's `feedbackMoments[]` captures ≥ the user reaction, the preceding agent action, and a polarity *hint*.
- [ ] The agent's authoring guide instructs seeding Gotchas from negative moments and Techniques from positive ones.
- [ ] At least one filed proposal contains a Gotcha/Technique traceable to a specific feedback moment.

**US-3 — Proposals, never auto-writes.**
As a reviewer, I want everything to arrive as reviewable proposals, so that nothing is registered without my approval.
- [ ] Bootstrap output reaches the deck **only** via `propose_playbook_patch { kind: "create" }`.
- [ ] No code path in this feature calls `register_playbook` / `create` playbook directly.

**US-4 — Workspaces map to deck clusters.**
As a user with multiple repos, I want proposals grouped by the workspace they came from, so that deck-level organization falls out naturally.
- [ ] Each digest carries `workspaceRoot` (and Cursor `workspaceLabel` / match rules per F1C.5); the guide clusters by workspace and proposes into the **bound deck** for the matching workspace only (F4.3) — never into an unbound/mismatched deck.

**Deferred (see §10):** ongoing per-session capture (Stop hook); deck service/key inference; embeddings-based clustering; Cursor `state.vscdb` / `~/.cursor/chats/*/store.db` as primary inputs.

## 4. Features & requirements

### F1.0 — Shared digest boundary (all hosts)

| Req ID | Requirement | Acceptance |
|---|---|---|
| F1.0.1 | Every host adapter emits the same `SessionDigest` (§7.1), including required `host: "claude" \| "cursor"`. | Fixture digests from both hosts validate against one schema. |
| F1.0.2 | Digests remain size-bounded (§9 NFR-2). **Never truncate `sessionId` or `workspaceRoot`** for budget — drop/shorten list payloads instead (identity keys are used for `--workspace` filtering). | Near-budget Cursor/Claude fixtures keep full `workspaceRoot`; pathological list-heavy transcripts still ≤ 4096 bytes when identity fields are normal length. |
| F1.0.3 | Host adapters live as pure modules under `packages/backend/src/bootstrap/` (e.g. Claude path + Cursor path) and share feedback lexicon / outcome helpers where mapping allows. | No LLM/HTTP imports; unit tests per adapter. |

### F1 — Claude adapter (`~/.claude/projects` JSONL → digest)

| Req ID | Requirement | Acceptance |
|---|---|---|
| F1.1 | Read a session `.jsonl` line-by-line; tolerate unknown `type` values and malformed lines. | Malformed line increments a skip counter; parse continues; never throws to caller. |
| F1.2 | Identify **real user turns** vs tool echoes **and host injections**. A real intent = `type:"user"` with string (or text-block) `message.content`, no `toolUseResult` key, `isSidechain` falsey, **and** not host-injected chrome (shared `isHostInjectedUserText`: Claude `<command-name>` / `<local-command-*>` / `<system-reminder>` / session-continue summaries; Cursor injected prefixes + `<mcp_meta_tools>`). | Given a session, `intents[]` excludes tool_result lines, sidechains, slash-command echoes, and hook/injection chrome. |
| F1.3 | Emit a `SessionDigest` (§7.1) per session. Extraction rules are fixed, not inferred: **commands** ← `Bash` tool_use `input.command`, normalized to the first significant token(s), deduped with counts; **tools** ← every assistant `tool_use.name` with counts; **skills** ← `Skill` tool_use `input.skill` **and** user-content slash invocations (`<command-name>` blocks / leading `/name`), deduped; **topFiles** ← `Edit`/`Write`/`Read` tool_use `input.file_path`, counted (edits = Edit+Write). | For a fixture session, each list matches the enumerated source fields exactly; nothing is invented from prose. |
| F1.4 | Digest is size-bounded (§9 NFR-2): cap list lengths (schema `maxItems`) and truncate long strings (`maxLength`) without breaking F1.0.2. | A pathological 700 KB transcript yields a serialized digest within the NFR-2 byte budget when identity fields are short. |
| F1.5 | `workspaceRoot` = `cwd` from the **first line** carrying one; `workspaceLabel` = `basename(workspaceRoot)`. **Do not decode the projects dir name** (Claude's encoding is unspecified). Carry `gitBranch` when present. | Digest `workspaceRoot` byte-equals the session's first-seen `cwd`; label is its basename. |
| F1.6 | Deterministic `outcome.signal`: `pr_opened` ← a `gh pr create` command appears; `committed` ← a `git commit` command appears; else `unknown`. No sentiment/abandonment inference. | Fixtures with/without those commands map to the correct signal; ambiguous → `unknown`. |

### F1C — Cursor adapter (`~/.cursor/projects/*/agent-transcripts` JSONL → digest)

Cursor JSONL is a **different consumed shape** (§7.0b). Same output digest; different extraction map.

| Req ID | Requirement | Acceptance |
|---|---|---|
| F1C.1 | Enumerate session files under `~/.cursor/projects/<projectSlug>/agent-transcripts/` supporting both layouts: `<sessionId>/<sessionId>.jsonl` and legacy flat `*.jsonl`. Env override for tests (e.g. `AGENT_DECK_CURSOR_PROJECTS_DIR`). | Fixtures for both layouts parse; missing tree → host contributes zero sessions (not a hard fail if another host has work). |
| F1C.2 | **Exclude** paths under `**/subagents/**` (Cursor subagent transcripts). | Subagent-only trees yield zero parent sessions; parent session still digests. |
| F1C.3 | Real user intent = Cursor `role:"user"` (or `message.role:"user"`) with text-only content that includes a `<user_query>…</user_query>` body (optional preceding `<timestamp>` line). **Unwrap** into the digest: strip `<timestamp>`, keep only the inner `user_query` text (shared helper in `extractUserText` — Claude plain strings unchanged). **Drop host injections** that arrive as `role:user` (e.g. “Briefly inform the user…”, subagent-result notices, `<mcp_meta_tools>` chrome). Ignore control lines (`type:"turn_ended"`). | Intents are clusterable plain text (no wrappers/timestamps); injected follow-ups never become intents or feedback moments. |
| F1C.4 | Extraction map (fixed): **commands** ← `Shell` tool_use `input.command` (same normalizeBashCommand rules as Claude `Bash`); **tools** ← every assistant `tool_use.name`; **skills** ← none required in v1 unless a clear Cursor equivalent appears in fixtures (leave empty rather than invent); **topFiles** ← `StrReplace`/`Write`/`Read` tool_use path fields (`input.path` or `input.file_path`), edits = StrReplace+Write. | Cursor fixture lists match these fields exactly. |
| F1C.5 | **Workspace identity (no speculative slug decode):** Cursor lines typically omit `cwd`. Set `workspaceLabel` = `<projectSlug>`; set `workspaceSlug` = `<projectSlug>` (same encode as `encodeCursorProjectSlug`). Set `workspaceRoot` = absolute `--workspace` when selected via slug match (Unix: strip leading `/`, replace `/` and `_` with `-`); else opaque slug. Claude digests set `workspaceSlug = encodeCursorProjectSlug(cwd)`. Manifest **groups by `workspaceSlug`** so Claude+Cursor for one repo are one workspace; prefer absolute `workspaceRoot` as the display root when any digest has it. Authoring match: `workspaceRoot === boundRoot` **or** `workspaceSlug === encodeCursorProjectSlug(boundRoot)`. Skip junk Cursor project dirs (`empty-window`, pure-numeric ids, blank names). | Bound-deck load attaches both hosts; `--workspace` attributes abs root; junk projects contribute 0. |
| F1C.6 | Outcome (F1.6) applies to normalized `Shell` commands the same way as Claude `Bash`. | Cursor fixture with `gh pr create` / `git commit` maps correctly. |

### F2 — Feedback-moment extraction

Shared across hosts once a host adapter exposes an ordered stream of (assistant tool-bearing action → user text reaction).

| Req ID | Requirement | Acceptance |
|---|---|---|
| F2.1 | Detect candidate feedback: a real user turn following an assistant `tool_use` / edit-like action **that also carries a qualifying signal** — ≥1 lexicon marker (F2.2) **or** a structural correction (the next assistant action re-edits a file touched just before). A bare "user turn after assistant action" does **not** qualify. Text-only assistant lines do **not** clear the preceding tool action. | Turns with no marker and no re-edit are excluded; pure Q&A → zero moments; Edit/StrReplace → prose → "don't…" still qualifies. |
| F2.2 | Classify a **polarity hint** via marker lexicon only (negative: "no/don't/actually/instead/wrong/revert/undo…"; positive: "perfect/works/great/ship it/lgtm…"); default `unknown`. | `markers[]` lists which words fired; hint never asserted beyond markers. |
| F2.3 | Attach `followupChange` = the next assistant action after the reaction, when present. | Moment with a subsequent correction carries a non-null `followupChange`. |
| F2.4 | Polarity is a **hint the agent overrides** — the parser never labels worked/didn't-work as fact. | Schema field named `polarityHint`, documented as advisory. |
| F2.5 | Ignore injected skill/tool bodies that look like user prose when classifying moments (e.g. skill markdown dumped into a user-visible line) — prefer short real user turns; if a "user" line is dominated by skill boilerplate, skip it as a moment. | Skill-injection fixtures do not create false Gotchas. |

### F3 — Bootstrap CLI (`agent-deck bootstrap`)

| Req ID | Requirement | Acceptance |
|---|---|---|
| F3.1 | Enumerate local session files for the selected host(s); default workspace scope = **all projects** under those hosts, `--workspace <path>` narrows (Claude via digest `cwd`; Cursor via slug encode match — F1C.5). | Default run lists every included project with ≥1 session. |
| F3.1b | `--host claude \| cursor \| all` selects input trees. Default `all`. Env overrides: `AGENT_DECK_CLAUDE_PROJECTS_DIR`, `AGENT_DECK_CURSOR_PROJECTS_DIR`. | Flag matrix covered by tests; absent host tree is skipped with a one-line count of 0 for that host. |
| F3.2 | Each run writes to a **fresh timestamped dir** under Agent Deck’s data home: `$AGENT_DECK_HOME/bootstrap/<ISO-timestamp>/` (default `~/.agent-deck/bootstrap/`; monorepo/dev → `~/.agent-deck/dev/bootstrap/`). Never overwrites prior runs; updates a stable `…/bootstrap/latest` pointer. `--out <dir>` overrides. Pointer is a **regular file** (not a symlink); replace any pre-existing symlink. Output is **host-agnostic** — do not nest under `~/.claude` or `~/.cursor`. | Two runs produce two dirs; `latest` resolves to the newest; `--out` is honored; Cursor-only machines never require `~/.claude`. |
| F3.3 | `--since <date>` / `--limit <n>` / `--workspace <path>` / `--host <…>` bound the run. **`--limit` keeps the N newest sessions by file `mtimeMs`** (descending), not alphabetical path order. | Flags reduce the processed set accordingly; with `--limit 1` the newest session wins even if its path sorts last. |
| F3.4 | Zero LLM/network calls. | Runs to completion with networking disabled. |
| F3.5 | **Committed handoff:** stdout ends with a fixed, copy-paste-ready block naming (a) the guide to load (`guideRef`), (b) the absolute manifest path, and (c) the instruction "load the guide, read the manifest, propose playbooks for the bound deck." This is the sole, committed handoff — not an open question. | Running the printed block verbatim in a bound agent session drives it to file proposals (smoke, M3). |
| F3.6 | Stdout summary includes per-host session counts (e.g. `claude=12 cursor=40`). | Counts match manifest breakdown. |

### F4 — Authoring guide (single source of truth)

The guide is half the product; it ships as **one artifact** with a committed input shape (opinionated over inference), referenced by the manifest's `guideRef`.

| Req ID | Requirement | Acceptance |
|---|---|---|
| F4.1 | Ship the guide as **one** artifact at a fixed id/path (`guideRef`, e.g. `pb_session_bootstrap_authoring`). Not mirrored into `.cursor/skills/`. Written into each run's output dir as `authoring-guide.md`. | `guideRef` in the manifest resolves to exactly one loadable artifact (absolute path to that file). |
| F4.2 | The guide commits an **input shape**, not topics: *"1. Read the manifest. 2. For the bound deck workspace, load digests where `workspaceRoot === boundRoot` **or** `workspaceSlug === encodeCursorProjectSlug(boundRoot)` (host-agnostic). 3. Cluster by task shape; host is a hint. 4. Draft playbook from recurring unwrapped `intents` + feedbackMoments. 5. File via `propose_playbook_patch`."* | Guide cites `workspaceSlug` match + unwrapped intents. |
| F4.3 | **Multi-workspace rule (decks are bind-scoped):** the guide directs the agent to propose into the **currently bound deck**, authoring from matching digests only; digests from other workspaces are held. Re-run after switching binds for other workspaces. | Guide states one-deck-per-bound-workspace; no proposal targets an unbound deck. |
| F4.4 | The guide directs all output through `propose_playbook_patch { kind:"create" }` — no `register_playbook`. | Following the guide files proposals, not registrations. |

## 5. Pricing model

**Not applicable.** This feature hosts, proxies, and bills nothing. The no-LLM-backend principle means **zero model spend** on Agent Deck's side; the only model cost is the user's own agent authoring proposals, billed to them as any Claude Code / Cursor turn is. Recorded here explicitly so the omission reads as a decision, not an oversight.

## 6. Design principles

- **Reduce before you reason.** The digest is the whole trick: a pure `transcript → digest` function collapses multi-hundred-KB transcripts to ~500 tokens so a full workspace fits one agent pass. (→ F1, NFR-2.)
- **One digest, many adapters.** Hosts differ at the consumed-line boundary; they must not fork the propose-first / authoring-guide contract. (→ F1.0, F1C.)
- **Semantics belong to the LLM; the backend stays dumb.** Clustering "same kind of task" and judging worked-vs-didn't are LLM jobs. The backend detects, extracts, and hints — never decides. (→ F2.4.)
- **Propose-first, always.** Consistent with the locked learning-loop decision: the human reviews every agent-authored playbook. (→ US-3.)

## 7. Cross-cutting contracts

JSON Schema (Draft 2020-12). These are the boundaries codegen must honor. Runtime source of truth in-repo may be Zod in `@agent-deck/shared` mirroring these shapes.

### 7.0 Claude session transcript line (input — consumed, not owned)

Agent Deck does not own this shape (Claude Code writes it); the parser reads a subset and must tolerate the rest. Fields consumed:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-deck/bootstrap/transcript-line.claude.consumed.json",
  "title": "ConsumedClaudeTranscriptLineFields",
  "type": "object",
  "properties": {
    "type": { "type": "string", "description": "user | assistant | system | last-prompt | attachment | … (unknown values ignored)" },
    "message": {
      "type": "object",
      "properties": {
        "role": { "type": "string", "enum": ["user", "assistant"] },
        "content": {
          "description": "string = typed user text; array = content blocks (text | tool_use | tool_result)",
          "oneOf": [{ "type": "string" }, { "type": "array" }]
        }
      }
    },
    "toolUseResult": { "description": "PRESENCE marks a tool-echo user line (not a real intent)" },
    "isSidechain": { "type": "boolean", "description": "true = subagent turn; excluded from intents/feedback" },
    "userType": { "type": "string" },
    "cwd": { "type": "string" },
    "gitBranch": { "type": "string" },
    "timestamp": { "type": "string", "format": "date-time" },
    "uuid": { "type": "string" },
    "parentUuid": { "type": ["string", "null"] }
  },
  "required": ["type"],
  "additionalProperties": true
}
```

**Claude real-intent predicate (F1.2):** `type == "user"` ∧ `content` is `string` (or all-text blocks) ∧ no `toolUseResult` key ∧ `isSidechain !== true`.

### 7.0b Cursor session transcript line (input — consumed, not owned)

Cursor Agent / Composer JSONL (lossy transcript layer). Not owned by Agent Deck. Fields consumed:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-deck/bootstrap/transcript-line.cursor.consumed.json",
  "title": "ConsumedCursorTranscriptLineFields",
  "type": "object",
  "properties": {
    "role": { "type": "string", "enum": ["user", "assistant"], "description": "primary role signal on many lines" },
    "type": { "type": "string", "description": "optional control: turn_ended | … (ignored for intents)" },
    "message": {
      "type": "object",
      "properties": {
        "role": { "type": "string", "enum": ["user", "assistant"] },
        "content": {
          "description": "string or array of blocks (text | tool_use | …)",
          "oneOf": [{ "type": "string" }, { "type": "array" }]
        }
      }
    },
    "status": { "type": "string" },
    "error": {}
  },
  "additionalProperties": true
}
```

**Cursor real-intent predicate (F1C.3):** (`role == "user"` ∨ `message.role == "user"`) ∧ text-only content ∧ contains `<user_query>…</user_query>` (optional `<timestamp>`) ∧ not a known host-injection prefix ∧ not a control-only line. Digest `intents[].text` / `feedbackMoments[].userReaction` store **unwrapped** inner text only.

**Cursor tool path fields:** prefer `input.path`, else `input.file_path`, for `Read` / `StrReplace` / `Write`.

### 7.1 SessionDigest (output)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-deck/bootstrap/session-digest.json",
  "title": "SessionDigest",
  "type": "object",
  "required": ["schemaVersion", "host", "sessionId", "workspaceRoot", "startedAt", "turnCount", "intents", "feedbackMoments", "outcome"],
  "additionalProperties": false,
  "properties": {
    "schemaVersion": { "const": 1 },
    "host": { "type": "string", "enum": ["claude", "cursor"], "description": "which local history tree produced this digest" },
    "sessionId": { "type": "string" },
    "workspaceRoot": { "type": "string", "description": "absolute path when known; may equal Cursor projectSlug when unscanned without --workspace" },
    "workspaceLabel": { "type": "string" },
    "workspaceSlug": { "type": "string", "description": "encodeCursorProjectSlug(abs cwd) or Cursor project dir; cross-host match key" },
    "gitBranch": { "type": ["string", "null"] },
    "startedAt": { "type": "string", "format": "date-time" },
    "endedAt": { "type": "string", "format": "date-time" },
    "durationMinutes": { "type": "number", "minimum": 0 },
    "turnCount": { "type": "integer", "minimum": 0 },
    "skippedLineCount": { "type": "integer", "minimum": 0 },
    "intents":  { "type": "array", "maxItems": 40, "items": { "type": "object", "required": ["text"], "properties": { "text": { "type": "string", "maxLength": 280 }, "at": { "type": "string", "format": "date-time" } } } },
    "commands": { "type": "array", "maxItems": 40, "items": { "type": "object", "required": ["command", "count"], "properties": { "command": { "type": "string", "maxLength": 160 }, "count": { "type": "integer", "minimum": 1 } } } },
    "tools":    { "type": "array", "maxItems": 40, "items": { "type": "object", "required": ["name", "count"], "properties": { "name": { "type": "string" }, "count": { "type": "integer", "minimum": 1 } } } },
    "skills":   { "type": "array", "maxItems": 40, "items": { "type": "object", "required": ["name", "count"], "properties": { "name": { "type": "string" }, "count": { "type": "integer", "minimum": 1 } } }, "description": "slash-command + Skill invocations — clean recurring-task signal (Claude); often empty on Cursor v1" },
    "topFiles": { "type": "array", "maxItems": 20, "items": { "type": "object", "required": ["path", "edits"], "properties": { "path": { "type": "string" }, "edits": { "type": "integer", "minimum": 1 } } } },
    "feedbackMoments": { "type": "array", "maxItems": 30, "items": { "$ref": "https://agent-deck/bootstrap/feedback-moment.json" } },
    "outcome": {
      "type": "object",
      "required": ["signal"],
      "properties": {
        "signal": { "type": "string", "enum": ["pr_opened", "committed", "unknown"], "description": "F1.6 deterministic rules only; no sentiment/abandonment inference" },
        "evidence": { "type": "string", "description": "the matched command, e.g. 'gh pr create'" }
      }
    }
  }
}
```

### 7.2 FeedbackMoment

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-deck/bootstrap/feedback-moment.json",
  "title": "FeedbackMoment",
  "type": "object",
  "required": ["agentAction", "userReaction", "polarityHint", "markers"],
  "additionalProperties": false,
  "properties": {
    "agentAction":    { "type": "string", "maxLength": 400, "description": "deterministic summary of the preceding assistant action (last tool_use/edit/text)" },
    "userReaction":   { "type": "string", "maxLength": 600, "description": "the user's reply turn, trimmed" },
    "polarityHint":   { "type": "string", "enum": ["negative", "positive", "mixed", "unknown"], "description": "ADVISORY — the agent overrides; parser never asserts worked/didn't-work" },
    "markers":        { "type": "array", "items": { "type": "string" }, "description": "which lexicon words fired" },
    "followupChange": { "type": ["string", "null"], "maxLength": 400, "description": "next assistant action after the reaction, if any" },
    "at":             { "type": "string", "format": "date-time" }
  }
}
```

### 7.3 BootstrapManifest (CLI output → agent handoff)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-deck/bootstrap/manifest.json",
  "title": "BootstrapManifest",
  "type": "object",
  "required": ["schemaVersion", "generatedAt", "digestDir", "guideRef", "totalSessions", "hosts", "workspaces"],
  "additionalProperties": false,
  "properties": {
    "schemaVersion": { "const": 1 },
    "generatedAt": { "type": "string", "format": "date-time" },
    "digestDir": { "type": "string" },
    "guideRef": { "type": "string", "description": "absolute path of the authoring guide the agent must load" },
    "totalSessions": { "type": "integer", "minimum": 0 },
    "hosts": {
      "type": "object",
      "required": ["claude", "cursor"],
      "additionalProperties": false,
      "properties": {
        "claude": { "type": "integer", "minimum": 0 },
        "cursor": { "type": "integer", "minimum": 0 }
      },
      "description": "per-host session counts included in this run"
    },
    "workspaces": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["workspaceRoot", "label", "sessionCount", "digestPaths"],
        "properties": {
          "workspaceRoot": { "type": "string" },
          "label": { "type": "string" },
          "sessionCount": { "type": "integer", "minimum": 0 },
          "digestPaths": { "type": "array", "items": { "type": "string" } }
        }
      }
    }
  }
}
```

### 7.4 Agent → queue (reused, not redefined)

Proposals use the **existing** `propose_playbook_patch` contract with `kind: "create"` and `new_playbook: { title, triggers, body }`. This feature adds **no** new write path. See `packages/backend/src/playbooks/patch-manager.ts`. (US-3, F4.2.)

### 7.5 Cursor project slug encode (match helper)

```
encodeCursorProjectSlug(absPath):
  # Unix v1 — mirrors how Cursor names ~/.cursor/projects/<slug>
  # Underscores in path segments become hyphens (observed Cursor naming).
  return absPath.replace(/^\//, "").replaceAll("/", "-").replaceAll("_", "-")
```

Used only for `--workspace` selection and authoring-guide match (F1C.5, F4.2). **Not** used to invent absolute paths from arbitrary slugs.

## 8. Technical constraints & preferences

- **Stack:** TypeScript, existing monorepo. Parsers live in `packages/backend/src/bootstrap/` as pure modules; CLI subcommand in `packages/cli`. No new runtime deps beyond what's present; **no** LLM/HTTP client added.
- **Input paths:** Claude `~/.claude/projects/` (`AGENT_DECK_CLAUDE_PROJECTS_DIR`); Cursor `~/.cursor/projects/` (`AGENT_DECK_CURSOR_PROJECTS_DIR`).
- **Contracts:** Zod in `@agent-deck/shared` mirroring §7 (repo convention); optional JSON Schema files may be generated but Zod is runtime SoT.
- **Codegen load path:** implementation agent loads this PRD + §7 schemas; repo-specific UI rules stay in project `.cursor/rules/`, never in playbooks.
- **No-LLM invariant:** CI/test asserts the bootstrap module imports no model/HTTP client (US-1, F3.4).
- **Privacy / data flow:** parsing is fully local, but digests carry **verbatim `userReaction` excerpts** and enter the user's agent context — so they leave the machine when the (cloud) agent authors proposals. Digest dir remains under `$AGENT_DECK_HOME/bootstrap/` (same Agent Deck home as DB/logs); no digest is transmitted by Agent Deck itself. State this in the CLI output.

## 9. Non-functional requirements

| NFR | Target | Measurement (window + sample) |
|---|---|---|
| NFR-1 Throughput | Parse ≥ 20 sessions/sec on a typical laptop | Median over a run of ≥ 50 real sessions (mixed hosts ok) |
| NFR-2 Digest budget | Serialized digest ≤ **4 KB** UTF-8 when identity fields are normal-length; never truncate `sessionId`/`workspaceRoot` | Assert `Buffer.byteLength(JSON.stringify(digest))` ≤ 4096 over ≥ 50 digests incl. one ≥ 500 KB transcript per host adapter |
| NFR-3 Robustness | 0 uncaught throws across a full local history sweep | One sweep of enabled host trees; malformed lines counted, not fatal |
| NFR-4 Determinism | Same input → byte-identical digest | Parse same session twice; diff empty |
| NFR-5 No-LLM | 0 model/network calls during bootstrap | Run with networking disabled over ≥ 10 sessions |

## 10. Out of scope

- **Ongoing per-session capture** (Stop hook / continuous harvester) — separate follow-on spec; this PRD is one-time backfill only.
- **Backend LLM anything** — clustering, summarization, polarity judgment all stay agent-side.
- **Deck service/key inference** — pre-Agent-Deck history contains no registered MCP services or keys; not mineable.
- **Embeddings / semantic clustering in the backend** — the marker lexicon + agent judgment is the v1 mechanism.
- **Cross-machine / cloud history** — local disk only.
- **Cursor `state.vscdb` / `~/.cursor/chats/*/store.db` as primary inputs** — richer, version-fragile; deferred until agent-transcript JSONL proves feedback quality. JSONL remains the v1 Cursor source.
- **Decoding Cursor project slugs into absolute paths** — unspecified / lossy when path segments contain `-`; use encode-for-match only (F1C.5).
- **Other hosts** (Codex, Windsurf, etc.) — out until a consumed-line contract is written the same way as §7.0 / §7.0b.

## 11. Milestones

- **M1 — Claude parser core.** `digestSession` (Claude) + §7.1/7.2 schemas + unit tests over Claude fixtures. Exit: NFR-2/3/4 on Claude fixtures. *(Shipped on `feat/session-history-bootstrap`.)*
- **M2 — CLI + manifest + handoff (CI), Claude host.** `agent-deck bootstrap` enumerates Claude history, writes digests + manifest + `latest`, prints handoff. Exit: US-1, F3.* (Claude), NFR-5. *(Shipped on branch; extend in M2b.)*
- **M2b — Cursor adapter + `--host`.** F1C.* + F1.0 `host` field + manifest `hosts` counts + Cursor fixtures (incl. subagent exclusion). Exit: US-1b; Cursor NFR-2/4 on fixtures; offline `--host cursor` and `--host all` runs.
- **M3 — Authoring guide + queue path (smoke).** Guide includes Cursor match rule (F4.2). Bound agent produces ≥3 `create` proposals with feedback-traceable lessons from Claude and/or Cursor digests. Exit: US-2/3/4 + agent smoke (§1). Human-run — checklist: [SMOKE.md](./SMOKE.md).

## 12. Open decisions

Committed (no longer open): digest location = `$AGENT_DECK_HOME/bootstrap/<timestamp>/` + `latest` pointer file (F3.2; corrected from the Claude-era `~/.claude/agent-deck/bootstrap/` mistake — output must not depend on any host’s config tree); agent handoff = printed block + `guideRef` (F3.5, F4); history scope default = all projects, `--workspace` narrows (F3.3); one bound deck per run (F4.3); Cursor v1 source = agent-transcript JSONL not SQLite; default `--host all`; never truncate `workspaceRoot`/`sessionId` for byte budget.

| Question | Default if undecided | Owner |
|---|---|---|
| Feedback marker lexicon contents | Ship a small English starter list; extend from observed misses | eng |
| Min sessions before bootstrap is worthwhile | Advisory warning under 5 sessions **across selected hosts**; still runs | eng |
| Cursor skill extraction | Leave `skills[]` empty in v1 unless a stable tool/name appears in fixtures | eng |
| Schema bump for required `host` | `schemaVersion` stays `1` if Claude digests are still unreleased; else bump and migrate — **default: stay 1 and treat missing `host` as `"claude"` only in read compat during M2b** | eng |

## 13. How to use this PRD

- **Engineers:** build F1→F4; add F1C / F3.1b in M2b. Treat §7 as the contract (Zod in shared). Enforce the no-LLM invariant in CI (§8). Implementation plan (Claude slice): [2026-07-22-session-history-bootstrap.md](../superpowers/plans/2026-07-22-session-history-bootstrap.md) — extend or add a sibling plan for M2b rather than silently diverging.
- **AI codegen agent:** load this PRD + §7. Claude and Cursor adapters are pure functions — TDD each against fixtures before wiring CLI flags. Do **not** add any model/HTTP dependency. Route all deck writes through `propose_playbook_patch`.
- **Reviewer:** proposals arrive in the existing dashboard queue; nothing auto-registers.

## Appendix — source notes

| Source | Captured as |
|---|---|
| Brainstorm 2026-07-22: forks A→A→A→C→A + feedback-moment insight | §1–§4, §6 |
| Brainstorm 2026-07-22: extend bootstrap to Cursor | US-1b, F1C, §7.0b, M2b, §10 deferrals |
| Memory `playbook-learning-loop-direction` (phase 3 "capture escalation") | §1, §10 |
| Real Claude `.jsonl` inspection (`~/.claude/projects/...agent-deck/`) | §7.0 |
| Real Cursor agent-transcript inspection (`~/.cursor/projects/.../agent-transcripts/`) | §7.0b, F1C tool map (Shell/StrReplace/Write/Read), subagents layout |
| `pb_ai_codegen_prd`, `pb_product_principle` | Section scaffold, voice, scope discipline |
| Smoke prep bug: byte-budget truncating `workspaceRoot` broke `--workspace` | F1.0.2 |
