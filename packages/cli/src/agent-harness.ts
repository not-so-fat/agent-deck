import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { McpClient, SetupScope } from './mcp-config';

export const HARNESS_MARKER_START = '<!-- agent-deck:harness:start -->';
export const HARNESS_MARKER_END = '<!-- agent-deck:harness:end -->';
export const CURSOR_RULE_FILENAME = 'agent-deck.mdc';

/** One-line rule description (Cursor rule picker / skill-style discoverability). */
export const HARNESS_RULE_DESCRIPTION =
  'Use when user mentions decks, playbooks, deck MCP tools, or corrects playbook output — Agent Deck harness';

const GLOBAL_BODY = `**Connect first:** Ensure Agent Deck MCP is connected before using deck tools (\`agent-deck setup --client cursor|claude --start\`, then restart the host). Claude Code: \`claude mcp list\` should show agent-deck as Connected when the backend is running.

**Session opener (first turn only):** When Agent Deck MCP is connected and this is a new conversation in a workspace, call \`get_session_binding\` then \`get_bound_deck\`, and tell the user **exactly one line** using \`display_summary\` (e.g. \`◆ dev · 2 MCP · 0 keys · 1 playbooks\`). Grant auth is automatic from \`agent-deck use\` — do **not** call \`get_decks\` or pick a deck. On \`GRANT_REQUIRED\`, tell the user to run \`agent-deck use <deck>\` and stop. Do **not** repeat the status line every turn unless the user asks or the bind changes.

**Later turns:** Deck scope comes from the workspace grant. Do not re-bind unless the user asks for deck administration.

Before declining for missing tools (Slack, Linear, GitHub, etc.), use agent-deck MCP: \`get_bound_deck\`, \`call_service_tool\`. Don't hardcode deck IDs.

**Deck admin (create/switch/edit deck):** Normal agents get \`ADMIN_REQUIRED\`. Call \`request_admin_elevation\`; user approves in the dashboard/menubar. After approval, \`mode\` is \`agent-admin\` until lease expiry or \`exit_admin_mode\`. Surface shared-deck workspace counts before mutating a deck used elsewhere.

Deck playbooks are task recipes — thin trigger stubs from \`agent-deck use\` plus \`get_bound_deck\` / \`get_playbook\`. **Never** mirror playbook bodies into \`.cursor/skills/\`, rules, or Claude skills — one source of truth on the deck; stubs are pointers only.

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
| Change trigger phrases | \`set_triggers\` | Then user runs \`agent-deck use <deck>\` to refresh stubs |

Wrong: \`amend_item\` with a prose sentence as anchor → **409** at propose. Right: \`rewrite_body\` for prose edits.`;

const PROJECT_BODY_EXTRA =
  'In this repo: run \`agent-deck use <deck>\` once (writes MCP + trigger stubs + \`.agent-deck/use.json\`). \`bind_workspace\` with the workspace root and that \`deckId\`. When a task matches a stub or deck \`triggers\`, \`get_playbook\` before improvising. After accepting playbook patches that change triggers, run \`agent-deck use --refresh\`.';

export function buildClaudeHarnessBlock(scope: SetupScope): string {
  const lines = ['## Agent Deck', '', GLOBAL_BODY];
  if (scope === 'project') {
    lines.push('', PROJECT_BODY_EXTRA);
  }
  return lines.join('\n');
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

  let nextBody: string;
  if (start !== -1 && end !== -1 && end > start) {
    const before = body.slice(0, start);
    const after = body.slice(end + HARNESS_MARKER_END.length);
    nextBody = `${before}${wrapped}${after}`;
  } else if (body.trim()) {
    nextBody = `${body.trimEnd()}\n\n${wrapped}\n`;
  } else {
    nextBody = `${wrapped}\n`;
  }

  const content = `${frontmatter}${nextBody}`.replace(/\n{3,}/g, '\n\n');
  const normalized = content.endsWith('\n') ? content : `${content}\n`;
  return { content: normalized, changed: normalized !== existing };
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

  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + HARNESS_MARKER_END.length);
    const content = `${before}${wrapped}${after}`.replace(/\n{3,}/g, '\n\n');
    return { content: content.endsWith('\n') ? content : `${content}\n`, changed: content !== existing };
  }

  const prefix = existing.trimEnd() ? `${existing.trimEnd()}\n\n` : '';
  const content = `${prefix}${wrapped}\n`;
  return { content, changed: true };
}

export function resolveHarnessPath(client: McpClient, scope: SetupScope): string | null {
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
  fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

export function installAgentHarness(client: McpClient, scope: SetupScope): HarnessInstallResult {
  const harnessPath = resolveHarnessPath(client, scope);
  if (!harnessPath) {
    return {
      installed: false,
      message:
        'Agent harness applies to Cursor and Claude Code. For Claude Desktop, add the same snippets from docs/AGENT_HARNESS.md to your Claude Code global CLAUDE.md if you use both.',
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

  const block = buildClaudeHarnessBlock(scope);
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
        : `Installed agent harness → ${harnessPath} (rest of CLAUDE.md untouched)`,
  };
}
