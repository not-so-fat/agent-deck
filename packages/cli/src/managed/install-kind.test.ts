import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectInstallKind } from './install-kind';

describe('detectInstallKind', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-kind-'));
    process.env.AGENT_DECK_HOME = tmp;
  });
  afterEach(() => {
    delete process.env.AGENT_DECK_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns managed when current symlink resolves', () => {
    const target = path.join(tmp, 'versions', '1.0.0');
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, path.join(tmp, 'current'));
    expect(detectInstallKind()).toBe('managed');
  });

  it('returns npm-global when which path is under prefix', () => {
    expect(
      detectInstallKind({
        whichPath: '/usr/local/lib/node_modules/@agent-deck/cli/dist/bin.js',
        npmGlobalPrefix: '/usr/local',
      }),
    ).toBe('npm-global');
  });

  it('returns unknown otherwise', () => {
    expect(detectInstallKind({ whichPath: '/repo/packages/cli/dist/bin.js' })).toBe('unknown');
  });
});
