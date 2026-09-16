import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_DECK_DECK_ID_HEADER,
  AGENT_DECK_WORKSPACE_HEADER,
} from '@agent-deck/shared';

import {
  NO_ASSIGNMENT_MESSAGE,
  parseLaunchHeaders,
  resolveBridgeKind,
  resolveMcpLaunchPlan,
} from './mcp-launcher';
import { writeAssignment } from './assignment';

const clearKeychainAssignment = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('./assignment', async () => {
  const actual = await vi.importActual<typeof import('./assignment')>('./assignment');
  return {
    ...actual,
    clearKeychainAssignment,
  };
});

const tmpDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  clearKeychainAssignment.mockClear();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-mcp-launch-'));
  tmpDirs.push(dir);
  return dir;
}

describe('mcp-launch assignment headers', () => {
  const endpoint = { host: '127.0.0.1', mcpPort: 1110 };

  it('sends deck + workspace headers from a v3 assignment (no Authorization)', async () => {
    const workspace = makeWorkspace();
    await writeAssignment(workspace, {
      deckId: 'deck-v3',
      deckName: 'dev',
      mcpUrl: 'http://127.0.0.1:1110/mcp',
    });

    const plan = await resolveMcpLaunchPlan(workspace, endpoint);
    expect('error' in plan).toBe(false);
    if ('error' in plan) {
      return;
    }
    expect(plan.headers).toEqual([
      `${AGENT_DECK_DECK_ID_HEADER}: deck-v3`,
      `${AGENT_DECK_WORKSPACE_HEADER}: ${workspace}`,
    ]);
    expect(plan.headers.join('\n')).not.toMatch(/Authorization/i);
    expect(clearKeychainAssignment).not.toHaveBeenCalled();
  });

  it('migrates a v2 grant file to v3 and sends the deck header', async () => {
    const workspace = makeWorkspace();
    fs.mkdirSync(path.join(workspace, '.agent-deck'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.agent-deck', 'use.json'),
      `${JSON.stringify({
        version: 2,
        workspaceKey: 'wk',
        grantId: 'gr',
        secret: 'super-secret-value-at-least-32-chars!!',
        deckId: 'deck-v2',
        deckName: 'legacy',
        mcpUrl: 'http://127.0.0.1:1110/mcp',
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
    );

    const plan = await resolveMcpLaunchPlan(workspace, endpoint);
    expect('error' in plan).toBe(false);
    if ('error' in plan) {
      return;
    }
    expect(plan.deckId).toBe('deck-v2');
    expect(plan.headers[0]).toBe(`${AGENT_DECK_DECK_ID_HEADER}: deck-v2`);

    const migrated = JSON.parse(
      fs.readFileSync(path.join(workspace, '.agent-deck', 'use.json'), 'utf8'),
    ) as { version: number; deckId: string; secret?: string };
    expect(migrated.version).toBe(3);
    expect(migrated.deckId).toBe('deck-v2');
    expect(migrated.secret).toBeUndefined();
    expect(clearKeychainAssignment).not.toHaveBeenCalled();
  });

  it('clears the legacy Keychain entry when migrating from Keychain', async () => {
    const workspace = makeWorkspace();
    const assignment = await import('./assignment');
    vi.spyOn(assignment, 'readAssignment').mockResolvedValue({
      deckId: 'deck-kc',
      deckName: 'from-keychain',
      mcpUrl: 'http://127.0.0.1:1110/mcp',
      needsMigration: true,
      source: 'keychain',
    });

    const plan = await resolveMcpLaunchPlan(workspace, endpoint);
    expect('error' in plan).toBe(false);
    if ('error' in plan) {
      return;
    }
    expect(plan.deckId).toBe('deck-kc');
    expect(clearKeychainAssignment).toHaveBeenCalledWith(workspace);
    expect(fs.existsSync(path.join(workspace, '.agent-deck', 'use.json'))).toBe(true);
  });

  it('exits with the ticket message when no assignment exists', async () => {
    const workspace = makeWorkspace();
    const plan = await resolveMcpLaunchPlan(workspace, endpoint);
    expect(plan).toEqual({ error: NO_ASSIGNMENT_MESSAGE });
  });
});

describe('bridge selection (NOT-101)', () => {
  it('defaults to the built-in bridge, which reconnects after a server restart', () => {
    expect(resolveBridgeKind(undefined)).toBe('builtin');
    expect(resolveBridgeKind('')).toBe('builtin');
    expect(resolveBridgeKind('anything-else')).toBe('builtin');
  });

  it('keeps supergateway reachable as an explicit escape hatch', () => {
    expect(resolveBridgeKind('supergateway')).toBe('supergateway');
    expect(resolveBridgeKind(' SuperGateway ')).toBe('supergateway');
  });
});

describe('parseLaunchHeaders', () => {
  it('turns launch header strings into the map the bridge replays on every call', () => {
    expect(
      parseLaunchHeaders([
        `${AGENT_DECK_DECK_ID_HEADER}: deck-123`,
        `${AGENT_DECK_WORKSPACE_HEADER}: /tmp/work: space`,
      ]),
    ).toEqual({
      [AGENT_DECK_DECK_ID_HEADER]: 'deck-123',
      [AGENT_DECK_WORKSPACE_HEADER]: '/tmp/work: space',
    });
  });

  it('drops malformed entries instead of sending empty headers', () => {
    expect(parseLaunchHeaders(['no-colon', 'empty:', ': novalue'])).toEqual({});
  });
});
