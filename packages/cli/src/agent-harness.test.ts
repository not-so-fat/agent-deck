import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildClaudeHarnessBlock,
  buildCodexHarnessBlock,
  buildCursorHarnessFile,
  buildCursorHarnessInner,
  CURSOR_RULE_FILENAME,
  diagnoseAllHarnesses,
  diagnoseHarness,
  formatHarnessDiagnosis,
  HARNESS_MARKER_END,
  HARNESS_MARKER_START,
  HARNESS_RULE_DESCRIPTION,
  installAgentHarness,
  mergeClaudeHarness,
  mergeCursorHarnessFile,
  resolveHarnessPath,
} from './agent-harness';

describe('agent-harness templates', () => {
  it('keeps cursor description concise (skill-style)', () => {
    expect(HARNESS_RULE_DESCRIPTION.length).toBeLessThan(140);
    expect(CURSOR_RULE_FILENAME).toBe('agent-deck.mdc');
    expect(HARNESS_RULE_DESCRIPTION).toContain('Use when');
  });

  it('global cursor file includes self-improvement playbook rules', () => {
    const file = buildCursorHarnessFile('global');
    expect(file).toContain('get_bound_deck');
    expect(file).toContain('propose_playbook_patch');
    expect(file).toContain('update_playbook');
    expect(file).toContain('get_playbook');
    expect(file).toContain('display_summary');
    expect(file).toContain('Session opener');
    expect(file).toContain('get_session_binding');
    expect(file).toContain('Agent Deck hard gate');
    expect(file).toContain('configured for the current session');
    expect(file).toContain('indicates that it is expected');
    expect(file).toContain('launch-selected sessions that deliberately have no assignment file');
    expect(file).toContain('Before reading repo files');
    expect(file).toContain('Checking for the optional assignment signal');
    expect(file).toContain('do not improvise without the deck');
    expect(file).toContain('for every match before taking task action');
    expect(file).toContain('host transport, folder assignment, then session bootstrap');
    expect(file).toContain('agent-deck mcp-launch');
    expect(file).toContain('agent-deck setup --client codex');
    expect(file).toContain('does not install the plugin');
    expect(file).toContain('This call verifies an existing connection; it does not create it');
    expect(file).toContain('Genesis case');
    expect(file).toContain('signal_only');
    expect(file).toContain('signal_ids');
    expect(file).toContain('Copy for agent');
    expect(file).not.toContain('list_feedback_signals');
    expect(file).toContain('evidence.user_feedback_excerpt');
    expect(file).toContain('add_item');
    expect(file).toContain('rewrite_body');
    expect(file).toContain('409');
    expect(file).not.toContain('weekly priority');
  });

  it('harness teaches the request-only switch flow, not the retired direct switch (NOT-214)', () => {
    const texts = [
      buildCursorHarnessFile('global'),
      buildClaudeHarnessBlock('global'),
      buildCodexHarnessBlock('global'),
    ];
    for (const text of texts) {
      expect(text).toContain('switch_deck');
      expect(text).toContain('This session only');
      expect(text).toContain('This workspace by default');
      expect(text).not.toContain('switch_bound_deck');
      expect(text).not.toContain('admin elevation) and only works where the folder has an assignment file');
    }
  });

  it('harness never names removed MCP tools (1.3.0 catalog)', () => {
    const cursor = buildCursorHarnessFile('project');
    const claude = buildClaudeHarnessBlock('project');
    for (const text of [cursor, claude]) {
      expect(text).toContain('get_bound_deck');
      expect(text).toContain('call_service_tool');
      expect(text).not.toContain('list_playbooks');
      expect(text).not.toContain('list_bound_deck_services');
      expect(text).not.toContain('list_bound_deck_credentials');
      expect(text).not.toContain('add_service_to_bound_deck');
      expect(text).not.toContain('add_playbook_to_bound_deck');
      expect(text).not.toContain('delete_service');
      expect(text).not.toContain('delete_playbook');
      expect(text).not.toContain('setup_repo_deck');
    }
  });

  it('project harness adds optional assignment guidance with a branched GRANT_REQUIRED retry (NOT-234)', () => {
    const cursor = buildCursorHarnessFile('project');
    const claude = buildClaudeHarnessBlock('project');
    for (const text of [cursor, claude]) {
      expect(text).toContain('agent-deck use');
      expect(text).toContain('optional persistent folder-assignment');
      expect(text).toContain('launch-selected sessions can be bound without that file');
      expect(text).toContain('DECK_FIXED');
      expect(text).toContain('ADMIN_REQUIRED');
      expect(text).toContain('.agent-deck/use.json');
      // NOT-234: the opener branches on which GRANT_REQUIRED message came
      // back — the not-yet-bound retry names bind_workspace, while the
      // unassigned-folder remedy keeps the `agent-deck use` CLI step.
      expect(text).toContain('match the message before acting');
      expect(text).toContain('bind_workspace');
    }
  });

  it('NOT-234: GRANT_REQUIRED guidance names both messages with differing remedies', () => {
    const texts = [
      buildCursorHarnessFile('global'),
      buildCursorHarnessFile('project'),
      buildClaudeHarnessBlock('global'),
      buildClaudeHarnessBlock('project'),
      buildCodexHarnessBlock('global'),
    ];
    for (const text of texts) {
      expect(text).toContain('GRANT_REQUIRED');
      // Unassigned folder keeps the CLI-and-reload remedy, then stop.
      expect(text).toContain('No deck assigned to this folder');
      expect(text).toContain('agent-deck use <deck>');
      // Not-yet-bound session retries once via bind, with no CLI step.
      expect(text).toContain('has not bound yet');
      expect(text).toContain('get_session_binding');
      expect(text).toContain('then retry `switch_deck`');
      expect(text).toContain('no CLI step');
      expect(text).toContain('stop only if that retry also fails');
    }
  });

  it('harness text has no grant wording except the GRANT_REQUIRED error code', () => {
    const texts = [
      buildCursorHarnessFile('global'),
      buildCursorHarnessFile('project'),
      buildClaudeHarnessBlock('global'),
      buildClaudeHarnessBlock('project'),
      buildCodexHarnessBlock('global'),
    ];
    for (const text of texts) {
      expect(text).toContain('GRANT_REQUIRED');
      const withoutCode = text.replaceAll('GRANT_REQUIRED', '');
      expect(withoutCode.toLowerCase()).not.toMatch(/grant/);
    }
  });

  it('re-setup replaces an older grant-model harness block between markers', () => {
    const stale = [
      HARNESS_MARKER_START,
      '## Agent Deck',
      '',
      'Grant auth is automatic… do **not** call `get_decks`.',
      'Deck scope comes from the workspace grant.',
      HARNESS_MARKER_END,
    ].join('\n');
    const { content, changed } = mergeClaudeHarness(stale, buildClaudeHarnessBlock('global'));
    expect(changed).toBe(true);
    expect(content).not.toContain('Grant auth is automatic');
    expect(content).not.toContain('workspace grant');
    expect(content).toContain('display_summary');
    expect(content).toContain('.agent-deck/use.json');
    expect(content).toContain(HARNESS_MARKER_START);
  });

  it('claude block carries the same fail-closed bootstrap contract', () => {
    const block = buildClaudeHarnessBlock('global');
    expect(block).toContain('Agent Deck hard gate');
    expect(block).toContain('get_session_binding');
    expect(block).toContain('get_bound_deck');
    expect(block).toContain('Checking for the optional assignment signal');
    expect(block).toContain('do not improvise without the deck');
    expect(block).toContain('agent-deck mcp-launch');
    expect(block).toContain('agent-deck setup --client codex');
    expect(block).toContain('does not install the plugin');
  });

  it('codex block carries the same contract for AGENTS.md', () => {
    const block = buildCodexHarnessBlock('global');
    expect(block).toContain('## Agent Deck');
    expect(block).toContain('get_session_binding');
    expect(block).toContain('agent-deck setup --client codex');
    expect(block).toContain('does not install the plugin');
  });

  it('resolves Codex global guidance through CODEX_HOME', () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/tmp/agent-deck-codex-home';
    try {
      expect(resolveHarnessPath('codex', 'global')).toBe('/tmp/agent-deck-codex-home/AGENTS.md');
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });

  it('claude block avoids project-specific examples', () => {
    const block = buildClaudeHarnessBlock('global');
    expect(block).toContain('## Agent Deck');
    expect(block).not.toContain('DocMost');
    expect(block).not.toContain('slip-risk');
  });

  it('keeps this repo dogfooding the exact generated project harness', () => {
    const file = fs.readFileSync(new URL('../../../CLAUDE.md', import.meta.url), 'utf8');
    const start = file.indexOf(HARNESS_MARKER_START);
    const end = file.indexOf(HARNESS_MARKER_END);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const checkedInBlock = file.slice(start + HARNESS_MARKER_START.length, end).trim();
    expect(checkedInBlock).toBe(buildClaudeHarnessBlock('project'));
  });

  it('keeps the checked-in cursor rule on the generated project harness (NOT-214)', () => {
    const file = fs.readFileSync(
      new URL('../../../.cursor/rules/agent-deck.mdc', import.meta.url),
      'utf8',
    );
    const start = file.indexOf(HARNESS_MARKER_START);
    const end = file.indexOf(HARNESS_MARKER_END);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const checkedInInner = file.slice(start + HARNESS_MARKER_START.length, end).trim();
    const generated = buildCursorHarnessFile('project');
    const generatedInner = generated
      .slice(
        generated.indexOf(HARNESS_MARKER_START) + HARNESS_MARKER_START.length,
        generated.indexOf(HARNESS_MARKER_END),
      )
      .trim();
    expect(checkedInInner).toBe(generatedInner);
  });
});

