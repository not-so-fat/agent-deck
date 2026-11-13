import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatOtherHomeMessage,
  resolveHomeFromEnvVars,
  resolveStopSource,
  runStop,
  sameAgentDeckHome,
  type StopDeps,
} from './stop';

describe('stop source attribution', () => {
  afterEach(() => {
    delete process.env.AGENT_DECK_STOP_SOURCE;
    delete process.env.AGENT_DECK_STOP_DETAIL;
  });

  it('defaults to the CLI command', () => {
    expect(resolveStopSource()).toEqual({ source: 'agent-deck stop', detail: undefined });
  });

  it('takes the caller-supplied source', () => {
    expect(resolveStopSource({ source: 'api', detail: 'dashboard restart' })).toEqual({
      source: 'api',
      detail: 'dashboard restart',
    });
  });

  it('lets a wrapper (menubar, launchd) identify itself through the environment', () => {
    process.env.AGENT_DECK_STOP_SOURCE = 'menubar';
    process.env.AGENT_DECK_STOP_DETAIL = 'Quit Agent Deck';
    expect(resolveStopSource()).toEqual({ source: 'menubar', detail: 'Quit Agent Deck' });
  });

  it('ignores a blank environment override', () => {
    process.env.AGENT_DECK_STOP_SOURCE = '   ';
    expect(resolveStopSource().source).toBe('agent-deck stop');
  });
});

