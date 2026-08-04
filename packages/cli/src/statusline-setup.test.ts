import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installStatusline, installStatuslineScript } from './statusline-setup';

describe('statusline-setup', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('writes executable statusline script under ~/.agent-deck/bin', () => {
    const { scriptPath } = installStatuslineScript();
    expect(fs.existsSync(scriptPath)).toBe(true);
    const mode = fs.statSync(scriptPath).mode & 0o777;
    expect(mode & 0o111).not.toBe(0);
    const body = fs.readFileSync(scriptPath, 'utf8');
    expect(body).toContain('agent-deck statusline');
    expect(body).toContain('.local/bin/agent-deck');
    expect(body).toContain('current/node_modules/@agent-deck/cli');
    // set -e must not abort when `npm root -g` fails
    expect(body).toContain('npm root -g 2>/dev/null || true');
    expect(body).toContain('◆ Agent Deck offline');
  });

  it('merges statusLine into Claude settings.json without timer polling', () => {
    const result = installStatusline('claude');
    expect(result.installed).toBe(true);
    const settings = JSON.parse(fs.readFileSync(result.configPath, 'utf8')) as {
      statusLine?: { command?: string; refreshInterval?: number };
    };
    expect(settings.statusLine?.command).toBe(result.scriptPath);
    expect(settings.statusLine?.refreshInterval).toBeUndefined();
  });
});
