import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURSOR_STUBS_DIR,
  readUseManifest,
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
