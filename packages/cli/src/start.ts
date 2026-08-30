import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { resolveBackendEntry, resolveBackendRoot, resolveUiDist } from './paths';
import { assertSqliteNative, assertSupportedNodeVersion, getNodeMajor, verifySqliteNative } from './node-runtime';
import { formatPortConflict, isTcpPortOpen, listListeningPids, probeAgentDeck } from './ports';
import { clearRunState, writeRunState } from './runtime-state';
import { runStop } from './stop';
import { maybeAutoUpgradeOnStart, notifyIfUpdateAvailable } from './upgrade';
import { getAgentDeckVersion } from './version';
import { parseCliBackendPort, parseCliMcpPort } from './defaults';
import {
  detectInstallKind,
  localBinLauncherPath,
  readCurrentManagedVersion,
  readUpdateState,
  resolveCurrentVersionDir,
  runManagedCliEntryHooks,
} from './managed';
import {
  appendDaemonLogLine,
  openDaemonLogFd,
  resolveCliEntry,
  resolveDaemonLogPath,
  resolveDaemonLogsDir,
} from './daemon-logs';

export interface StartOptions {
  backendPort?: number;
  mcpPort?: number;
  openBrowser?: boolean;
  skipUi?: boolean;
  force?: boolean;
  /** Detach a background supervisor (survives terminal close). */
  daemon?: boolean;
  /** Internal: detached supervisor child (set via --_supervisor or AGENT_DECK_SUPERVISOR). */
  supervisor?: boolean;
}

type SpawnIoMode = 'inherit' | 'file';

const children: ChildProcess[] = [];
let shuttingDown = false;

function isSupervisorMode(options: StartOptions): boolean {
  return options.supervisor === true || process.env.AGENT_DECK_SUPERVISOR === '1';
}

async function waitForHealth(url: string, attempts = 60): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function resolveServiceStdio(label: 'backend' | 'mcp', ioMode: SpawnIoMode): StdioOptions {
  if (ioMode === 'inherit') {
    return 'inherit';
  }
  const fd = openDaemonLogFd(label);
  return ['ignore', fd, fd];
}

function spawnNodeService(
  label: 'backend' | 'mcp',
  entry: string,
  env: Record<string, string>,
  ioMode: SpawnIoMode,
): ChildProcess {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, ...env },
    stdio: resolveServiceStdio(label, ioMode),
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }
    const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
    const message = `[agent-deck] ${label} exited (${detail})`;
    if (ioMode === 'file') {
      appendDaemonLogLine('supervisor', `${new Date().toISOString()} ${message}`);
    } else {
      console.error(message);
    }
    if (label === 'backend') {
      void shutdown(code ?? 1);
      return;
    }
    const mcpWarn =
      '[agent-deck] MCP stopped; dashboard API remains available. Run `agent-deck stop && agent-deck start` to recover MCP.';
    if (ioMode === 'file') {
      appendDaemonLogLine('supervisor', `${new Date().toISOString()} ${mcpWarn}`);
    } else {
      console.warn(mcpWarn);
    }
  });

  children.push(child);
  return child;
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  if (isSupervisorMode({})) {
    appendDaemonLogLine(
      'supervisor',
      `${new Date().toISOString()} [agent-deck] supervisor shutting down (exit ${exitCode})`,
    );
  }

  clearRunState();

  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  process.exit(exitCode);
}

function printRunningEndpoints(host: string, backendPort: number, mcpPort: number, backendUrl: string): void {
  console.log('');
  console.log('Agent Deck is running');
  console.log(`  Dashboard  ${backendUrl}`);
  console.log(`  MCP        http://${host}:${mcpPort}/mcp`);
  console.log(`  API health ${backendUrl}/health`);
  console.log('');
  console.log('Claude Code:');
  console.log(`  claude mcp add --scope user --transport http agent-deck http://${host}:${mcpPort}/mcp`);
  console.log('');
}

function buildSupervisorArgs(options: StartOptions): string[] {
  const args = ['start', '--_supervisor'];
  if (options.skipUi) {
    args.push('--no-ui');
  }
  if (options.force) {
    args.push('--force');
  }
  if (options.backendPort !== undefined) {
    args.push('--port', String(options.backendPort));
  }
  if (options.mcpPort !== undefined) {
    args.push('--mcp-port', String(options.mcpPort));
  }
  return args;
}

