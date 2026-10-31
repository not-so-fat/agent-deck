/**
 * NOT-540: the agent-facing delegation workflow is MCP-only.
 *
 * - The `agent-deck-run` skill drives briefs, starts, monitoring, review,
 *   resume, and cancel through `get_session_context`, optional `switch_deck`,
 *   `start_run`, `get_run`, and `cancel_run` only.
 * - A static scan fails on any shell / host-CLI / loopback fallback in the
 *   skill and in every generated delegation paragraph (and fails on the
 *   previous `agent-deck run` examples).
 * - Each failure category has a short stop/report path, never a CLI remedy.
 * - Setup/upgrade reconciliation installs the revised text for Claude, Codex,
 *   Cursor, and Muse without touching user bytes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildClaudeHarnessBlock,
  buildCodexHarnessBlock,
  buildCursorHarnessFile,
  buildMuseHarnessBlock,
  HARNESS_MARKER_END,
  HARNESS_MARKER_START,
  installAgentHarness,
} from './agent-harness';
import { MUSE_MANAGED_SKILL_MARKER, readMuseSkillTemplate } from './muse-skills';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const skillPath = path.join(repoRoot, 'skills', 'agent-deck-run', 'SKILL.md');
const readSkill = (): string => fs.readFileSync(skillPath, 'utf8');

/**
 * Forbidden delegation fallbacks: anything that asks the caller's sandbox to
 * execute the Agent Deck CLI, write a prompt file for it, reach the host
 * daemon over loopback, inspect host processes, or install a second copy.
 */
