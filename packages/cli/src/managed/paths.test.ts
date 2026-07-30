import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentDeckHome,
  currentLinkPath,
  partialVersionDir,
  versionDir,
  versionsDir,
} from './paths';

describe('managed paths', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-managed-'));
    process.env.AGENT_DECK_HOME = tmp;
  });
  afterEach(() => {
    delete process.env.AGENT_DECK_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('nests versions under AGENT_DECK_HOME', () => {
    expect(agentDeckHome()).toBe(tmp);
    expect(versionsDir()).toBe(path.join(tmp, 'versions'));
    expect(versionDir('1.2.3')).toBe(path.join(tmp, 'versions', '1.2.3'));
    expect(partialVersionDir('1.2.3')).toBe(path.join(tmp, 'versions', '.partial-1.2.3'));
    expect(currentLinkPath()).toBe(path.join(tmp, 'current'));
  });
});
