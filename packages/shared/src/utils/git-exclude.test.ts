import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AGENT_DECK_GIT_EXCLUDE_PATTERNS, ensureGitExcluded } from './git-exclude';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

const mockedExecFileSync = vi.mocked(execFileSync);

const tmpDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-git-exclude-'));
  tmpDirs.push(dir);
  return dir;
}

describe('ensureGitExcluded', () => {
  it('is a no-op outside a git repo', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('not a git repository');
    });
    const root = makeTmp();
    expect(() => ensureGitExcluded(root)).not.toThrow();
    expect(fs.existsSync(path.join(root, '.git'))).toBe(false);
  });

  it('appends patterns idempotently into info/exclude', () => {
    const root = makeTmp();
    const excludePath = path.join(root, '.git', 'info', 'exclude');
    mockedExecFileSync.mockReturnValue('.git/info/exclude\n');

    ensureGitExcluded(root);
    const first = fs.readFileSync(excludePath, 'utf8');
    for (const pattern of AGENT_DECK_GIT_EXCLUDE_PATTERNS) {
      expect(first).toContain(pattern);
    }

    ensureGitExcluded(root);
    const second = fs.readFileSync(excludePath, 'utf8');
    expect(second).toBe(first);

    const counts = AGENT_DECK_GIT_EXCLUDE_PATTERNS.map(
      (pattern) => second.split('\n').filter((line) => line.trim() === pattern).length,
    );
    expect(counts.every((n) => n === 1)).toBe(true);

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', root, 'rev-parse', '--git-path', 'info/exclude'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('resolves a relative git-path against the folder root', () => {
    const root = makeTmp();
    mockedExecFileSync.mockReturnValue('info/exclude\n');
    // Simulate bare-ish layout where rev-parse returns a path relative to root.
    fs.mkdirSync(path.join(root, 'info'), { recursive: true });

    ensureGitExcluded(root, ['/.agent-deck/']);
    expect(fs.readFileSync(path.join(root, 'info', 'exclude'), 'utf8')).toContain('/.agent-deck/');
  });
});