describe('NOT-605 — stop never touches another home', () => {
  let tempHomes: string[] = [];
  let previousEnv: NodeJS.ProcessEnv = {};
  let logLines: string[] = [];
  let warnLines: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn> | null = null;
  let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

  function makeTempHome(prefix: string): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempHomes.push(home);
    return home;
  }

  beforeEach(() => {
    previousEnv = {
      AGENT_DECK_HOME: process.env.AGENT_DECK_HOME,
      AGENT_DECK_BACKEND_PORT: process.env.AGENT_DECK_BACKEND_PORT,
      AGENT_DECK_MCP_PORT: process.env.AGENT_DECK_MCP_PORT,
      AGENT_DECK_HOST: process.env.AGENT_DECK_HOST,
    };
    logLines = [];
    warnLines = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnLines.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    logSpy?.mockRestore();
    warnSpy?.mockRestore();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const home of tempHomes) {
      fs.rmSync(home, { recursive: true, force: true });
    }
    tempHomes = [];
  });

  function downProbe(backendPort: number, mcpPort: number) {
    return {
      backendUp: false,
      mcpUp: false,
      backendUrl: `http://127.0.0.1:${backendPort}`,
      mcpUrl: `http://127.0.0.1:${mcpPort}`,
    };
  }

  function upProbe(backendPort: number, mcpPort: number) {
    return {
      backendUp: true,
      mcpUp: true,
      backendUrl: `http://127.0.0.1:${backendPort}`,
      mcpUrl: `http://127.0.0.1:${mcpPort}`,
    };
  }

  it('leaves a listener from another home running and names that home (exit 0)', async () => {
    const homeB = makeTempHome('agent-deck-stop-b-');
    const homeA = makeTempHome('agent-deck-stop-a-');
    const backendPort = 45711;
    const mcpPort = 45710;
    process.env.AGENT_DECK_HOME = homeB;
    process.env.AGENT_DECK_BACKEND_PORT = String(backendPort);
    process.env.AGENT_DECK_MCP_PORT = String(mcpPort);

    const killed: number[] = [];
    const deps: StopDeps = {
      currentHome: homeB,
      readRunState: () => null,
      clearRunState: () => {},
      probeAgentDeck: async () => upProbe(backendPort, mcpPort),
      listListeningPids: (port) => (port === mcpPort ? [42421] : port === backendPort ? [42422] : []),
      isProcessAlive: () => true,
      kill: (pid) => {
        killed.push(pid);
      },
      getPidHome: () => homeA,
      fetchReportedDaemonHome: async () => null,
      sleep: async () => {},
    };

    const code = await runStop({}, deps);

    expect(code).toBe(0);
    expect(killed).toEqual([]);
    const output = logLines.join('\n');
    expect(output).toContain('another home');
    expect(output).toContain(homeA);
    expect(output).toContain(homeB);
    // No manual-kill instructions for someone else's daemon.
    expect(warnLines.join('\n')).not.toContain('xargs kill');
    // The note is dropped — no supervisor here will ever consume it.
    expect(fs.existsSync(path.join(homeB, 'stop-request.json'))).toBe(false);
  });

  it('honours the /api reported home without signalling when it names another home', async () => {
    const homeB = makeTempHome('agent-deck-stop-b-');
    const homeA = makeTempHome('agent-deck-stop-a-');
    const backendPort = 45721;
    const mcpPort = 45720;
    process.env.AGENT_DECK_HOME = homeB;
    process.env.AGENT_DECK_BACKEND_PORT = String(backendPort);
    process.env.AGENT_DECK_MCP_PORT = String(mcpPort);

    const killed: number[] = [];
    let pidHomeCalls = 0;
    const deps: StopDeps = {
      currentHome: homeB,
      readRunState: () => null,
      clearRunState: () => {},
      probeAgentDeck: async () => upProbe(backendPort, mcpPort),
      listListeningPids: () => [43421],
      isProcessAlive: () => true,
      kill: (pid) => {
        killed.push(pid);
      },
      getPidHome: () => {
        pidHomeCalls += 1;
        return homeB;
      },
      fetchReportedDaemonHome: async () => homeA,
      sleep: async () => {},
    };

    const code = await runStop({}, deps);

    expect(code).toBe(0);
    expect(killed).toEqual([]);
    // The daemon's own identity wins — no per-pid env lookup needed.
    expect(pidHomeCalls).toBe(0);
    expect(logLines.join('\n')).toContain(homeA);
  });

  it('fails closed when the listener home is unknown: no signal, exit 0', async () => {
    const homeB = makeTempHome('agent-deck-stop-b-');
    const backendPort = 45731;
    const mcpPort = 45730;
    process.env.AGENT_DECK_HOME = homeB;
    process.env.AGENT_DECK_BACKEND_PORT = String(backendPort);
    process.env.AGENT_DECK_MCP_PORT = String(mcpPort);

    const killed: number[] = [];
    const deps: StopDeps = {
      currentHome: homeB,
      readRunState: () => null,
      clearRunState: () => {},
      probeAgentDeck: async () => upProbe(backendPort, mcpPort),
      listListeningPids: () => [44421],
      isProcessAlive: () => true,
      kill: (pid) => {
        killed.push(pid);
      },
      getPidHome: () => null,
      fetchReportedDaemonHome: async () => null,
      sleep: async () => {},
    };

    const code = await runStop({}, deps);

    expect(code).toBe(0);
    expect(killed).toEqual([]);
    const output = logLines.join('\n');
    expect(output).toContain('another home');
    expect(output).toContain(homeB);
    expect(output).toContain('44421');
  });

  it('still SIGTERMs the supervisor recorded in the current home run.json', async () => {
    const home = makeTempHome('agent-deck-stop-own-');
    const backendPort = 45741;
    const mcpPort = 45740;
    process.env.AGENT_DECK_HOME = home;
    process.env.AGENT_DECK_BACKEND_PORT = String(backendPort);
    process.env.AGENT_DECK_MCP_PORT = String(mcpPort);

    const supervisorPid = 50001;
    const backendPid = 50002;
    const mcpPid = 50003;
    const alive = new Set([supervisorPid, backendPid, mcpPid]);
    const killed: number[] = [];
    let cleared = false;
    const deps: StopDeps = {
      currentHome: home,
      readRunState: () => ({
        host: '127.0.0.1',
        backendPort,
        mcpPort,
        backendPid,
        mcpPid,
        cliPid: supervisorPid,
        startedAt: new Date().toISOString(),
      }),
      clearRunState: () => {
        cleared = true;
      },
      probeAgentDeck: async () => downProbe(backendPort, mcpPort),
      listListeningPids: () => [],
      isProcessAlive: (pid) => alive.has(pid),
      kill: (pid) => {
        killed.push(pid);
        alive.delete(pid);
      },
      getPidHome: () => home,
      fetchReportedDaemonHome: async () => null,
      sleep: async () => {},
    };

    const code = await runStop({}, deps);

    expect(code).toBe(0);
    expect(killed).toContain(supervisorPid);
    expect(killed).toContain(backendPid);
    expect(killed).toContain(mcpPid);
    expect(cleared).toBe(true);
    expect(logLines.join('\n')).toContain('Agent Deck stopped.');
  });

  it('kills an unrecorded listener only when its home matches the current home', async () => {
    const home = makeTempHome('agent-deck-stop-same-');
    const backendPort = 45751;
    const mcpPort = 45750;
    process.env.AGENT_DECK_HOME = home;
    process.env.AGENT_DECK_BACKEND_PORT = String(backendPort);
    process.env.AGENT_DECK_MCP_PORT = String(mcpPort);

    const killed: number[] = [];
    let probes = 0;
    const deps: StopDeps = {
      currentHome: home,
      readRunState: () => null,
      clearRunState: () => {},
      probeAgentDeck: async () => {
        probes += 1;
        // Up until the fallback kills, then down.
        return probes <= 2 ? upProbe(backendPort, mcpPort) : downProbe(backendPort, mcpPort);
      },
      listListeningPids: (port) => (port === mcpPort ? [60001] : port === backendPort ? [60002] : []),
      isProcessAlive: () => true,
      kill: (pid) => {
        killed.push(pid);
      },
      getPidHome: () => home,
      fetchReportedDaemonHome: async () => null,
      sleep: async () => {},
    };

    const code = await runStop({}, deps);

    expect(code).toBe(0);
    expect(killed.sort((a, b) => a - b)).toEqual([60001, 60002]);
    expect(logLines.join('\n')).toContain('Agent Deck stopped.');
  });

  it('compares homes by resolved path and resolves env homes like the shared helper', () => {
    expect(sameAgentDeckHome('/tmp/x/', '/tmp/x')).toBe(true);
    expect(sameAgentDeckHome('/tmp/a', '/tmp/b')).toBe(false);
    expect(resolveHomeFromEnvVars({ AGENT_DECK_HOME: '/tmp/custom-home' })).toBe(
      path.resolve('/tmp/custom-home'),
    );
    const devHome = resolveHomeFromEnvVars({ AGENT_DECK_DEV: '1' });
    expect(devHome.endsWith(`${path.sep}.agent-deck${path.sep}dev`)).toBe(true);
  });

  it('formats the other-home message with both homes and the recovery command', () => {
    const message = formatOtherHomeMessage('/home-b', ['/home-a'], [], 1111, 1110);
    expect(message).toContain('another home');
    expect(message).toContain('/home-a');
    expect(message).toContain('/home-b');
    expect(message).toContain('AGENT_DECK_HOME=/home-a agent-deck stop');
  });
});