async function runDaemonLauncher(options: StartOptions): Promise<number> {
  const backendPort = options.backendPort ?? parseCliBackendPort(process.env.AGENT_DECK_PORT);
  const mcpPort = options.mcpPort ?? parseCliMcpPort(process.env.AGENT_DECK_MCP_PORT);
  const host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';
  const backendUrl = `http://${host}:${backendPort}`;

  const supervisorLogFd = openDaemonLogFd('supervisor');
  const cliEntry = resolveCliEntry();

  const child = spawn(process.execPath, [cliEntry, ...buildSupervisorArgs(options)], {
    detached: true,
    stdio: ['ignore', supervisorLogFd, supervisorLogFd],
    env: { ...process.env, AGENT_DECK_SUPERVISOR: '1' },
  });

  child.unref();

  const healthy = await waitForHealth(`${backendUrl}/health`);
  if (!healthy) {
    console.error('[agent-deck] Daemon supervisor failed health check.');
    console.error(`[agent-deck] See ${resolveDaemonLogPath('supervisor')}`);
    return 1;
  }

  const mcpHealthy = await waitForHealth(`http://${host}:${mcpPort}/health`, 20);
  if (!mcpHealthy) {
    console.warn('[agent-deck] MCP not healthy yet — dashboard API is up.');
    console.warn(`[agent-deck] See ${resolveDaemonLogPath('mcp')}`);
  }

  console.log('');
  console.log('Agent Deck started in background');
  console.log(`  Dashboard  ${backendUrl}`);
  console.log(`  MCP        http://${host}:${mcpPort}/mcp`);
  console.log(`  Logs       ${resolveDaemonLogsDir()}/`);
  console.log('  Stop       agent-deck stop');
  console.log('');

  return 0;
}

async function ensurePortsAvailable(
  host: string,
  backendPort: number,
  mcpPort: number,
  probe: Awaited<ReturnType<typeof probeAgentDeck>>,
): Promise<number | null> {
  const [backendBusy, mcpBusy] = await Promise.all([
    isTcpPortOpen(host, backendPort),
    isTcpPortOpen(host, mcpPort),
  ]);

  if (backendBusy && !probe.backendUp) {
    console.error(`[agent-deck] ${formatPortConflict(backendPort, 'API/dashboard', host, false)}`);
    return 1;
  }

  if (mcpBusy && !probe.mcpUp) {
    console.error(`[agent-deck] ${formatPortConflict(mcpPort, 'MCP', host, false)}`);
    return 1;
  }

  return null;
}

