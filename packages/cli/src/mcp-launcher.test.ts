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
  clearDeckSwitchAutoOpened,
  handleSwitchDeckToolResult,
  parseLaunchHeaders,
  resolveApprovalBackendUrl,
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
    expect(plan.unassigned).toBeUndefined();
    expect(plan.headers).toEqual([
      `${AGENT_DECK_DECK_ID_HEADER}: deck-v3`,
      `${AGENT_DECK_WORKSPACE_HEADER}: ${workspace}`,
    ]);
    expect(plan.headers.join('\n')).not.toMatch(/Authorization/i);
    expect(clearKeychainAssignment).not.toHaveBeenCalled();
  });

  // What the bridge calls before it replays a handshake (NOT-101): an approved
  // workspace-default switch rewrites the assignment mid-session, and reconnecting
  // with the deck this process started on would put the client back on the old deck.
  it('re-resolves to the deck the assignment names now, not the one we launched on', async () => {
    const workspace = makeWorkspace();
    await writeAssignment(workspace, { deckId: 'deck-a', deckName: 'a' });
    const launch = await resolveMcpLaunchPlan(workspace, endpoint);

    await writeAssignment(workspace, { deckId: 'deck-b', deckName: 'b' });
    const afterSwitch = await resolveMcpLaunchPlan(workspace, endpoint);

    expect(parseLaunchHeaders(launch.headers)).toMatchObject({
      [AGENT_DECK_DECK_ID_HEADER]: 'deck-a',
    });
    expect(parseLaunchHeaders(afterSwitch.headers)).toMatchObject({
      [AGENT_DECK_DECK_ID_HEADER]: 'deck-b',
    });
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
    expect(plan.deckId).toBe('deck-kc');
    expect(clearKeychainAssignment).toHaveBeenCalledWith(workspace);
    expect(fs.existsSync(path.join(workspace, '.agent-deck', 'use.json'))).toBe(true);
  });

  it('connects without a deck header when no assignment exists (NOT-50)', async () => {
    const workspace = makeWorkspace();
    const plan = await resolveMcpLaunchPlan(workspace, endpoint);
    expect(plan).toEqual({
      workspaceRoot: workspace,
      mcpUrl: 'http://127.0.0.1:1110/mcp',
      headers: [`${AGENT_DECK_WORKSPACE_HEADER}: ${workspace}`],
      unassigned: true,
    });
    expect(plan.headers.join('\n')).not.toMatch(AGENT_DECK_DECK_ID_HEADER);
    expect(NO_ASSIGNMENT_MESSAGE).toContain('agent-deck use');
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

describe('supported production host transport', () => {
  it('routes the Codex plugin and Claude plugin through the shared mcp-launch path', () => {
    const repositoryRoot = path.resolve(__dirname, '../../..');
    const transport = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, '.mcp.json'), 'utf8'),
    ) as { mcpServers?: Record<string, { command?: string; args?: string[] }> };
    const codexPlugin = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
    ) as { mcpServers?: string };
    const claudePlugin = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { mcpServers?: string };

    expect(codexPlugin.mcpServers).toBe('./.mcp.json');
    expect(claudePlugin.mcpServers).toBe('./.mcp.json');
    expect(transport.mcpServers?.['agent-deck']).toMatchObject({
      command: 'agent-deck',
      args: ['mcp-launch'],
    });
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

describe('switch_deck browser fallback (NOT-212)', () => {
  const backendUrl = 'http://127.0.0.1:1111';

  function pendingResult(overrides: Record<string, unknown> = {}) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            requestId: 'req_pending_1',
            status: 'pending',
            currentDeckId: 'deck-a',
            currentDeckName: 'alpha',
            requestedDeckId: 'deck-b',
            requestedDeckName: 'beta',
            presentation: {
              kind: 'deck_switch_request',
              status: 'pending',
              channels: ['host-elicitation', 'browser'],
            },
            ...overrides,
          }),
        },
      ],
    };
  }

  function stubOpener(impl?: (backend: string, path?: string) => Promise<{ code: number; url?: string; message?: string }>) {
    return vi.fn(
      impl ?? (async () => ({ code: 0, url: 'http://127.0.0.1:1111/opened' })),
    );
  }

  afterEach(() => {
    clearDeckSwitchAutoOpened();
  });

  it('opens one trusted approval page for a new pending request', async () => {
    const opener = stubOpener();
    const outcome = await handleSwitchDeckToolResult(backendUrl, pendingResult(), {
      opener,
      env: {},
    });

    expect(outcome).toEqual({ opened: true, requestId: 'req_pending_1' });
    expect(opener).toHaveBeenCalledTimes(1);
    expect(opener).toHaveBeenCalledWith(
      backendUrl,
      '/deck-switch/approve?request=req_pending_1',
    );
    // Reusable auth secrets never travel in the approval URL.
    const openedPath = String(opener.mock.calls[0][1]);
    expect(openedPath).not.toMatch(/bootstrap|token|secret|cookie|bearer|authoriz/i);
  });

  it('does not open a second tab when the same request is returned again', async () => {
    const opener = stubOpener();
    const deps = { opener, env: {} as NodeJS.ProcessEnv };

    expect(await handleSwitchDeckToolResult(backendUrl, pendingResult(), deps)).toMatchObject({
      opened: true,
    });
    expect(await handleSwitchDeckToolResult(backendUrl, pendingResult(), deps)).toMatchObject({
      opened: false,
      requestId: 'req_pending_1',
    });
    expect(opener).toHaveBeenCalledTimes(1);
  });

  it('opens again for a different request id', async () => {
    const opener = stubOpener();
    const deps = { opener, env: {} as NodeJS.ProcessEnv };

    await handleSwitchDeckToolResult(backendUrl, pendingResult(), deps);
    const second = await handleSwitchDeckToolResult(
      backendUrl,
      pendingResult({ requestId: 'req_pending_2' }),
      deps,
    );
    expect(second).toEqual({ opened: true, requestId: 'req_pending_2' });
    expect(opener).toHaveBeenCalledTimes(2);
  });

  it('ignores already_on_deck results without opening', async () => {
    const opener = stubOpener();
    const outcome = await handleSwitchDeckToolResult(
      backendUrl,
      {
        content: [
          { type: 'text', text: JSON.stringify({ status: 'already_on_deck' }) },
        ],
      },
      { opener, env: {} },
    );
    expect(outcome).toEqual({ opened: false });
    expect(opener).not.toHaveBeenCalled();
  });

  it('keeps the request pending and names the menubar path when opening fails', async () => {
    const opener = stubOpener(async () => ({ code: 1, message: 'no browser' }));
    const errors: string[] = [];
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((message: string) => {
      errors.push(String(message));
    });
    try {
      const deps = { opener, env: {} as NodeJS.ProcessEnv };
      expect(await handleSwitchDeckToolResult(backendUrl, pendingResult(), deps)).toMatchObject({
        opened: false,
        requestId: 'req_pending_1',
      });
      // Not marked as opened, so a repeat retries instead of dropping the request.
      expect(await handleSwitchDeckToolResult(backendUrl, pendingResult(), deps)).toMatchObject({
        opened: false,
      });
      expect(opener).toHaveBeenCalledTimes(2);
    } finally {
      consoleSpy.mockRestore();
    }
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('req_pending_1');
    expect(errors[0]).toContain('still pending');
    expect(errors[0]).toContain('menubar Pending approvals');
  });

  it('does not open a browser when AGENT_DECK_NO_OPEN is set', async () => {
    const opener = stubOpener();
    const outcome = await handleSwitchDeckToolResult(backendUrl, pendingResult(), {
      opener,
      env: { AGENT_DECK_NO_OPEN: '1' },
    });
    expect(outcome).toMatchObject({ opened: true });
    expect(opener).not.toHaveBeenCalled();
  });

  it('fires the menubar error path when the opener rejects with a spawn failure (NOT-237)', async () => {
    const opener = vi.fn(async () => {
      throw new Error('spawn xdg-open ENOENT');
    });
    const errors: string[] = [];
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((message: string) => {
      errors.push(String(message));
    });
    try {
      const outcome = await handleSwitchDeckToolResult(backendUrl, pendingResult(), {
        opener,
        env: {},
      });
      expect(outcome).toMatchObject({ opened: false, requestId: 'req_pending_1' });
    } finally {
      consoleSpy.mockRestore();
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('req_pending_1');
    expect(errors[0]).toContain('ENOENT');
    expect(errors[0]).toContain('menubar Pending approvals');
    expect(errors[0]).toContain('agent-deck open --path');
  });

  it('leaves the active deck unchanged while the request is pending', async () => {
    const workspace = makeWorkspace();
    const endpoint = { host: '127.0.0.1', mcpPort: 1110 };
    await writeAssignment(workspace, { deckId: 'deck-a', deckName: 'alpha' });

    const opener = stubOpener();
    await handleSwitchDeckToolResult(backendUrl, pendingResult(), { opener, env: {} });

    const after = await resolveMcpLaunchPlan(workspace, endpoint);
    expect(parseLaunchHeaders(after.headers)).toMatchObject({
      [AGENT_DECK_DECK_ID_HEADER]: 'deck-a',
    });
  });
});

describe('resolveApprovalBackendUrl (NOT-199)', () => {
  const endpoint = { host: '127.0.0.1', mcpPort: 1110 };

  it('names the dashboard for the endpoint this process was launched against', () => {
    expect(resolveApprovalBackendUrl('http://127.0.0.1:1110/mcp', endpoint, 1111)).toBe(
      'http://127.0.0.1:1111',
    );
  });

  it('has no dashboard to name once the assignment moved the bridge to another port', () => {
    expect(resolveApprovalBackendUrl('http://127.0.0.1:2110/mcp', endpoint, 1111)).toBeUndefined();
  });

  it('has no dashboard to name for another host', () => {
    expect(resolveApprovalBackendUrl('http://other.example:1110/mcp', endpoint, 1111)).toBeUndefined();
    expect(resolveApprovalBackendUrl('https://127.0.0.1:1110/mcp', endpoint, 1111)).toBeUndefined();
  });

  it('has no dashboard to name for an unparsable endpoint', () => {
    expect(resolveApprovalBackendUrl('not a url', endpoint, 1111)).toBeUndefined();
  });
});