describe('mergeClaudeHarness', () => {
  it('appends harness block when missing', () => {
    const { content, changed } = mergeClaudeHarness('# My notes\n', buildClaudeHarnessBlock('global'));
    expect(changed).toBe(true);
    expect(content).toContain('<!-- agent-deck:harness:start -->');
    expect(content).toContain('## Agent Deck');
    expect(content).toContain('# My notes');
  });

  it('preserves content before and after harness markers', () => {
    const existing = [
      '# Team conventions',
      '',
      HARNESS_MARKER_START,
      'old harness',
      HARNESS_MARKER_END,
      '',
      '# More notes',
    ].join('\n');
    const { content } = mergeClaudeHarness(existing, buildClaudeHarnessBlock('global'));
    expect(content).toContain('# Team conventions');
    expect(content).toContain('# More notes');
    expect(content).toContain('## Agent Deck');
    expect(content).not.toContain('old harness');
  });

  it('replaces existing harness block idempotently', () => {
    const first = mergeClaudeHarness('', buildClaudeHarnessBlock('global'));
    const second = mergeClaudeHarness(first.content, buildClaudeHarnessBlock('global'));
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it('updates when harness body changes', () => {
    const initial = mergeClaudeHarness('', buildClaudeHarnessBlock('global'));
    const updated = mergeClaudeHarness(initial.content, `${buildClaudeHarnessBlock('global')}\n\nExtra.`);
    expect(updated.changed).toBe(true);
    expect(updated.content).toContain('Extra.');
  });
});

describe('mergeCursorHarnessFile', () => {
  it('preserves custom frontmatter and trailing notes in agent-deck.mdc', () => {
    const existing = `---
description: My custom description
alwaysApply: true
---

# My preamble

${HARNESS_MARKER_START}
old
${HARNESS_MARKER_END}

# Keep this footer
`;
    const { content } = mergeCursorHarnessFile(existing, '# Agent Deck\n\nnew body');
    expect(content).toContain('description: My custom description');
    expect(content).toContain('# My preamble');
    expect(content).toContain('# Keep this footer');
    expect(content).toContain('new body');
    expect(content).not.toContain('old');
  });

  it('appends harness when agent-deck.mdc has content but no markers', () => {
    const existing = `---
description: Custom
alwaysApply: false
---

# Existing rule intro
`;
    const { content, changed } = mergeCursorHarnessFile(existing, '# Agent Deck\n\nbody');
    expect(changed).toBe(true);
    expect(content).toContain('# Existing rule intro');
    expect(content).toContain(HARNESS_MARKER_START);
  });

  it('only touches agent-deck.mdc filename (not other rules)', () => {
    expect(CURSOR_RULE_FILENAME).toBe('agent-deck.mdc');
    expect(buildCursorHarnessFile('global')).toContain(HARNESS_MARKER_START);
  });
});

describe('NOT-189 one-call session context bootstrap', () => {
  const texts = () => [
    buildClaudeHarnessBlock('global'),
    buildClaudeHarnessBlock('project'),
    buildCodexHarnessBlock('global'),
    buildCursorHarnessFile('global'),
    buildCursorHarnessFile('project'),
  ];

  it('opener calls get_session_context once and prints display_summary', () => {
    for (const text of texts()) {
      expect(text).toContain('get_session_context');
      expect(text).toContain('call `get_session_context` once');
      expect(text).toContain('display_summary');
      expect(text).toContain('call `get_playbook` for every match');
    }
  });

  it('hard gate requires the one-call bootstrap', () => {
    for (const text of texts()) {
      expect(text).toContain('require `get_session_context` to succeed');
    }
  });

  it('does not instruct a first-turn get_session_binding → get_bound_deck sequence', () => {
    for (const text of texts()) {
      expect(text).not.toContain('call `get_session_binding` then `get_bound_deck`');
      expect(text).not.toContain('require `get_session_binding` and `get_bound_deck`');
    }
  });

  it('keeps the retired tools named only as compatibility, never as the opener', () => {
    for (const text of texts()) {
      expect(text).toContain('the opener needs only `get_session_context`');
    }
  });
});

describe('NOT-206 static runtime discovery', () => {
  const texts = () => [
    buildClaudeHarnessBlock('global'),
    buildClaudeHarnessBlock('project'),
    buildCodexHarnessBlock('global'),
    buildCursorHarnessFile('global'),
    buildCursorHarnessFile('project'),
  ];

  it('directs deck-B-only playbooks through get_bound_deck + get_playbook', () => {
    for (const text of texts()) {
      expect(text).toContain('get_bound_deck');
      expect(text).toContain('get_playbook');
      expect(text).toContain('exists only on the newly active deck');
    }
  });

  it('needs no regenerated files when the deck switches', () => {
    for (const text of texts()) {
      expect(text).toContain('never requires regenerating workspace files');
    }
  });

  it('names no stub generation or refresh step', () => {
    for (const text of texts()) {
      expect(text).not.toContain('trigger stubs');
      expect(text).not.toContain('refresh stubs');
      expect(text).not.toContain('use --refresh');
    }
  });
});

describe('managed-block refresh preserves user content byte-for-byte', () => {
  it('keeps triple newlines around claude markers and adds no trailing newline', () => {
    const before = '# Team conventions\n\n\n';
    const after = '\n\n\n# More notes';
    const existing = `${before}${HARNESS_MARKER_START}\nold harness\n${HARNESS_MARKER_END}${after}`;
    const { content, changed } = mergeClaudeHarness(existing, buildClaudeHarnessBlock('global'));

    expect(changed).toBe(true);
    expect(content.slice(0, content.indexOf(HARNESS_MARKER_START))).toBe(before);
    const endSlice = content.slice(
      content.indexOf(HARNESS_MARKER_END) + HARNESS_MARKER_END.length,
    );
    expect(endSlice).toBe(after);
    expect(content).not.toContain('old harness');
    expect(content).toContain('## Agent Deck');
  });

  it('keeps triple newlines around cursor markers with custom frontmatter', () => {
    const existing = `---
description: My custom description
alwaysApply: true
---

# My preamble


${HARNESS_MARKER_START}
old
${HARNESS_MARKER_END}


# Keep this footer`;
    const { content } = mergeCursorHarnessFile(existing, '# Agent Deck\n\nnew body');

    expect(content).toContain('description: My custom description');
    expect(content).toContain('# My preamble\n\n\n');
    expect(content).toContain('\n\n\n# Keep this footer');
    expect(content).toContain('new body');
    expect(content).not.toContain('\nold\n');
  });

  it('appends without trimming existing trailing whitespace', () => {
    const existing = '# My notes\n\n\n';
    const { content } = mergeClaudeHarness(existing, buildClaudeHarnessBlock('global'));
    expect(content.startsWith(existing)).toBe(true);
    expect(content).toContain(HARNESS_MARKER_START);
  });
});

describe('installAgentHarness on-disk byte preservation', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function useTmpCwd(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-harness-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    return tmpDir;
  }

  it('claude refresh preserves no-trailing-newline user text verbatim', () => {
    const cwd = useTmpCwd();
    const target = resolveHarnessPath('claude', 'project');
    expect(target).toBe(path.join(cwd, 'CLAUDE.md'));
    const after = '\n\n\n# More notes';
    fs.writeFileSync(
      target as string,
      `# Team conventions\n\n${HARNESS_MARKER_START}\nold harness\n${HARNESS_MARKER_END}${after}`,
      'utf8',
    );
    const result = installAgentHarness('claude', 'project');
    expect(result.action).toBe('updated');
    const written = fs.readFileSync(target as string, 'utf8');
    const endSlice = written.slice(
      written.indexOf(HARNESS_MARKER_END) + HARNESS_MARKER_END.length,
    );
    expect(endSlice).toBe(after);
    expect(written.endsWith('\n')).toBe(false);
    const repeat = installAgentHarness('claude', 'project');
    expect(repeat.action).toBe('unchanged');
    expect(fs.readFileSync(target as string, 'utf8')).toBe(written);
  });

  it('codex refresh preserves no-trailing-newline user text verbatim', () => {
    const cwd = useTmpCwd();
    const target = resolveHarnessPath('codex', 'project');
    expect(target).toBe(path.join(cwd, 'AGENTS.md'));
    const after = '\n\n\n# More notes';
    fs.writeFileSync(
      target as string,
      `# Team conventions\n\n${HARNESS_MARKER_START}\nold harness\n${HARNESS_MARKER_END}${after}`,
      'utf8',
    );
    const result = installAgentHarness('codex', 'project');
    expect(result.action).toBe('updated');
    const written = fs.readFileSync(target as string, 'utf8');
    const endSlice = written.slice(
      written.indexOf(HARNESS_MARKER_END) + HARNESS_MARKER_END.length,
    );
    expect(endSlice).toBe(after);
    expect(written.endsWith('\n')).toBe(false);
    const repeat = installAgentHarness('codex', 'project');
    expect(repeat.action).toBe('unchanged');
    expect(fs.readFileSync(target as string, 'utf8')).toBe(written);
  });

  it('cursor refresh preserves no-trailing-newline footer verbatim', () => {
    const cwd = useTmpCwd();
    const target = resolveHarnessPath('cursor', 'project');
    expect(target).toBe(
      path.join(cwd, '.cursor', 'rules', CURSOR_RULE_FILENAME),
    );
    const footer = '\n\n\n# Keep this footer';
    fs.mkdirSync(path.dirname(target as string), { recursive: true });
    fs.writeFileSync(
      target as string,
      `---\ndescription: My custom description\nalwaysApply: true\n---\n\n# My preamble\n\n${HARNESS_MARKER_START}\nold\n${HARNESS_MARKER_END}${footer}`,
      'utf8',
    );
    const result = installAgentHarness('cursor', 'project');
    expect(result.action).toBe('updated');
    const written = fs.readFileSync(target as string, 'utf8');
    const endSlice = written.slice(
      written.indexOf(HARNESS_MARKER_END) + HARNESS_MARKER_END.length,
    );
    expect(endSlice).toBe(footer);
    expect(written.endsWith('\n')).toBe(false);
    expect(written).toContain('description: My custom description');
    const repeat = installAgentHarness('cursor', 'project');
    expect(repeat.action).toBe('unchanged');
    expect(fs.readFileSync(target as string, 'utf8')).toBe(written);
  });
});

describe('NOT-295 canonical session receipt', () => {
  const firstTurnTexts = (): Array<[string, string]> => [
    ['cursor/global', buildCursorHarnessFile('global')],
    ['cursor/project', buildCursorHarnessFile('project')],
    ['claude/global', buildClaudeHarnessBlock('global')],
    ['claude/project', buildClaudeHarnessBlock('project')],
    ['codex/global', buildCodexHarnessBlock('global')],
    ['codex/project', buildCodexHarnessBlock('project')],
  ];

  it('requires get_session_context before repo reads/task commands with exactly one verbatim display_summary line', () => {
    for (const [label, text] of firstTurnTexts()) {
      expect(text, label).toContain('Before reading repo files, running task commands');
      expect(text, label).toContain('require `get_session_context` to succeed');
      expect(text, label).toContain('call `get_session_context` once');
      expect(text, label).toContain('exactly one transcript line');
      expect(text, label).toContain('rendering `display_summary`');
      expect(text, label).toContain('Render it verbatim');
      // The hard gate precedes the receipt: bootstrap before task action.
      expect(text.indexOf('Before reading repo files'), label).toBeLessThan(
        text.indexOf('exactly one transcript line'),
      );
    }
  });

  it('keeps one source string: no reconstruction, override suffix printed exactly as returned', () => {
    for (const [label, text] of firstTurnTexts()) {
      expect(text, label).toContain('do not reconstruct the deck name, counts, badge');
      expect(text, label).toContain('session (default …)');
      expect(text, label).toContain(
        'print the suffix exactly as returned when the session deck differs from the workspace default',
      );
      // No invented concrete suffix an agent could copy instead of the
      // backend string (the NOT-211 fixture owns real suffix values).
      expect(text, label).not.toMatch(/session \(default [A-Za-z0-9_-]+\)/);
    }
  });

  it('later turns: no repeat when unchanged, one new receipt on confirmed change', () => {
    for (const [label, text] of firstTurnTexts()) {
      expect(text, label).toContain(
        'Do not re-show the session receipt on later turns when the binding is unchanged',
      );
      expect(text, label).toContain(
        'after a confirmed binding change, show exactly one new receipt line',
      );
      expect(text, label).not.toContain('repeat the status line every turn');
    }
  });

  it('calls the transcript receipt authoritative and status lines secondary', () => {
    for (const [label, text] of firstTurnTexts()) {
      expect(text, label).toContain('authoritative binding record for the session');
      expect(text, label).toContain('optional secondary context');
    }
  });

  it('cursor inner builder feeds the same receipt contract as the file', () => {
    for (const scope of ['global', 'project'] as const) {
      const inner = buildCursorHarnessInner(scope);
      expect(inner).toContain('exactly one transcript line');
      expect(inner).toContain('Render it verbatim');
      expect(buildCursorHarnessFile(scope)).toContain(inner);
    }
  });
});

describe('NOT-295 harness freshness diagnostic', () => {
  let tmpHome: string | undefined;
  let previousCodexHome: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    previousCodexHome = undefined;
    if (tmpHome) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      tmpHome = undefined;
    }
  });

  function useTmpHome(): string {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-diagnose-'));
    previousCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    return tmpHome;
  }

  const clients = ['cursor', 'claude', 'codex'] as const;

  it.each(clients)('missing %s harness names the client/file and the exact repair command', (client) => {
    useTmpHome();
    const diagnosis = diagnoseHarness(client, 'global');
    expect(diagnosis.status).toBe('missing');
    expect(diagnosis.client).toBe(client);
    expect(diagnosis.path.length).toBeGreaterThan(0);
    expect(diagnosis.repairCommand).toBe(`agent-deck setup --client ${client}`);
    // Read-only: the diagnostic must not create the file.
    expect(fs.existsSync(diagnosis.path)).toBe(false);
    const joined = formatHarnessDiagnosis([diagnosis], { color: false, homeDir: '/not-home' }).join('\n');
    expect(joined).toContain(`MISSING ${client}  ${diagnosis.path}`);
    expect(joined).toContain(`Run: agent-deck setup --client ${client}`);
  });

  it.each(clients)('stale %s harness names the client/file and the exact repair command', (client) => {
    useTmpHome();
    const installed = installAgentHarness(client, 'global');
    expect(installed.installed).toBe(true);
    const target = installed.path as string;
    // Installed file carries the first-turn receipt expectation.
    const written = fs.readFileSync(target, 'utf8');
    expect(written).toContain('exactly one transcript line');
    expect(written).toContain('display_summary');
    // Pre-NOT-295 managed block with user notes alongside: still stale,
    // and the report still names the exact recovery command.
    const stale = `# My notes\n\n${HARNESS_MARKER_START}\nold harness body\n${HARNESS_MARKER_END}\n`;
    fs.writeFileSync(target, stale, 'utf8');
    const diagnosis = diagnoseHarness(client, 'global');
    expect(diagnosis.status).toBe('stale');
    expect(diagnosis.path).toBe(target);
    expect(diagnosis.repairCommand).toBe(`agent-deck setup --client ${client}`);
    const joined = formatHarnessDiagnosis([diagnosis], { color: false, homeDir: '/not-home' }).join('\n');
    expect(joined).toContain(`STALE ${client}  ${target}`);
    expect(joined).toContain(`Run: agent-deck setup --client ${client}`);
  });

  it.each(clients)('current %s harness after install, ignoring user notes outside the markers', (client) => {
    useTmpHome();
    const installed = installAgentHarness(client, 'global');
    expect(installed.installed).toBe(true);
    const target = installed.path as string;
    expect(diagnoseHarness(client, 'global').status).toBe('current');
    fs.writeFileSync(
      target,
      `${fs.readFileSync(target, 'utf8')}\n# My notes\n`,
      'utf8',
    );
    expect(diagnoseHarness(client, 'global').status).toBe('current');
  });

  it('diagnoseAllHarnesses reports every client in one read-only pass', () => {
    useTmpHome();
    const all = diagnoseAllHarnesses('global');
    expect(all.map((diagnosis) => diagnosis.client)).toEqual(['cursor', 'claude', 'codex']);
    expect(all.every((diagnosis) => diagnosis.status === 'missing')).toBe(true);
    expect(all.map((diagnosis) => diagnosis.repairCommand)).toEqual([
      'agent-deck setup --client cursor',
      'agent-deck setup --client claude',
      'agent-deck setup --client codex',
    ]);
    const joined = formatHarnessDiagnosis(all, { color: false }).join('\n');
    expect(joined).toContain('3 repairs needed');
    expect(joined).toContain('Restart each repaired host');
  });

  it('release path: install each harness into a temporary home, then diagnose current', () => {
    useTmpHome();
    for (const client of clients) {
      const installed = installAgentHarness(client, 'global');
      expect(installed.installed).toBe(true);
      expect(installed.action).toBe('created');
      const diagnosis = diagnoseHarness(client, 'global');
      expect(diagnosis.status).toBe('current');
      expect(fs.readFileSync(installed.path as string, 'utf8')).toContain(
        'exactly one transcript line',
      );
    }
    const joined = formatHarnessDiagnosis(diagnoseAllHarnesses('global'), { color: false }).join('\n');
    expect(joined).toBe('Agent harness: all current');
  });

  it('shortens home paths and highlights the repair command when color is enabled', () => {
    const lines = formatHarnessDiagnosis(
      [{
        client: 'cursor',
        path: '/Users/test/.cursor/rules/agent-deck.mdc',
        status: 'stale',
        repairCommand: 'agent-deck setup --client cursor',
      }],
      { color: true, homeDir: '/Users/test' },
    );
    const joined = lines.join('\n');
    expect(joined).toContain('~/.cursor/rules/agent-deck.mdc');
    expect(joined).toContain('\u001b[1;36magent-deck setup --client cursor\u001b[0m');
  });
});
describe('NOT-375 deck operating instructions contract', () => {
  const texts = (): Array<[string, string]> => [
    ['cursor/global', buildCursorHarnessFile('global')],
    ['cursor/project', buildCursorHarnessFile('project')],
    ['claude/global', buildClaudeHarnessBlock('global')],
    ['claude/project', buildClaudeHarnessBlock('project')],
    ['codex/global', buildCodexHarnessBlock('global')],
    ['codex/project', buildCodexHarnessBlock('project')],
  ];

  it('first turn reads and follows the non-empty deck instructions', () => {
    for (const [label, text] of texts()) {
      expect(text, label).toContain('Deck operating instructions');
      expect(text, label).toContain('`operatingInstructions`');
      expect(text, label).toContain('read and follow the non-empty instructions');
      expect(text, label).toContain("for this session's deck only");
    }
  });

  it('hot switch reloads the new deck context before more task work, old instructions stop at once', () => {
    for (const [label, text] of texts()) {
      expect(text, label).toContain('After a confirmed deck change');
      expect(text, label).toContain('call `get_session_context` once before more task work');
      expect(text, label).toContain('follow only the new deck');
      expect(text, label).toContain('stop applying immediately');
      expect(text, label).toContain('No reconnect is needed');
    }
  });

  it('states the precedence rule: deck prose never wins and never enables tools', () => {
    for (const [label, text] of texts()) {
      expect(text, label).toContain('never override platform safety');
      expect(text, label).toContain('developer/user instructions');
      expect(text, label).toContain('authorization boundaries');
      expect(text, label).toContain('never enable extra tools');
      expect(text, label).toContain('higher-priority instruction wins');
    }
  });

  it('names get_session_context the authoritative live value over the initialize hint', () => {
    for (const [label, text] of texts()) {
      expect(text, label).toContain('bootstrap hint only');
      expect(text, label).toContain('never update after a hot switch');
      expect(text, label).toContain('authoritative live value');
    }
  });

  it('embeds no deck-specific instruction body', () => {
    for (const [label, text] of texts()) {
      // The representative Planner policy from the ticket must stay in the
      // deck body — the generic guidance references the field, never a body.
      expect(text, label).not.toContain('create execution tickets');
      expect(text, label).not.toContain('SMOKE-');
    }
  });
});
