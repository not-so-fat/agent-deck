import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { McpClient, SetupScope } from './mcp-config';

export type HarnessClient = McpClient | 'codex';

export const HARNESS_MARKER_START = '<!-- agent-deck:harness:start -->';
export const HARNESS_MARKER_END = '<!-- agent-deck:harness:end -->';
export const CURSOR_RULE_FILENAME = 'agent-deck.mdc';

/** One-line rule description (Cursor rule picker / skill-style discoverability). */
export const HARNESS_RULE_DESCRIPTION =
  'Use when user mentions decks, playbooks, deck MCP tools, or corrects playbook output — Agent Deck harness';

const GLOBAL_BODY = `**Connect first:** Connection has three layers: host transport, folder assignment, then session bootstrap. Cursor / Claude users configure transport with \`agent-deck setup --client cursor|claude --start\`, then restart the host. Codex transport comes from the enabled Agent Deck plugin's bundled \`.mcp.json\`, which launches \`agent-deck mcp-launch\`; \`agent-deck setup --client codex\` installs or refreshes this AGENTS.md guidance but does not install the plugin. Run \`agent-deck use <deck>\` in an IDE folder when its assignment is missing or legacy, then reload or retry MCP. Claude Code: \`claude mcp list\` should show agent-deck as Connected when the backend is running.

**Agent Deck hard gate:** When Agent Deck MCP is configured for the current session, or \`.agent-deck/use.json\` indicates that it is expected, bootstrap is mandatory. This includes launch-selected sessions that deliberately have no assignment file. Before reading repo files, running task commands, or answering the task, require \`get_session_binding\` and \`get_bound_deck\` to succeed. If the tools are unavailable, disconnected, return \`GRANT_REQUIRED\`, or otherwise fail, stop and report the connection problem — do not improvise without the deck. Checking for the optional assignment signal, checking whether Agent Deck is configured, and other read-only connection diagnostics are allowed before the gate passes.

**Session opener (first turn only):** These calls verify an existing connection; they do not create it. The folder's deck comes from \`.agent-deck/use.json\`, which \`agent-deck use <deck>\` writes — the connection carries it; the agent does **not** pick a deck and must **not** call \`get_decks\`. When Agent Deck MCP is configured for the session, call \`get_session_binding\` then \`get_bound_deck\`, and tell the user **exactly one line** using \`display_summary\` (e.g. \`◆ dev · 2 MCP · 0 keys · 1 playbooks\`). Match the task against the returned playbook triggers and call \`get_playbook\` for every match before taking task action. If tools are unavailable, repair the host transport first. On \`GRANT_REQUIRED\` ("No deck selected for this connection"), tell the user to run \`agent-deck use <deck>\` in the folder and reload MCP, then stop. For an unattended session, fix \`x-agent-deck-deck-id\` / the launch config instead. If \`.agent-deck/use.json\` already assigns the deck and only the project MCP pin is missing, that \`use\` can succeed from a host agent sandbox; creating a new assignment needs an unsandboxed terminal (home store write). Do **not** repeat the status line every turn unless the user asks or the bind changes.

**Later turns:** Deck scope comes from the launch-selected connection (folder assignment or launch header). Do not re-bind unless the user asks for deck administration. Changing a folder's deck needs the user's dashboard approval (admin elevation) and only works where the folder has an assignment file; otherwise the agent gets \`DECK_FIXED\` or \`ADMIN_REQUIRED\` and should tell the user instead of retrying.

Before declining for missing tools (Slack, Linear, GitHub, etc.), use agent-deck MCP: \`get_bound_deck\`, \`call_service_tool\`. Don't hardcode deck IDs.

**Deck admin (create/switch/edit deck):** Normal agents get \`ADMIN_REQUIRED\`. Call \`request_admin_elevation\`; user approves in the dashboard/menubar. After approval, \`mode\` is \`agent-admin\` until lease expiry or \`exit_admin_mode\`. Surface shared-deck workspace counts before mutating a deck used elsewhere. Changing the folder assignment still requires that file to exist (\`DECK_FIXED\` when it does not).

**Playbooks — runtime discovery (no generated stubs):** Playbook triggers and bodies live only on the bound deck — \`agent-deck use\` and bind/switch write no per-playbook files, so switching decks never requires regenerating workspace files for discovery. On every task, match the task against the playbook \`triggers\` returned by \`get_bound_deck\` and call \`get_playbook\` for every match before acting. A playbook that exists only on the newly active deck is discovered the same way (\`get_bound_deck\` lists its triggers; \`get_playbook\` fetches its body) — never rely on checked-in stub or skill files, which may belong to a previously bound deck. **Never** mirror playbook bodies into \`.cursor/skills/\`, rules, or Claude skills — one source of truth on the deck.

### When user asks for a playbook task

1. \`get_playbook(pb_x)\` before improvising (\`get_bound_deck\` triggers point you here).
2. Follow the playbook body; use \`call_service_tool\` for deck MCPs.

### Playbooks — refine from outcomes (self-improvement)

**When the user corrects your output** (the write trigger — no need to have called \`get_playbook\` earlier in the session):

**Update case** (a playbook covered this task): fix the output, then \`get_playbook\` and read \`openPatches\`. If an open proposal addresses the **same** lesson, pass its \`id\`(s) in \`supersedes\` and fold into one better \`propose_playbook_patch\` (do not file a sibling). If open patches are different problems, omit \`supersedes\`. Prefer one \`add_item\` to Gotchas/Checklist; include \`evidence.user_feedback_excerpt\` as a short verbatim quote of the correction.

**Genesis case** (no playbook covered the task): before ending, \`propose_playbook_patch { kind: "create", new_playbook: { title, triggers, body with one gotcha } }\` — a few lines is the right size.

**Defer when unsure** (\`kind: "signal_only"\`): if the correction is plausible but not yet clearly generalizable (edge case, one-off, or needs sibling corrections before the lesson is clear), call \`propose_playbook_patch { kind: "signal_only", evidence, rationale }\` — logs the signal with no patch proposal. Prefer immediate \`update\`/\`create\` when the lesson is clear.

**Curate from a pasted dashboard prompt:** when the user pastes a curation prompt from the Feedback table (\`/feedback-signals\` → Copy for agent; Markdown + YAML list, each row leads with \`id\`), group the signals, then \`propose_playbook_patch\` with consolidated ops and \`signal_ids\` of every consumed id. That links rows (still open) until the patch is accepted. Do not invent a list-feedback MCP tool — browse/discard is dashboard-only.

**Explicit user-directed playbook edits** ("fix the playbook to say X"): direct \`update_playbook\` is dashboard-only — use \`propose_playbook_patch\` with \`rewrite_body\` unless they will apply the edit in the dashboard themselves.

Tell the user in one line that a proposal was filed (or a signal was logged for later dashboard curation); review happens in the dashboard.

**How to shape proposals:** generalize project-specific names but keep concrete gotchas; place lessons in Checklist/Gotchas; use \`rewrite_body\` only when structure cannot absorb the lesson.

**propose_playbook_patch ops:**

| Situation | Op | Notes |
|-----------|-----|-------|
| New gotcha or checklist item | \`add_item\` | \`section\`: ## heading; \`text\`: bullet (leading \`-\` optional) |
| Replace one list line | \`amend_item\` | \`anchor\`: exact line including \`-\` prefix — **not prose** |
| Delete one list line | \`remove_item\` | Same anchor rules as amend |
| Edit prose or a whole section | \`rewrite_body\` | Not amend_item on paragraphs |
| Change trigger phrases | \`set_triggers\` | Effective on the next \`get_bound_deck\` call — no workspace refresh step |

Wrong: \`amend_item\` with a prose sentence as anchor → **409** at propose. Right: \`rewrite_body\` for prose edits.`;

