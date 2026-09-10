import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseUseArgs, runUse } from './use';
import { writeUseManifest } from './playbook-stubs';

vi.mock('./backend-runtime', () => ({
  createCollectionAdmin: () => ({
    resolveDeck: async (ref: string) => {
      if (ref === 'dev' || ref === 'deck-1') {
        return { id: 'deck-1', name: 'dev' };
      }
      if (ref === '761f3c44-21b3-4298-81e4-4c85bb963eb1') {
        return null;
      }
      return null;
    },
    listDeckPlaybookStubs: async () => [
      { id: 'pb_test', title: 'Test playbook', triggers: ['test trigger'] },
    ],
  }),
}));

vi.mock('./grant-issue', () => ({
  issueWorkspaceGrant: async () => ({
    workspaceKey: 'wk-test',
    grantId: 'grant-test',
    deckId: 'deck-1',
    deckName: 'dev',
    secret: 'secret-test',
    status: 'pending' as const,
  }),
  activateWorkspaceGrant: async () => ({
    grantId: 'grant-test',
    deckId: 'deck-1',
    deckName: 'dev',
  }),
  revokePendingWorkspaceGrant: async () => {},
  toGrantManifest: (
    issued: {
      workspaceKey: string;
      grantId: string;
      deckId: string;
      deckName: string;
      secret: string;
    },
    mcpUrl: string,
  ) => ({
    version: 2 as const,
    workspaceKey: issued.workspaceKey,
    grantId: issued.grantId,
    secret: issued.secret,
    deckId: issued.deckId,
    deckName: issued.deckName,
    mcpUrl,
    store: 'file' as const,
    updatedAt: new Date().toISOString(),
  }),
}));

const tmpDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-use-cmd-'));
  tmpDirs.push(dir);
  return dir;
}

describe('agent-deck use', () => {
  it('parseUseArgs requires deck or --refresh', () => {
    expect(parseUseArgs([])).toEqual({ error: 'deck name or id is required (or pass --refresh)' });
    expect(parseUseArgs(['dev'])).toMatchObject({ deckRef: 'dev', refresh: false });
    expect(parseUseArgs(['--refresh'])).toMatchObject({ refresh: true });
  });

  it('writes mcp config, grant manifest, and stubs for a deck', async () => {
    vi.stubEnv('AGENT_DECK_GRANT_STORE', 'file');
    const workspace = makeWorkspace();
    const fakeHome = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, '.cursor', 'mcp.json'),
      `${JSON.stringify({ mcpServers: { 'agent-deck': { url: 'http://127.0.0.1:1110/mcp' } } }, null, 2)}\n`,
    );

    const parsed = parseUseArgs(['dev', '--client', 'cursor']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }

    const result = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in result).toBe(false);
    if ('error' in result) {
      return;
    }

    expect(result.deck.name).toBe('dev');
    expect(result.playbookCount).toBe(1);
    expect(fs.existsSync(path.join(workspace, '.cursor', 'mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, '.agent-deck', 'use.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, '.cursor', 'rules', 'agent-deck-stubs', 'pb_test.mdc'))).toBe(
      true,
    );
    const mcp = JSON.parse(fs.readFileSync(path.join(workspace, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<
        string,
        { command?: string; args?: string[]; env?: Record<string, string>; headers?: Record<string, string> }
      >;
    };
    expect(mcp.mcpServers['agent-deck']?.command).toBe('agent-deck');
    expect(mcp.mcpServers['agent-deck']?.args).toEqual(['mcp-launch']);
    expect(mcp.mcpServers['agent-deck']?.env?.AGENT_DECK_WORKSPACE).toBe(workspace);
    expect(mcp.mcpServers['agent-deck']?.headers?.['x-agent-deck-deck-id']).toBeUndefined();

    const globalMcp = JSON.parse(fs.readFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<
        string,
        { command?: string; args?: string[]; url?: string; env?: Record<string, string> }
      >;
    };
    expect(globalMcp.mcpServers['agent-deck']?.url).toBeUndefined();
    expect(globalMcp.mcpServers['agent-deck']?.command).toBe('agent-deck');
    expect(globalMcp.mcpServers['agent-deck']?.args).toEqual(['mcp-launch']);
    expect(globalMcp.mcpServers['agent-deck']?.env?.AGENT_DECK_WORKSPACE).toBe(workspace);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(workspace, '.agent-deck', 'use.json'), 'utf8'),
    ) as { version: number; deckId: string; grantId: string };
    expect(manifest.version).toBe(2);
    expect(manifest.deckId).toBe(result.deck.id);
    expect(manifest.grantId).toBe('grant-test');
  });

  it('refresh diagnoses grant or legacy manifest without rewriting', async () => {
    const workspace = makeWorkspace();
    const fakeHome = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.cursor'), { recursive: true });
    const globalConfig = {
      mcpServers: { 'agent-deck': { url: 'http://127.0.0.1:1110/mcp' } },
    };
    fs.writeFileSync(
      path.join(fakeHome, '.cursor', 'mcp.json'),
      `${JSON.stringify(globalConfig, null, 2)}\n`,
    );
    writeUseManifest(workspace, {
      version: 1,
      deckId: '761f3c44-21b3-4298-81e4-4c85bb963eb1',
      deckName: 'dev',
      mcpUrl: 'http://127.0.0.1:1110/mcp',
      updatedAt: new Date().toISOString(),
    });

    const parsed = parseUseArgs(['--refresh']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }

    const result = await runUse({ ...parsed, workspaceRoot: workspace, skipMcp: true });
    expect(result).toEqual({ error: 'refresh-diagnosis-only' });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(workspace, '.agent-deck', 'use.json'), 'utf8'),
    ) as { deckId: string; version: number };
    expect(manifest.version).toBe(1);
    expect(manifest.deckId).toBe('761f3c44-21b3-4298-81e4-4c85bb963eb1');
    const unchangedGlobalConfig = JSON.parse(
      fs.readFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'),
    );
    expect(unchangedGlobalConfig).toEqual(globalConfig);
  });
});