const FORBIDDEN_FALLBACKS: Array<[string, RegExp]> = [
  ['agent-deck CLI invocation', /`agent-deck\s+(run|status|use|deck|--version|mcp-launch|serve|start)\b/],
  ['agent-deck CLI in a shell block', /^\s*(?:\$\s*)?(?:cd\s+\S+\s*&&\s*)?agent-deck\s/m],
  ['host-CLI prompt file', /--prompt-file|prompt-file/],
  ['host-CLI flags', /--detach\b|--resume\b|--tools\s+(readonly|edit)/],
  ['curl', /\bcurl\b/],
  ['host loopback port', /\b(?:localhost|127\.0\.0\.1)(?::\d+)?|:111[01]\b|\b111[01]\b/],
  ['host process inspection', /\b(?:ps\s+aux|pgrep|lsof|kill\s+<pid>|kill\s+-\d)/],
  ['second Agent Deck install', /npm\s+(?:i|install)\b[^\n]*agent-deck|npx\s+agent-deck|brew\s+install[^\n]*agent-deck/],
  ['host run log path', /(?:,|\band)\s+log path|run\.jsonl|~\/\.agent-deck\/runs/],
];

function forbiddenFallbacks(text: string): string[] {
  return FORBIDDEN_FALLBACKS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function delegationParagraph(text: string): string {
  const start = text.indexOf('**Delegating to another session:**');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n\n', start);
  return text.slice(start, end === -1 ? undefined : end);
}

const harnessTexts = (): Array<[string, string]> => [
  ['cursor/global', buildCursorHarnessFile('global')],
  ['cursor/project', buildCursorHarnessFile('project')],
  ['claude/global', buildClaudeHarnessBlock('global')],
  ['claude/project', buildClaudeHarnessBlock('project')],
  ['codex/global', buildCodexHarnessBlock('global')],
  ['codex/project', buildCodexHarnessBlock('project')],
  ['muse/project', buildMuseHarnessBlock('project')],
  ['checked-in CLAUDE.md', fs.readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8')],
  ['checked-in .cursor/rules/agent-deck.mdc', fs.readFileSync(path.join(repoRoot, '.cursor', 'rules', 'agent-deck.mdc'), 'utf8')],
];

/** The pre-NOT-540 delegation text, kept verbatim to prove the scan catches it. */
const PREVIOUS_EXAMPLES = [
  'agent-deck run <deck> --client <client> --cwd <dir> --prompt-file <brief-file> --tools readonly --detach',
  'agent-deck run <deck> --client <client> --cwd <dir> --prompt-file <feedback-file> --tools readonly --resume <sessionId> --detach',
  '```sh\nagent-deck run status <runId>\nagent-deck run log <runId> --tail 50\n```',
  '```sh\nagent-deck --version      # >= 2.1.0\nagent-deck status         # Status: running\n```',
  '```sh\ncd <dir> && agent-deck use <deck> --client <client>\n```',
  '**Delegating to another session:** When the user asks to hand a task to another local session, delegate with `agent-deck run`.',
  'Choose `--tools readonly` unless the brief owner says `edit`, and never raise the profile on your own.',
  'Report the `runId`, `sessionId`, tool profile, and log path back to the human.',
  'curl http://127.0.0.1:1111/api/agent-runs',
  'npm install -g @not-so-fat/agent-deck',
  'ps aux | grep agent-deck',
];

describe('NOT-540 static no-CLI regression check', () => {
  it('fails on every previous agent-deck run example', () => {
    for (const example of PREVIOUS_EXAMPLES) {
      expect(forbiddenFallbacks(example), example).not.toEqual([]);
    }
  });

  it('finds no shell, host-CLI, loopback, process, or install fallback in the run skill', () => {
    expect(forbiddenFallbacks(readSkill())).toEqual([]);
  });

  it('finds no fallback in any generated or checked-in delegation paragraph', () => {
    for (const [label, text] of harnessTexts()) {
      expect(forbiddenFallbacks(delegationParagraph(text)), label).toEqual([]);
    }
  });

  it('setup guide delegation paragraph names MCP as the agent path and the host CLI as exceptional', () => {
    const setup = fs.readFileSync(path.join(repoRoot, 'docs', 'SETUP.md'), 'utf8');
    const start = setup.indexOf('**Delegating a task to another session:**');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = setup.indexOf('\n\n', start);
    const paragraph = setup.slice(start, end === -1 ? undefined : end);
    expect(forbiddenFallbacks(paragraph)).toEqual([]);
    for (const tool of ['get_session_context', 'switch_deck', 'start_run', 'get_run', 'cancel_run']) {
      expect(paragraph).toContain(`\`${tool}\``);
    }
    expect(paragraph).toContain('exceptional');
    expect(paragraph).toContain('on the Agent Deck host itself');
    // The pre-NOT-540 sentence presented the CLI as the delegation path.
    expect(forbiddenFallbacks('To delegate a task to a local session on a deck, `agent-deck run` launches a signed-in client')).not.toEqual([]);
    expect(setup).not.toMatch(/To delegate a task[^\n]*`agent-deck run`/);
  });

  it('finds no fallback in the Muse-managed copy of the run skill', () => {
    expect(forbiddenFallbacks(readMuseSkillTemplate('agent-deck-run'))).toEqual([]);
  });
});

describe('NOT-540 agent-deck-run skill contract', () => {
  it('uses exactly the five Agent Deck MCP tools for the whole loop', () => {
    const skill = readSkill();
    for (const tool of ['get_session_context', 'switch_deck', 'start_run', 'get_run', 'cancel_run']) {
      expect(skill).toContain(`\`${tool}`);
    }
    // Every backticked snake_case tool-like call is one of the run loop tools
    // or the corrections tool.
    const calls = new Set([...skill.matchAll(/`([a-z]+(?:_[a-z]+)+)\b/g)].map((match) => match[1]));
    const allowed = new Set([
      'get_session_context',
      'switch_deck',
      'start_run',
      'get_run',
      'cancel_run',
      'propose_playbook_patch',
      'get_playbook',
      'add_item',
      'signal_only',
      'user_feedback_excerpt',
    ]);
    expect([...calls].filter((name) => !allowed.has(name))).toEqual([]);
  });

  it('documents brief, start, monitor, review, resume, and cancel in order', () => {
    const skill = readSkill();
    const headings = ['## 0. Bootstrap', '## 1. Write the brief', '## 2. Start', '## 3. Monitor', '## 4. Review', '## 5. Resume or cancel'];
    const positions = headings.map((heading) => skill.indexOf(heading));
    expect(positions.every((position) => position >= 0), JSON.stringify(positions)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('builds the brief in memory and passes the explicit profile, resume id, finalization, and pin', () => {
    const skill = readSkill();
    expect(skill).toContain('in memory');
    expect(skill).toContain('no prompt file');
    expect(skill).toMatch(/"tools": "readonly"/);
    expect(skill).toContain('Always pass `tools` explicitly');
    expect(skill).toContain('`resumeSessionId`');
    expect(skill).toContain('`prepareFinalization: true`');
    expect(skill).toContain('`playbookVersion:');
    expect(skill).toContain('takes no deck and no cwd');
  });

  it('polls get_run with its event cursor on a ~30-second cadence to a terminal state', () => {
    const skill = readSkill();
    expect(skill).toContain('every 30 seconds');
    expect(skill).toContain('`nextCursor`');
    expect(skill).toContain('`after`');
    for (const state of ['ended', 'error', 'died', 'canceled']) {
      expect(skill).toContain(`\`${state}\``);
    }
  });

  it('keeps the three-round review limit and session-only switch default', () => {
    const skill = readSkill();
    expect(skill).toContain('at most 3 feedback rounds');
    expect(skill).toContain('after round 3, stop');
    expect(skill).toContain('This session only');
  });

  it('reports runId, sessionId, tool profile, and terminal state without a host log path', () => {
    const skill = readSkill();
    const report = skill.slice(skill.indexOf('## Report'), skill.indexOf('### Corrections'));
    for (const field of ['`runId`', '`sessionId`', 'tool profile', 'terminal state']) {
      expect(report).toContain(field);
    }
    expect(report).toContain('Do not report a host log path');
  });

  it('gives each failure category a short stop/report path, never a CLI remedy', () => {
    const skill = readSkill();
    const table = skill.slice(skill.indexOf('## Failures: stop and report'), skill.indexOf('## Report'));
    const rows = table.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Failure') && !line.startsWith('|---'));
    const byCategory = Object.fromEntries(
      rows.map((row) => {
        const [category, signal, next] = row.split('|').slice(1, 4).map((cell) => cell.trim());
        return [category, { signal, next }];
      }),
    );

    const expected: Record<string, string[]> = {
      'Agent Deck MCP missing': ['GRANT_REQUIRED'],
      'No launch workspace': ['WORKSPACE_REQUIRED'],
      'Provider unavailable': ['CLIENT_UNAVAILABLE'],
      'Deck switch not approved': ['DECK_FIXED', 'ADMIN_REQUIRED'],
      'Run failed': ['`error`', '`died`'],
      'Run canceled': ['`canceled`'],
    };
    for (const [category, signals] of Object.entries(expected)) {
      const row = byCategory[category];
      expect(row, category).toBeDefined();
      for (const signal of signals) {
        expect(row.signal, category).toContain(signal);
      }
      expect(row.next, category).toMatch(/^Report\b/);
      expect(row.next, category).toContain('Stop.');
      expect(row.next.length, `${category} next action stays short`).toBeLessThanOrEqual(200);
      expect(forbiddenFallbacks(row.next), category).toEqual([]);
      expect(row.next, category).not.toMatch(/agent-deck|install|setup|restart|\buse\b/i);
    }
    expect(table).toContain('Do not work around it from your own shell');
  });
});

describe('NOT-540 setup/upgrade reconciliation installs the MCP-only text', () => {
  const OLD_PARAGRAPH = [
    '**Delegating to another session:** When the user asks to hand a task to another local session, delegate with `agent-deck run`.',
    'Choose `--tools readonly` unless the brief owner says `edit`, and never raise the profile on your own.',
  ].join('\n');
  const staleBlock = `## Agent Deck\n\n${OLD_PARAGRAPH}`;
  const USER_BEFORE = '# My own notes\n\nKeep me.\n\n';
  const USER_AFTER = '\n\n## After\nAlso keep me.\n';

  let home: string;
  let codexHome: string;
  let xdg: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-not540-home-'));
    codexHome = path.join(home, '.codex');
    xdg = path.join(home, '.config');
    for (const key of ['CODEX_HOME', 'XDG_CONFIG_HOME']) {
      saved[key] = process.env[key];
    }
    process.env.CODEX_HOME = codexHome;
    process.env.XDG_CONFIG_HOME = xdg;
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeStale(filePath: string, prefix = USER_BEFORE): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${prefix}${HARNESS_MARKER_START}\n${staleBlock}\n${HARNESS_MARKER_END}${USER_AFTER}`, 'utf8');
  }

  function assertReconciled(label: string, content: string, prefix = USER_BEFORE): void {
    expect(content.startsWith(prefix), `${label} keeps user bytes before`).toBe(true);
    expect(content.endsWith(USER_AFTER), `${label} keeps user bytes after`).toBe(true);
    const paragraph = delegationParagraph(content);
    expect(paragraph, label).toContain('start_run');
    expect(paragraph, label).toContain('get_run');
    expect(paragraph, label).toContain('cancel_run');
    expect(forbiddenFallbacks(paragraph), label).toEqual([]);
    expect(content, label).not.toContain(OLD_PARAGRAPH);
  }

  it('Claude CLAUDE.md: replaces the stale delegation paragraph and keeps user notes', () => {
    const target = path.join(home, '.claude', 'CLAUDE.md');
    writeStale(target);
    const result = installAgentHarness('claude', 'global');
    expect(result).toMatchObject({ installed: true, action: 'updated', path: target });
    assertReconciled('claude', fs.readFileSync(target, 'utf8'));
    expect(installAgentHarness('claude', 'global').action).toBe('unchanged');
  });

  it('Codex AGENTS.md: replaces the stale delegation paragraph and keeps user notes', () => {
    const target = path.join(codexHome, 'AGENTS.md');
    writeStale(target);
    const result = installAgentHarness('codex', 'global');
    expect(result).toMatchObject({ installed: true, action: 'updated', path: target });
    assertReconciled('codex', fs.readFileSync(target, 'utf8'));
    expect(installAgentHarness('codex', 'global').action).toBe('unchanged');
  });

  it('Cursor agent-deck.mdc: replaces the stale delegation paragraph and keeps frontmatter and notes', () => {
    const target = path.join(home, '.cursor', 'rules', 'agent-deck.mdc');
    const frontmatter = '---\ndescription: custom\nalwaysApply: true\n---\n';
    writeStale(target, `${frontmatter}${USER_BEFORE}`);
    const result = installAgentHarness('cursor', 'global');
    expect(result).toMatchObject({ installed: true, action: 'updated', path: target });
    assertReconciled('cursor', fs.readFileSync(target, 'utf8'), `${frontmatter}${USER_BEFORE}`);
    expect(installAgentHarness('cursor', 'global').action).toBe('unchanged');
  });

  it('Muse skills: refreshes a stale managed agent-deck-run skill to the MCP-only body', () => {
    const skillsDir = path.join(xdg, 'muse', 'skills');
    const runSkill = path.join(skillsDir, 'agent-deck-run', 'SKILL.md');
    fs.mkdirSync(path.dirname(runSkill), { recursive: true });
    fs.writeFileSync(
      runSkill,
      `---\nname: agent-deck-run\n---\n\n${PREVIOUS_EXAMPLES[0]}\n\n${MUSE_MANAGED_SKILL_MARKER}\n`,
      'utf8',
    );
    const userSkill = path.join(skillsDir, 'my-skill', 'SKILL.md');
    fs.mkdirSync(path.dirname(userSkill), { recursive: true });
    fs.writeFileSync(userSkill, '# mine\n', 'utf8');

    const result = installAgentHarness('muse', 'global');
    expect(result.installed).toBe(true);
    const content = fs.readFileSync(runSkill, 'utf8');
    expect(content.startsWith(readSkill())).toBe(true);
    expect(content).toContain(MUSE_MANAGED_SKILL_MARKER);
    expect(content).toContain('start_run');
    expect(forbiddenFallbacks(content)).toEqual([]);
    expect(fs.readFileSync(userSkill, 'utf8')).toBe('# mine\n');
  });

  it('Muse project AGENTS.md: replaces the stale delegation paragraph and keeps user notes', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-not540-muse-project-'));
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    try {
      const target = path.join(cwd, 'AGENTS.md');
      writeStale(target);
      const result = installAgentHarness('muse', 'project');
      expect(result).toMatchObject({ installed: true, action: 'updated', path: target });
      assertReconciled('muse/project', fs.readFileSync(target, 'utf8'));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('Claude, Codex, and Cursor plugins ship the same skills/ folder', () => {
    for (const manifest of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json']) {
      const raw = fs.readFileSync(path.join(repoRoot, manifest), 'utf8');
      expect(raw, manifest).toMatch(/"skills":\s*(?:\[\s*)?"\.\/skills\/"/);
    }
  });
});