const PROJECT_BODY_EXTRA =
  'In this repo: \`agent-deck use <deck>\` is the optional persistent folder-assignment path (writes MCP config + \`.agent-deck/use.json\`); launch-selected sessions can be bound without that file. When a task matches deck \`triggers\` from \`get_bound_deck\`, \`get_playbook\` before improvising — no stub refresh step; trigger changes take effect on the next \`get_bound_deck\` call.';

export function buildClaudeHarnessBlock(scope: SetupScope): string {
  const lines = ['## Agent Deck', '', GLOBAL_BODY];
  if (scope === 'project') {
    lines.push('', PROJECT_BODY_EXTRA);
  }
  return lines.join('\n');
}

/** Codex uses the same protocol guidance, merged into AGENTS.md. */
export function buildCodexHarnessBlock(scope: SetupScope): string {
  return buildClaudeHarnessBlock(scope);
}

function buildCursorHarnessInner(scope: SetupScope): string {
  const body =
    scope === 'project' ? `${GLOBAL_BODY}\n\n${PROJECT_BODY_EXTRA}` : GLOBAL_BODY;
  return `# Agent Deck\n\n${body}`;
}

const CURSOR_FRONTMATTER_REGEX = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Merge only the agent-deck section; never replace other Cursor rules or skills. */
export function mergeCursorHarnessFile(
  existing: string,
  harnessInner: string,
  description: string = HARNESS_RULE_DESCRIPTION,
): { content: string; changed: boolean } {
  const wrapped = `${HARNESS_MARKER_START}\n${harnessInner}\n${HARNESS_MARKER_END}`;
  const frontmatterMatch = existing.match(CURSOR_FRONTMATTER_REGEX);
  const frontmatter = frontmatterMatch?.[0] ?? `---\ndescription: ${description}\nalwaysApply: true\n---\n\n`;
  const body = frontmatterMatch ? existing.slice(frontmatter.length) : existing;

  const start = body.indexOf(HARNESS_MARKER_START);
  const end = body.indexOf(HARNESS_MARKER_END);

  // Splice only the managed range: user bytes before/after the markers are
  // preserved byte-for-byte (no newline collapsing, no trimming). Newline
  // separation is added, never taken from existing content.
  let nextBody: string;
  if (start !== -1 && end !== -1 && end > start) {
    const before = body.slice(0, start);
    const after = body.slice(end + HARNESS_MARKER_END.length);
    nextBody = `${before}${wrapped}${after}`;
  } else if (body) {
    const separator = body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n';
    nextBody = `${body}${separator}${wrapped}\n`;
  } else {
    nextBody = `${wrapped}\n`;
  }

  const content = `${frontmatter}${nextBody}`;
  return { content, changed: content !== existing };
}

