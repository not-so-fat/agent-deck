import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildClaudeStubFile,
  buildCursorStubFile,
  buildStubDescription,
  readUseManifest,
  STUB_MARKER_END,
  STUB_MARKER_START_PREFIX,
  resolvePlaybookSlugs,
  syncPlaybookStubs,
  writeUseManifest,
  yamlSingleQuote,
} from './stub-sync';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-stub-sync-'));
  tmpDirs.push(dir);
  return dir;
}

describe('stub-sync', () => {
  const playbook = {
    id: 'pb_hiring_inbox',
    title: 'Hiring Inbox',
    triggers: ['check inbox', 'triage candidates'],
  };

  it('builds cursor stub with title and triggers in quoted description', () => {
    const file = buildCursorStubFile(playbook);
    expect(file).toContain(
      "description: 'Hiring Inbox — use when the user asks about check inbox, triage candidates",
    );
    expect(file).toContain('get_playbook("pb_hiring_inbox")');
    expect(file).toContain('alwaysApply: false');
    expect(file).toContain(`${STUB_MARKER_START_PREFIX} pb_hiring_inbox -->`);
    expect(file).toContain(STUB_MARKER_END);
  });

  it('falls back to title when triggers are empty', () => {
    expect(buildStubDescription({ ...playbook, triggers: [] })).toContain(
      'Hiring Inbox — use when the user asks about Hiring Inbox',
    );
  });

  it('quotes YAML safely when triggers contain colon-space or apostrophe', () => {
    const risky = {
      ...playbook,
      triggers: ["note: read this", "user's inbox"],
    };
    const file = buildCursorStubFile(risky);
    expect(file.startsWith('---\ndescription: ')).toBe(true);
    expect(yamlSingleQuote("it's fine")).toBe("'it''s fine'");
    expect(file).toContain("note: read this");
  });

  it('sync creates stubs, removes retired playbooks, and preserves non-marker files', () => {
    const workspace = makeWorkspace();
    const first = syncPlaybookStubs(workspace, [playbook]);
    expect(first.cursor.created).toBe(1);
    expect(first.claude.created).toBe(1);

    const customPath = path.join(workspace, '.cursor', 'rules', 'agent-deck-stubs', 'custom.mdc');
    fs.writeFileSync(customPath, '# user rule\n');

    const other = {
      id: 'pb_retired',
      title: 'Retired',
      triggers: ['old'],
    };
    fs.mkdirSync(path.dirname(cursorStubPath(workspace, other.id)), { recursive: true });
    fs.writeFileSync(cursorStubPath(workspace, other.id), buildCursorStubFile(other));

    const second = syncPlaybookStubs(workspace, [playbook]);
    expect(second.cursor.removed).toBe(1);
    expect(fs.existsSync(customPath)).toBe(true);
  });

  it('second bind reports zero changes when stubs already match', () => {
    const workspace = makeWorkspace();
    const first = syncPlaybookStubs(workspace, [playbook]);
    expect(first.cursor.created).toBe(1);
    const second = syncPlaybookStubs(workspace, [playbook]);
    expect(second.cursor.created).toBe(0);
    expect(second.cursor.updated).toBe(0);
    expect(second.cursor.removed).toBe(0);
  });

  it('writes and reads use manifest', () => {
    const workspace = makeWorkspace();
    const manifest = {
      version: 3 as const,
      deckId: 'deck-1',
      deckName: 'dev',
      mcpUrl: 'http://127.0.0.1:1110/mcp',
    };
    writeUseManifest(workspace, manifest);
    expect(readUseManifest(workspace)).toEqual(manifest);
  });

  it('resolvePlaybookSlugs suffixes colliding title slugs with playbook ids', () => {
    const slugs = resolvePlaybookSlugs([
      { id: 'pb_pr_summary', title: 'PR Summary', triggers: [] },
      { id: 'pb_ui_principle', title: 'pr-summary', triggers: [] },
      { id: 'pb_hiring_inbox', title: 'Hiring Inbox', triggers: [] },
    ]);

    expect(slugs.get('pb_hiring_inbox')).toBe('hiring-inbox');
    expect(slugs.get('pb_pr_summary')).toBe('pr-summary-pr_summary');
    expect(slugs.get('pb_ui_principle')).toBe('pr-summary-ui_principle');
  });

  it('sync writes separate claude dirs when title slugs collide', () => {
    const workspace = makeWorkspace();
    syncPlaybookStubs(workspace, [
      { id: 'pb_pr_summary', title: 'PR Summary', triggers: ['summarize PR'] },
      { id: 'pb_ui_principle', title: 'pr-summary', triggers: ['review UI'] },
    ]);

    const skillsRoot = path.join(workspace, '.claude', 'skills');
    expect(fs.existsSync(path.join(skillsRoot, 'agent-deck-pr-summary-pr_summary'))).toBe(true);
    expect(fs.existsSync(path.join(skillsRoot, 'agent-deck-pr-summary-ui_principle'))).toBe(true);
    expect(
      fs.readFileSync(path.join(skillsRoot, 'agent-deck-pr-summary-pr_summary', 'SKILL.md'), 'utf8'),
    ).toContain('get_playbook("pb_pr_summary")');
    expect(
      fs.readFileSync(path.join(skillsRoot, 'agent-deck-pr-summary-ui_principle', 'SKILL.md'), 'utf8'),
    ).toContain('get_playbook("pb_ui_principle")');
  });
});

function cursorStubPath(workspace: string, playbookId: string): string {
  return path.join(workspace, '.cursor', 'rules', 'agent-deck-stubs', `${playbookId}.mdc`);
}