export async function runStart(options: StartOptions = {}): Promise<number> {
  const nodeError = assertSupportedNodeVersion();
  if (nodeError !== null) {
    return nodeError;
  }
  const sqliteError = assertSqliteNative();
  if (sqliteError !== null) {
    return sqliteError;
  }

  await maybeAutoUpgradeOnStart();
  await notifyIfUpdateAvailable();

  const supervisor = isSupervisorMode(options);
  if (options.daemon && !supervisor) {
    const backendPort = options.backendPort ?? parseCliBackendPort(process.env.AGENT_DECK_PORT);
    const mcpPort = options.mcpPort ?? parseCliMcpPort(process.env.AGENT_DECK_MCP_PORT);
    const host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';

    const probe = await probeAgentDeck(host, backendPort, mcpPort);
    if (probe.backendUp && probe.mcpUp) {
      if (options.force) {
        console.log('[agent-deck] Restarting existing instance (--force) ...');
        await runStop();
        await new Promise((resolve) => setTimeout(resolve, 500));
      } else {
        printRunningEndpoints(host, backendPort, mcpPort, `http://${host}:${backendPort}`);
        console.log('Already running. Use `agent-deck stop` or `agent-deck start --daemon --force` to restart.');
        return 0;
      }
    }

    const refreshedProbe = options.force ? await probeAgentDeck(host, backendPort, mcpPort) : probe;
    const portError = await ensurePortsAvailable(host, backendPort, mcpPort, refreshedProbe);
    if (portError !== null) {
      return portError;
    }

    return runDaemonLauncher(options);
  }

  const ioMode: SpawnIoMode = supervisor ? 'file' : 'inherit';
  const backendPort = options.backendPort ?? parseCliBackendPort(process.env.AGENT_DECK_PORT);
  const mcpPort = options.mcpPort ?? parseCliMcpPort(process.env.AGENT_DECK_MCP_PORT);
  const host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';
  const backendUrl = `http://${host}:${backendPort}`;
  const uiDist = options.skipUi ? undefined : resolveUiDist();

  const probe = await probeAgentDeck(host, backendPort, mcpPort);

  if (probe.backendUp && probe.mcpUp) {
    if (options.force) {
      console.log('[agent-deck] Restarting existing instance (--force) ...');
      await runStop();
      await new Promise((resolve) => setTimeout(resolve, 500));
    } else {
      printRunningEndpoints(host, backendPort, mcpPort, backendUrl);
      console.log('Already running. Use `agent-deck stop` or `agent-deck start --force` to restart.');
      return 0;
    }
  }

  const refreshedProbe = options.force ? await probeAgentDeck(host, backendPort, mcpPort) : probe;
  const portError = await ensurePortsAvailable(host, backendPort, mcpPort, refreshedProbe);
  if (portError !== null) {
    return portError;
  }

  if (!options.skipUi && !uiDist) {
    const warnUi =
      '[agent-deck] Dashboard UI bundle not found (static-ui). API and MCP will still start.';
    const warnDist = '[agent-deck] Set AGENT_DECK_UI_DIST or run from a published npm package build.';
    if (ioMode === 'file') {
      appendDaemonLogLine('supervisor', warnUi);
      appendDaemonLogLine('supervisor', warnDist);
    } else {
      console.warn(warnUi);
      console.warn(warnDist);
    }
  }

  const backendEntry = resolveBackendEntry('index');
  const mcpEntry = resolveBackendEntry('mcp-index');

  const logStart = (line: string) => {
    if (ioMode === 'file') {
      appendDaemonLogLine('supervisor', `${new Date().toISOString()} ${line}`);
    } else {
      console.log(line);
    }
  };

  logStart('[agent-deck] Starting backend ...');
  const backendChild = spawnNodeService(
    'backend',
    backendEntry,
    {
      PORT: String(backendPort),
      HOST: host,
      NODE_ENV: 'production',
      AGENT_DECK_DEV: '0',
      AGENT_DECK_MCP_PORT: String(mcpPort),
      ...(uiDist ? { AGENT_DECK_UI_DIST: uiDist } : {}),
    },
    ioMode,
  );

  const healthy = await waitForHealth(`${backendUrl}/health`);
  if (!healthy) {
    const failMsg = '[agent-deck] Backend failed health check (port conflict or crash).';
    if (ioMode === 'file') {
      appendDaemonLogLine('supervisor', failMsg);
    } else {
      console.error(failMsg);
      console.error('[agent-deck] Run: agent-deck status');
    }
    await shutdown(1);
    return 1;
  }

  logStart('[agent-deck] Starting MCP server ...');
  let mcpPid = 0;

  if (refreshedProbe.mcpUp) {
    logStart('[agent-deck] MCP server already running — reusing existing instance');
    mcpPid = listListeningPids(mcpPort)[0] ?? 0;
  } else {
    const mcpChild = spawnNodeService(
      'mcp',
      mcpEntry,
      {
        AGENT_DECK_MCP_PORT: String(mcpPort),
        AGENT_DECK_BACKEND_URL: backendUrl,
        NODE_ENV: 'production',
        AGENT_DECK_DEV: '0',
      },
      ioMode,
    );

    await new Promise((resolve) => setTimeout(resolve, 400));
    const mcpProbe = await probeAgentDeck(host, backendPort, mcpPort);
    if (!mcpProbe.mcpUp) {
      const mcpFail =
        '[agent-deck] MCP server failed to start (port conflict or crash). Dashboard API is still running.';
      if (ioMode === 'file') {
        appendDaemonLogLine('supervisor', mcpFail);
      } else {
        console.error(mcpFail);
        console.error('[agent-deck] Run: agent-deck stop && agent-deck start');
      }
    } else {
      mcpPid = mcpChild.pid ?? 0;
    }
  }

  writeRunState({
    host,
    backendPort,
    mcpPort,
    backendPid: backendChild.pid ?? 0,
    mcpPid,
    cliPid: process.pid,
    startedAt: new Date().toISOString(),
  });

  const dashboardLine = uiDist ? backendUrl : '(UI bundle missing — use npm run dev:all for dev UI)';
  const runningLines = [
    '',
    'Agent Deck is running',
    `  Dashboard  ${dashboardLine}`,
    `  MCP        http://${host}:${mcpPort}/mcp`,
    `  API health ${backendUrl}/health`,
    '',
    'Claude Code:',
    `  claude mcp add --scope user --transport http agent-deck http://${host}:${mcpPort}/mcp`,
    '',
  ];

  if (ioMode === 'file') {
    for (const line of runningLines) {
      if (line) {
        appendDaemonLogLine('supervisor', line);
      }
    }
  } else {
    for (const line of runningLines) {
      console.log(line);
    }
  }

  if (options.openBrowser && uiDist) {
    const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    void (async () => {
      let target = backendUrl;
      try {
        const { readAdminSecret } = await import('./admin-secret');
        const secret = await readAdminSecret();
        if (secret) {
          const nonceRes = await fetch(`${backendUrl}/api/dashboard-auth/bootstrap/nonce`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${secret}` },
          });
          if (nonceRes.ok) {
            const body = (await nonceRes.json()) as { data?: { nonce?: string } };
            if (body.data?.nonce) {
              target = `${backendUrl}/?bootstrap=${encodeURIComponent(body.data.nonce)}`;
            }
          }
        }
      } catch {
        // open without bootstrap nonce
      }
      spawn(open, [target], { stdio: 'ignore', shell: process.platform === 'win32' });
    })();
  }

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  await new Promise<void>(() => {
    // keep alive until signal
  });
  return 0;
}

export async function runDoctor(): Promise<number> {
  const { activated } = runManagedCliEntryHooks({ allowActivate: true });
  if (activated) {
    console.log(`[agent-deck] Activated managed version ${activated}`);
  }

  const nodeMajor = getNodeMajor();
  let ok = true;

  console.log(`Node.js ${process.version}`);
  if (nodeMajor < 20) {
    console.error('FAIL: Node.js 20+ required (24 recommended — current OS default)');
    ok = false;
  } else if (!( [20, 22, 23, 24, 25, 26] as number[]).includes(nodeMajor)) {
    console.error('FAIL: Unsupported Node.js major for better-sqlite3 prebuilds');
    console.error('     Use Node 20+; Node 24 is the default target');
    ok = false;
  } else {
    console.log('OK: Node.js version');
  }

  const sqlite = verifySqliteNative();
  if (sqlite.ok) {
    console.log('OK: better-sqlite3 native module');
  } else {
    console.error('FAIL: better-sqlite3');
    console.error(sqlite.message);
    ok = false;
  }

  try {
    resolveBackendEntry('index');
    const backendRoot = resolveBackendRoot();
    console.log(`OK: backend at ${backendRoot}`);
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : error}`);
    ok = false;
  }

  const uiDist = resolveUiDist();
  if (uiDist) {
    console.log(`OK: dashboard UI at ${uiDist}`);
  } else {
    console.warn('WARN: dashboard UI bundle missing (optional for API/MCP)');
  }

  console.log(`Package version ${getAgentDeckVersion()}`);

  const kind = detectInstallKind();
  console.log(`Install kind: ${kind}`);
  if (kind === 'managed') {
    const current = readCurrentManagedVersion();
    const currentDir = resolveCurrentVersionDir();
    console.log(`Managed current: ${current ?? '(unknown)'} (${currentDir ?? 'missing'})`);
    console.log(`Launcher: ${localBinLauncherPath()}`);
    const pending = readUpdateState()?.pendingVersion;
    if (pending) {
      console.log(`Pending managed version: ${pending} (activates on next start/doctor/upgrade)`);
    }
  } else {
    console.log('Tip: agent-deck install  # managed CLI + auto-updates (decks/data unchanged)');
  }

  const host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';
  const backendPort = parseCliBackendPort(process.env.AGENT_DECK_PORT);
  const mcpPort = parseCliMcpPort(process.env.AGENT_DECK_MCP_PORT);
  const probe = await probeAgentDeck(host, backendPort, mcpPort);
  if (probe.backendUp && probe.mcpUp) {
    console.log(`OK: Agent Deck reachable on :${backendPort} / :${mcpPort}`);
  } else {
    console.warn('WARN: Agent Deck is not running (agent-deck start)');
  }

  return ok ? 0 : 1;
}
