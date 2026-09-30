import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.hoisted(() => vi.fn());
const mockOpenDashboard = vi.hoisted(() =>
  vi.fn(async (_backendUrl: string) => ({ code: 0, url: `${_backendUrl}/?bootstrap=test_nonce` })),
);
const mockProbe = vi.hoisted(() => vi.fn());
const mockIsTcpPortOpen = vi.hoisted(() => vi.fn(async (_host: string, _port: number) => false));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: mockSpawn };
});

vi.mock('./dashboard-open', async () => {
  const actual = await vi.importActual<typeof import('./dashboard-open')>('./dashboard-open');
  return { ...actual, openDashboardInBrowser: mockOpenDashboard };
});

vi.mock('./ports', async () => {
  const actual = await vi.importActual<typeof import('./ports')>('./ports');
  return { ...actual, probeAgentDeck: mockProbe, isTcpPortOpen: mockIsTcpPortOpen };
});

vi.mock('./daemon-logs', async () => {
  const actual = await vi.importActual<typeof import('./daemon-logs')>('./daemon-logs');
  return {
    ...actual,
    openDaemonLogFd: () => 1,
    appendDaemonLogLine: () => {},
    readDaemonLogTail: () => [],
    formatChildLogTail: () => [],
    resolveCliEntry: () => '/fake/cli-entry.js',
    resolveDaemonLogPath: () => '/fake/logs/supervisor.log',
    resolveDaemonLogsDir: () => '/fake/logs',
  };
});

vi.mock('./node-runtime', async () => {
  const actual = await vi.importActual<typeof import('./node-runtime')>('./node-runtime');
  return { ...actual, checkStartPreflight: () => null };
});

vi.mock('./upgrade', async () => {
  const actual = await vi.importActual<typeof import('./upgrade')>('./upgrade');
  return { ...actual, maybeAutoUpgradeOnStart: async () => {}, notifyIfUpdateAvailable: async () => {} };
});

import { buildSupervisorArgs, runStart } from './start';

type FakeChild = EventEmitter & { pid: number; unref: () => void };

function fakeSupervisorChild(pid = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.unref = () => {};
  // Never emits exit/error: the supervisor stays up for the whole test.
  return child;
}

function stoppedProbe() {
  return { backendUp: false, mcpUp: false } as Awaited<
    ReturnType<typeof import('./ports').probeAgentDeck>
  >;
}

function runningProbe() {
  return { backendUp: true, mcpUp: true } as Awaited<
    ReturnType<typeof import('./ports').probeAgentDeck>
  >;
}

function supervisorArgsOfFirstSpawn(): string[] {
  const cliArgs = mockSpawn.mock.calls[0]?.[1] as string[];
  return cliArgs.slice(1);
}

beforeEach(() => {
  process.setMaxListeners(0);
  for (const key of ['AGENT_DECK_HOST', 'AGENT_DECK_MCP_PORT', 'AGENT_DECK_NO_OPEN', 'AGENT_DECK_SUPERVISOR']) {
    delete process.env[key];
  }
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() => fakeSupervisorChild());
  mockProbe.mockReset();
  mockIsTcpPortOpen.mockReset();
  mockIsTcpPortOpen.mockImplementation(async () => false);
  mockOpenDashboard.mockReset();
  mockOpenDashboard.mockImplementation(async (backendUrl: string) => ({
    code: 0,
    url: `${backendUrl}/?bootstrap=test_nonce`,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true })),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('daemon-start dashboard ownership (NOT-297)', () => {
  it('never lets the detached supervisor auto-open, even when the launcher opens', () => {
    for (const options of [
      {},
      { openBrowser: true },
      { openBrowser: false },
      { skipUi: true, force: true, backendPort: 1111, mcpPort: 1110 },
    ]) {
      const args = buildSupervisorArgs(options);
      expect(args[0]).toBe('start');
      expect(args).toContain('--_supervisor');
      expect(args).toContain('--no-open');
      expect(args).not.toContain('--open');
    }
  });

  it('still propagates non-open supervisor options', () => {
    const args = buildSupervisorArgs({ skipUi: true, force: true, backendPort: 1111, mcpPort: 1110 });
    expect(args).toContain('--no-ui');
    expect(args).toContain('--force');
    expect(args).toContain('--port');
    expect(args).toContain('--mcp-port');
  });

  it('cold daemon start opens exactly one bootstrapped dashboard URL', async () => {
    mockProbe.mockResolvedValue(stoppedProbe());

    const code = await runStart({ daemon: true, backendPort: 1111, mcpPort: 1110, openBrowser: true });

    expect(code).toBe(0);
    // The launcher spawns one detached supervisor that owns the backend/MCP.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const spawnOpts = mockSpawn.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(spawnOpts?.detached).toBe(true);
    expect((spawnOpts?.env as Record<string, string>)?.AGENT_DECK_SUPERVISOR).toBe('1');
    // ... and that supervisor is told never to open: the launcher owns the open.
    expect(supervisorArgsOfFirstSpawn()).toContain('--no-open');
    // Exactly one user-facing open, against a bootstrapped dashboard URL.
    expect(mockOpenDashboard).toHaveBeenCalledTimes(1);
    expect(mockOpenDashboard).toHaveBeenCalledWith('http://127.0.0.1:1111');
    const openedUrl = (await mockOpenDashboard.mock.results[0]?.value)?.url ?? '';
    expect(openedUrl).toContain('bootstrap=');
  });

  it('opens zero times for --no-open', async () => {
    mockProbe.mockResolvedValue(stoppedProbe());

    const code = await runStart({ daemon: true, backendPort: 1111, mcpPort: 1110, openBrowser: false });

    expect(code).toBe(0);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(supervisorArgsOfFirstSpawn()).toContain('--no-open');
    expect(mockOpenDashboard).not.toHaveBeenCalled();
  });

  it('opens zero times for AGENT_DECK_NO_OPEN', async () => {
    mockProbe.mockResolvedValue(stoppedProbe());
    vi.stubEnv('AGENT_DECK_NO_OPEN', '1');

    const code = await runStart({ daemon: true, backendPort: 1111, mcpPort: 1110 });

    expect(code).toBe(0);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockOpenDashboard).not.toHaveBeenCalled();
  });

  it('already-running daemon start opens at most once and starts no supervisor', async () => {
    mockProbe.mockResolvedValue(runningProbe());

    const code = await runStart({ daemon: true, backendPort: 1111, mcpPort: 1110, openBrowser: true });

    expect(code).toBe(0);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockOpenDashboard.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
