import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installMenubarPlugin,
  MENUBAR_PLUGIN_NAME,
  resolveSwiftBarPluginDir,
  shouldTryInstallSwiftBar,
  SWIFTBAR_FALLBACK_PLUGIN_DIR,
} from './menubar-setup';

describe('menubar setup', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-menubar-'));
    process.env.AGENT_DECK_SWIFTBAR_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.AGENT_DECK_SWIFTBAR_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('env override wins plugin dir resolution', () => {
    expect(resolveSwiftBarPluginDir()).toEqual({ dir: tmpDir, source: 'env' });
  });

  it('writes an executable plugin script that runs agent-deck menubar', () => {
    const result = installMenubarPlugin();
    expect(result.action).toBe('created');
    expect(result.pluginPath).toBe(path.join(tmpDir, MENUBAR_PLUGIN_NAME));

    const content = fs.readFileSync(result.pluginPath, 'utf8');
    expect(content.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(content).toContain('menubar');
    expect(content).toContain('.local/bin/agent-deck');
    expect(content).not.toContain('statusline');

    const mode = fs.statSync(result.pluginPath).mode & 0o777;
    expect(mode & 0o111).not.toBe(0);
  });

  it('is idempotent', () => {
    installMenubarPlugin();
    expect(installMenubarPlugin().action).toBe('unchanged');
  });

  it('shouldTryInstallSwiftBar skips in CI', () => {
    const prior = process.env.CI;
    process.env.CI = 'true';
    try {
      expect(shouldTryInstallSwiftBar()).toBe(false);
    } finally {
      if (prior === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = prior;
      }
    }
  });

  it('fallback plugin dir is under ~/.agent-deck', () => {
    delete process.env.AGENT_DECK_SWIFTBAR_DIR;
    expect(resolveSwiftBarPluginDir().dir).toBe(SWIFTBAR_FALLBACK_PLUGIN_DIR);
  });
});