export function buildCursorHarnessFile(scope: SetupScope): string {
  return mergeCursorHarnessFile('', buildCursorHarnessInner(scope)).content;
}

export function mergeClaudeHarness(
  existing: string,
  harnessBlock: string,
): { content: string; changed: boolean } {
  const wrapped = `${HARNESS_MARKER_START}\n${harnessBlock}\n${HARNESS_MARKER_END}`;
  const start = existing.indexOf(HARNESS_MARKER_START);
  const end = existing.indexOf(HARNESS_MARKER_END);

  // Splice only the managed range: user bytes before/after the markers are
  // preserved byte-for-byte (no newline collapsing, no trimming). Newline
  // separation is added, never taken from existing content.
  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + HARNESS_MARKER_END.length);
    const content = `${before}${wrapped}${after}`;
    return { content, changed: content !== existing };
  }

  if (!existing) {
    return { content: `${wrapped}\n`, changed: true };
  }
  const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return { content: `${existing}${separator}${wrapped}\n`, changed: true };
}

export function resolveHarnessPath(client: HarnessClient, scope: SetupScope): string | null {
  const home = os.homedir();
  const cwd = process.cwd();

  if (client === 'cursor') {
    const rulesDir =
      scope === 'project' ? path.join(cwd, '.cursor', 'rules') : path.join(home, '.cursor', 'rules');
    return path.join(rulesDir, CURSOR_RULE_FILENAME);
  }

  if (client === 'claude') {
    return scope === 'project' ? path.join(cwd, 'CLAUDE.md') : path.join(home, '.claude', 'CLAUDE.md');
  }

  if (client === 'codex') {
    const codexHome = process.env.CODEX_HOME?.trim() || path.join(home, '.codex');
    return scope === 'project' ? path.join(cwd, 'AGENTS.md') : path.join(codexHome, 'AGENTS.md');
  }

  return null;
}

export type HarnessInstallResult = {
  installed: boolean;
  path?: string;
  action?: 'created' | 'updated' | 'unchanged';
  message: string;
};

function readTextFile(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  return fs.readFileSync(filePath, 'utf8');
}

function writeTextFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Write merged content verbatim: the merge functions already append a
  // trailing newline when they add the block, and user bytes after the end
  // marker must be preserved byte-for-byte (even without a final newline).
  fs.writeFileSync(filePath, content, 'utf8');
}

export function installAgentHarness(client: HarnessClient, scope: SetupScope): HarnessInstallResult {
  const harnessPath = resolveHarnessPath(client, scope);
  if (!harnessPath) {
    return {
      installed: false,
      message:
        'Agent harness applies to Cursor, Claude Code, and Codex. For Claude Desktop, add the same snippets from docs/AGENT_HARNESS.md to your Claude Code global CLAUDE.md if you use both.',
    };
  }

  if (client === 'cursor') {
    const existing = readTextFile(harnessPath);
    const { content, changed } = mergeCursorHarnessFile(existing, buildCursorHarnessInner(scope));
    const action = !existing.trim() ? 'created' : changed ? 'updated' : 'unchanged';
    if (action !== 'unchanged') {
      writeTextFile(harnessPath, content);
    }
    return {
      installed: true,
      path: harnessPath,
      action,
      message:
        action === 'unchanged'
          ? `Agent harness already current → ${harnessPath}`
          : `Installed agent harness → ${harnessPath} (other rules/skills untouched)`,
    };
  }

  const block = client === 'codex' ? buildCodexHarnessBlock(scope) : buildClaudeHarnessBlock(scope);
  const existing = readTextFile(harnessPath);
  const { content, changed } = mergeClaudeHarness(existing, block);
  const action = !existing.trim() ? 'created' : changed ? 'updated' : 'unchanged';
  if (action !== 'unchanged') {
    writeTextFile(harnessPath, content);
  }

  return {
    installed: true,
    path: harnessPath,
    action,
    message:
      action === 'unchanged'
        ? `Agent harness already current → ${harnessPath}`
        : `Installed agent harness → ${harnessPath} (rest of ${client === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'} untouched)`,
  };
}
