import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CURSOR_STUBS_DIR,
  isManagedStubContent,
  readUseManifest,
  removeLegacyPlaybookStubs,
  stubSyncChanged,
  syncPlaybookStubs,
  writeUseManifest,
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

describe('stub-sync (NOT-206: static runtime discovery, no generated stubs)', () => {
  const deckAPlaybooks = [
    { id: 'pb_alpha_only', title: 'Alpha Only', triggers: ['alpha trigger'] },
  ];
  const deckBPlaybooks = [
    { id: 'pb_beta_only', title: 'Beta Only', triggers: ['beta trigger'] },
  ];

  it('writes no per-playbook files and reports zero changes', () => {
    const workspace = makeWorkspace();
    const result = syncPlaybookStubs(workspace, deckBPlaybooks);

    expect(result.cursor).toEqual({
      created: 0,
      updated: 0,
      removed: 0,
      dir: path.join(workspace, '.cursor', 'rules', CURSOR_STUBS_DIR),
    });
    expect(result.claude).toEqual({ created: 0, updated: 0, removed: 0, dirs: [] });
    expect(stubSyncChanged(result)).toBe(false);
    expect(fs.existsSync(path.join(workspace, '.cursor'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, '.claude'))).toBe(false);
  });

  it('needs no regeneration when the workspace switches from deck A to deck B', () => {
    const workspace = makeWorkspace();
    const beforeSwitch = syncPlaybookStubs(workspace, deckAPlaybooks);
    const afterSwitch = syncPlaybookStubs(workspace, deckBPlaybooks);

    expect(beforeSwitch).toEqual(afterSwitch);
    expect(stubSyncChanged(afterSwitch)).toBe(false);
  });

  it('leaves legacy stub files and user rules byte-for-byte untouched', () => {
    const workspace = makeWorkspace();
    const legacyStub = path.join(workspace, '.cursor', 'rules', CURSOR_STUBS_DIR, 'pb_alpha_only.mdc');
    const userRule = path.join(workspace, '.cursor', 'rules', 'custom.mdc');
    fs.mkdirSync(path.dirname(legacyStub), { recursive: true });
    fs.writeFileSync(legacyStub, '<!-- agent-deck:stub:start pb_alpha_only -->\n# legacy\n');
    fs.writeFileSync(userRule, '# user rule\n');

    const result = syncPlaybookStubs(workspace, deckBPlaybooks);

    expect(result.cursor.removed).toBe(0);
    expect(fs.readFileSync(legacyStub, 'utf8')).toBe(
      '<!-- agent-deck:stub:start pb_alpha_only -->\n# legacy\n',
    );
    expect(fs.readFileSync(userRule, 'utf8')).toBe('# user rule\n');
  });

  it('identifies managed stubs only when both markers are present', () => {
    expect(
      isManagedStubContent('<!-- agent-deck:stub:start pb_x -->\nbody\n<!-- agent-deck:stub:end -->\n'),
    ).toBe(true);
    expect(isManagedStubContent('<!-- agent-deck:stub:start pb_x -->\nbody\n')).toBe(false);
    expect(isManagedStubContent('# user rule\n')).toBe(false);
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
});

describe('removeLegacyPlaybookStubs (NOT-208)', () => {
  const managedCursor = (id: string): string =>
    `---\ndescription: 'Legacy ${id}'\nalwaysApply: false\n---\n\n<!-- agent-deck:stub:start ${id} -->\n# legacy\n\n<!-- agent-deck:stub:end -->\n`;
  const managedSkill = (id: string): string =>
    `---\nname: agent-deck-legacy\n---\n\n<!-- agent-deck:stub:start ${id} -->\n# legacy\n\n<!-- agent-deck:stub:end -->\n`;

  function seedWorkspace(workspace: string): {
    cursorStub: string;
    userRule: string;
    userStubLookalike: string;
    managedSkillDir: string;
    userSkillDir: string;
    prefixedUserSkillDir: string;
  } {
    const cursorStub = path.join(workspace, '.cursor', 'rules', CURSOR_STUBS_DIR, 'pb_old.mdc');
    const userRule = path.join(workspace, '.cursor', 'rules', 'custom.mdc');
    const userStubLookalike = path.join(
      workspace,
      '.cursor',
      'rules',
      CURSOR_STUBS_DIR,
      'my-notes.mdc',
    );
    const managedSkillDir = path.join(workspace, '.claude', 'skills', 'agent-deck-legacy');
    const userSkillDir = path.join(workspace, '.claude', 'skills', 'my-skill');
    const prefixedUserSkillDir = path.join(workspace, '.claude', 'skills', 'agent-deck-manual');
    fs.mkdirSync(path.dirname(cursorStub), { recursive: true });
    fs.writeFileSync(cursorStub, managedCursor('pb_old'));
    fs.writeFileSync(userRule, '# user rule\n');
    fs.writeFileSync(userStubLookalike, '# my notes (no markers)\n');
    fs.mkdirSync(managedSkillDir, { recursive: true });
    fs.writeFileSync(path.join(managedSkillDir, 'SKILL.md'), managedSkill('pb_old'));
    fs.mkdirSync(userSkillDir, { recursive: true });
    fs.writeFileSync(path.join(userSkillDir, 'SKILL.md'), '# user skill\n');
    fs.mkdirSync(prefixedUserSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(prefixedUserSkillDir, 'SKILL.md'),
      '# hand-written skill that happens to share the prefix\n',
    );
    return {
      cursorStub,
      userRule,
      userStubLookalike,
      managedSkillDir,
      userSkillDir,
      prefixedUserSkillDir,
    };
  }

  it('removes only managed stubs and preserves user-authored content', () => {
    const workspace = makeWorkspace();
    const seeded = seedWorkspace(workspace);

    const result = removeLegacyPlaybookStubs(workspace);

    expect(result.cursor.removed).toBe(1);
    expect(result.claude.removed).toBe(1);
    expect(result.removedPaths).toEqual(
      expect.arrayContaining([seeded.cursorStub, seeded.managedSkillDir]),
    );
    expect(fs.existsSync(seeded.cursorStub)).toBe(false);
    expect(fs.existsSync(seeded.managedSkillDir)).toBe(false);
    expect(fs.readFileSync(seeded.userRule, 'utf8')).toBe('# user rule\n');
    expect(fs.readFileSync(seeded.userStubLookalike, 'utf8')).toBe('# my notes (no markers)\n');
    expect(fs.readFileSync(path.join(seeded.userSkillDir, 'SKILL.md'), 'utf8')).toBe(
      '# user skill\n',
    );
    expect(
      fs.readFileSync(path.join(seeded.prefixedUserSkillDir, 'SKILL.md'), 'utf8'),
    ).toBe('# hand-written skill that happens to share the prefix\n');
  });

  it('is idempotent and safe when files and directories are already absent', () => {
    const workspace = makeWorkspace();
    seedWorkspace(workspace);

    const first = removeLegacyPlaybookStubs(workspace);
    expect(first.cursor.removed + first.claude.removed).toBe(2);
    const second = removeLegacyPlaybookStubs(workspace);
    expect(second).toEqual({
      cursor: { removed: 0, dir: path.join(workspace, '.cursor', 'rules', CURSOR_STUBS_DIR) },
      claude: { removed: 0, dirs: [] },
      removedPaths: [],
    });

    const empty = removeLegacyPlaybookStubs(makeWorkspace());
    expect(empty.cursor.removed + empty.claude.removed).toBe(0);
  });

  it('respects cursor/claude selection', () => {
    const workspace = makeWorkspace();
    const seeded = seedWorkspace(workspace);

    const result = removeLegacyPlaybookStubs(workspace, { cursor: true, claude: false });

    expect(result.cursor.removed).toBe(1);
    expect(result.claude.removed).toBe(0);
    expect(fs.existsSync(seeded.managedSkillDir)).toBe(true);
  });

  it('names the exact path when a managed file cannot be removed', () => {
    const workspace = makeWorkspace();
    const seeded = seedWorkspace(workspace);
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation(((target: unknown) => {
      if (target === seeded.cursorStub) {
        throw new Error('EACCES: permission denied');
      }
      return undefined;
    }) as typeof fs.unlinkSync);

    try {
      expect(() => removeLegacyPlaybookStubs(workspace)).toThrow(seeded.cursorStub);
    } finally {
      unlink.mockRestore();
    }
    // Unrelated files are untouched even though cleanup reported failure.
    expect(fs.readFileSync(seeded.userRule, 'utf8')).toBe('# user rule\n');
    expect(fs.readFileSync(seeded.userStubLookalike, 'utf8')).toBe('# my notes (no markers)\n');
    expect(fs.existsSync(seeded.managedSkillDir)).toBe(false);
  });
});
