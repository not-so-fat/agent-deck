import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  buildClaudeHarnessBlock,
  buildCursorHarnessFile,
  CURSOR_RULE_FILENAME,
  HARNESS_MARKER_END,
  HARNESS_MARKER_START,
  HARNESS_RULE_DESCRIPTION,
  mergeClaudeHarness,
  mergeCursorHarnessFile,
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

  it('project harness adds optional assignment guidance without the obsolete bind flow', () => {
    const cursor = buildCursorHarnessFile('project');
    const claude = buildClaudeHarnessBlock('project');
    for (const text of [cursor, claude]) {
      expect(text).not.toContain('bind_workspace');
      expect(text).toContain('agent-deck use');
      expect(text).toContain('optional persistent folder-assignment');
      expect(text).toContain('launch-selected sessions can be bound without that file');
    }
  });

  it('claude block carries the same fail-closed bootstrap contract', () => {
    const block = buildClaudeHarnessBlock('global');
    expect(block).toContain('Agent Deck hard gate');
    expect(block).toContain('get_session_binding');
    expect(block).toContain('get_bound_deck');
    expect(block).toContain('Checking for the optional assignment signal');
    expect(block).toContain('do not improvise without the deck');
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
