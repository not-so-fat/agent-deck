import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { resolveBackendEntry, resolveBackendRoot, resolveUiDist } from './paths';
import { checkStartPreflight, getNodeMajor, isSupportedNodeMajor, verifySqliteNative } from './node-runtime';
import { formatPortConflict, isTcpPortOpen, listListeningPids, probeAgentDeck } from './ports';
import { clearRunState, isProcessAlive, readRunState, writeRunState } from './runtime-state';
import { runStop } from './stop';
import { maybeAutoUpgradeOnStart, notifyIfUpdateAvailable } from './upgrade';
import { getAgentDeckVersion } from './version';
import { readCliBackendPort, parseCliMcpPort } from './defaults';
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
  formatChildLogTail,
  openDaemonLogFd,
  readDaemonLogTail,
  resolveCliEntry,
  resolveDaemonLogPath,
  resolveDaemonLogsDir,
  type DaemonLogName,
} from './daemon-logs';
import {
  clearLastStartFailure,
  composeShutdownReason,
  consumeStopRequest,
  describeSignalOrigin,
  formatSupervisorShutdownLine,
  readLastStartFailure,
  recordStartFailure,
  writeLastStop,
} from './shutdown-reason';
import {
  formatDashboardStatusLine,
  openDashboardInBrowser,
  shouldOpenDashboardByDefault,
} from './dashboard-open';

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

export function formatStartVersionLine(version = getAgentDeckVersion()): string {
  return `  Version    ${version}`;
}

export function formatClaudeMcpAddCommand(host: string, mcpPort: number): string {
  return `claude mcp add --scope user agent-deck -e AGENT_DECK_MCP_PORT=${mcpPort} -e AGENT_DECK_HOST=${host} -- agent-deck mcp-launch`;
}

type SpawnIoMode = 'inherit' | 'file';

/** A start that fails before the supervisor loop: one-line cause plus what to show. */
interface StartFailure {
  reason: string;
  lines: string[];
}

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

const children: ChildProcess[] = [];
let shuttingDown = false;
/** Only the process that wrote run.json may clear it — an aborted start must not. */
let ownsRunState = false;
/** Non-null until the deck is up: names the phase a stop interrupted. */
let startupPhase: string | null = null;

function isSupervisorMode(options: StartOptions): boolean {
  return options.supervisor === true || process.env.AGENT_DECK_SUPERVISOR === '1';
}

async function waitForHealth(
  url: string,
  attempts = 60,
  giveUp?: () => boolean,
): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (giveUp?.()) {
      return false;
    }
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

/**
 * Copy the child's own last words into supervisor.log. The child already logs
 * why it died, but the operator reading "backend exited (code 1)" is looking at
 * a different file — so bring the reason to them.
 */
function surfaceChildLogTail(label: DaemonLogName, ioMode: SpawnIoMode): void {
  if (ioMode !== 'file') {
    // Inherit mode already printed the child's output to this terminal.
    return;
  }
  for (const line of formatChildLogTail(label, readDaemonLogTail(label, 20))) {
    appendDaemonLogLine('supervisor', `${new Date().toISOString()} ${line}`);
  }
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
    if (signal || (code ?? 1) !== 0) {
      surfaceChildLogTail(label, ioMode);
    }
    if (label === 'backend') {
      void shutdown(code ?? 1, `backend exited (${detail})`);
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

/**
 * @param origin what this supervisor observed (a signal, a child exit, a failed
 *   start). Enriched with the requester's note when one was left behind, so the
 *   log names *who* stopped the deck and not just that it stopped.
 */
async function shutdown(exitCode = 0, origin = 'origin not recorded'): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  const request = consumeStopRequest({ supervisorPid: process.pid });
  const reason = composeShutdownReason(origin, request);
  const line = formatSupervisorShutdownLine(exitCode, reason);

  // supervisor.log answers "why did the deck stop?" for every run, daemon or
  // not — a Ctrl-C in inherit mode must not be the one stop with no record.
  try {
    appendDaemonLogLine('supervisor', `${new Date().toISOString()} ${line}`);
  } catch {
    // A shutdown never fails on its own bookkeeping.
  }
  if (!isSupervisorMode({})) {
    console.error(line);
  }

  writeLastStop({
    at: new Date().toISOString(),
    exitCode,
    reason,
    supervisorPid: process.pid,
  });

  clearOwnRunState();

  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  process.exit(exitCode);
}

/**
 * A start aborted before `writeRunState` never owned run.json, and deleting the
 * running instance's state would leave `status` and `stop` blind. A record whose
 * supervisor is gone is nobody's, though — that one is ours to clean up.
 */
function clearOwnRunState(): void {
  if (ownsRunState) {
    clearRunState();
    return;
  }
  const state = readRunState();
  if (state && (state.cliPid === process.pid || !isProcessAlive(state.cliPid))) {
    clearRunState();
  }
}

/** A signal that lands mid-startup names the phase it interrupted. */
function signalShutdownOrigin(signal: (typeof SHUTDOWN_SIGNALS)[number]): string {
  const origin = describeSignalOrigin(signal);
  return startupPhase ? `${origin} while starting (phase: ${startupPhase})` : origin;
}

/**
 * Installed before any startup work — preflight, upgrade checks and port probes
 * all await, and a stop arriving during them used to take Node's default exit
 * path: no shutdown line, no last-stop record, no origin.
 */
function installSupervisorSignalHandlers(): void {
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => void shutdown(0, signalShutdownOrigin(signal)));
  }
}

/**
 * `start --daemon` launcher: it owns no run state and no children, so it records
 * the interrupted start and leaves any supervisor it already spawned running.
 * Once the deck is up (`startupPhase === null`) this process is only printing —
 * interrupting it is not a failed start and must not be recorded as one.
 */
function installLauncherSignalHandlers(getSupervisorPid: () => number): void {
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      if (startupPhase === null) {
        process.exit(0);
      }
      const supervisorPid = getSupervisorPid();
      recordStartFailure({
        reason: `${describeSignalOrigin(signal)} while starting in background (phase: ${startupPhase})`,
        detail:
          supervisorPid > 0
            ? [
                `[agent-deck] background supervisor (pid ${supervisorPid}) was already spawned and keeps running — check agent-deck status`,
              ]
            : [],
      });
      process.exit(1);
    });
  }
}

/**
 * Print (unless stderr already *is* supervisor.log) and persist, so the reason
 * survives in supervisor.log and `agent-deck status`.
 */
function failStart(failure: StartFailure, supervisor: boolean): number {
  if (!supervisor) {
    for (const line of failure.lines) {
      console.error(line);
    }
  }
  return recordStartFailure({ reason: failure.reason, detail: failure.lines });
}

async function printRunningEndpoints(
  host: string,
  backendPort: number,
  mcpPort: number,
  backendUrl: string,
): Promise<void> {
  console.log('');
  console.log('Agent Deck is running');
  console.log(formatStartVersionLine());
  console.log(`  ${formatDashboardStatusLine()}`);
  console.log(`  MCP        http://${host}:${mcpPort}/mcp`);
  console.log(`  API health ${backendUrl}/health`);
  console.log('');
  console.log('Claude Code:');
  console.log(`  ${formatClaudeMcpAddCommand(host, mcpPort)}`);
  console.log('');
}

async function maybeOpenDashboard(backendUrl: string, openBrowser: boolean | undefined): Promise<void> {
  const shouldOpen = openBrowser ?? shouldOpenDashboardByDefault();
  if (!shouldOpen) {
    return;
  }
  const result = await openDashboardInBrowser(backendUrl);
  if (result.code !== 0) {
    console.warn(`[agent-deck] ${result.message ?? 'Failed to open dashboard'}`);
  }
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

async function runDaemonLauncher(
  options: StartOptions,
  onSupervisorSpawned: (pid: number) => void,
): Promise<number> {
  const backendPort = options.backendPort ?? readCliBackendPort();
  const mcpPort = options.mcpPort ?? parseCliMcpPort(process.env.AGENT_DECK_MCP_PORT);
  const host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';
  const backendUrl = `http://${host}:${backendPort}`;

  const supervisorLogFd = openDaemonLogFd('supervisor');
  const cliEntry = resolveCliEntry();
  const launchedAt = Date.now();

  const child = spawn(process.execPath, [cliEntry, ...buildSupervisorArgs(options)], {
    detached: true,
    stdio: ['ignore', supervisorLogFd, supervisorLogFd],
    env: { ...process.env, AGENT_DECK_SUPERVISOR: '1' },
  });

  onSupervisorSpawned(child.pid ?? 0);

  // Object, not a `let`: the exit arrives from a callback, and the reads below
  // are all after an await.
  const supervisor = { exit: null as string | null };
  child.on('exit', (code, signal) => {
    supervisor.exit = signal ? `signal ${signal}` : `code ${code ?? 1}`;
  });

  child.unref();

  // Waiting out the full health budget after the supervisor is already gone
  // only delays the diagnostic it just wrote.
  const healthy = await waitForHealth(`${backendUrl}/health`, 60, () => supervisor.exit !== null);
  if (!healthy) {
    const reason = supervisor.exit
      ? `daemon supervisor exited (${supervisor.exit}) before the API became healthy`
      : 'daemon supervisor never passed its API health check';
    console.error(`[agent-deck] ${reason}`);
    // The supervisor log already holds the reason (and the child log tail it
    // copied in) — show it here rather than sending the operator hunting.
    for (const line of formatChildLogTail('supervisor', readDaemonLogTail('supervisor', 20))) {
      console.error(line);
    }
    console.error(`[agent-deck] See ${resolveDaemonLogPath('supervisor')}`);

    // The supervisor child knows more than "it exited"; keep its record if it
    // got far enough to write one for this launch.
    const recorded = readLastStartFailure();
    const supervisorRecorded = recorded !== null && Date.parse(recorded.at) >= launchedAt;
    return recordStartFailure({ reason, keepExistingRecord: supervisorRecorded });
  }

  // The deck is up; everything past here is reporting, not starting.
  startupPhase = null;

  const mcpHealthy = await waitForHealth(`http://${host}:${mcpPort}/health`, 20);
  if (!mcpHealthy) {
    console.warn('[agent-deck] MCP not healthy yet — dashboard API is up.');
    console.warn(`[agent-deck] See ${resolveDaemonLogPath('mcp')}`);
  }

  console.log('');
  console.log('Agent Deck started in background');
  console.log(formatStartVersionLine());
  console.log(`  ${formatDashboardStatusLine()}`);
  console.log(`  MCP        http://${host}:${mcpPort}/mcp`);
  console.log(`  Logs       ${resolveDaemonLogsDir()}/`);
  console.log('  Stop       agent-deck stop');
  console.log('');

  if (options.openBrowser ?? shouldOpenDashboardByDefault()) {
    const result = await openDashboardInBrowser(backendUrl);
    if (result.code !== 0) {
      console.warn(`[agent-deck] ${result.message ?? 'Failed to open dashboard'}`);
    }
  }

  return 0;
}

function portConflictFailure(port: number, label: string, host: string): StartFailure {
  return {
    reason: `port ${port} (${label}) is held by another program on ${host}`,
    lines: formatPortConflict(port, label, host, false)
      .split('\n')
      .map((line) => `[agent-deck] ${line}`),
  };
}

async function ensurePortsAvailable(
  host: string,
  backendPort: number,
  mcpPort: number,
  probe: Awaited<ReturnType<typeof probeAgentDeck>>,
): Promise<StartFailure | null> {
  const [backendBusy, mcpBusy] = await Promise.all([
    isTcpPortOpen(host, backendPort),
    isTcpPortOpen(host, mcpPort),
  ]);

  if (backendBusy && !probe.backendUp) {
    return portConflictFailure(backendPort, 'API/dashboard', host);
  }

  if (mcpBusy && !probe.mcpUp) {
    return portConflictFailure(mcpPort, 'MCP', host);
  }

  return null;
}

export async function runStart(options: StartOptions = {}): Promise<number> {
  const supervisor = isSupervisorMode(options);
  const launcher = options.daemon === true && !supervisor;

  // Before the first await: preflight, upgrade checks and port probes all take
  // time, and a stop landing in that window used to kill this process through
  // Node's default signal path — no shutdown line, no origin, no record.
  startupPhase = 'preflight';
  let daemonSupervisorPid = 0;
  if (launcher) {
    installLauncherSignalHandlers(() => daemonSupervisorPid);
  } else {
    installSupervisorSignalHandlers();
  }

  const preflight = checkStartPreflight();
  if (preflight !== null) {
    return failStart({ reason: preflight.reason, lines: preflight.message.split('\n') }, supervisor);
  }

  startupPhase = 'update check';
  await maybeAutoUpgradeOnStart();
  await notifyIfUpdateAvailable();

  if (launcher) {
    startupPhase = 'probing for a running instance';
    const backendPort = options.backendPort ?? readCliBackendPort();
    const mcpPort = options.mcpPort ?? parseCliMcpPort(process.env.AGENT_DECK_MCP_PORT);
    const host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';

    const probe = await probeAgentDeck(host, backendPort, mcpPort);
    if (probe.backendUp && probe.mcpUp) {
      if (options.force) {
        console.log('[agent-deck] Restarting existing instance (--force) ...');
        await runStop({ source: 'agent-deck start --force', detail: 'restarting existing instance' });
        await new Promise((resolve) => setTimeout(resolve, 500));
      } else {
        await printRunningEndpoints(host, backendPort, mcpPort, `http://${host}:${backendPort}`);
        console.log('Already running. Use `agent-deck stop` or `agent-deck start --daemon --force` to restart.');
        await maybeOpenDashboard(`http://${host}:${backendPort}`, options.openBrowser);
        return 0;
      }
    }

    startupPhase = 'checking ports';
    const refreshedProbe = options.force ? await probeAgentDeck(host, backendPort, mcpPort) : probe;
    const portError = await ensurePortsAvailable(host, backendPort, mcpPort, refreshedProbe);
    if (portError !== null) {
      return failStart(portError, supervisor);
    }

    startupPhase = 'launching background supervisor';
    return runDaemonLauncher(options, (pid) => {
      daemonSupervisorPid = pid;
    });
  }

  const ioMode: SpawnIoMode = supervisor ? 'file' : 'inherit';
  const backendPort = options.backendPort ?? readCliBackendPort();
  const mcpPort = options.mcpPort ?? parseCliMcpPort(process.env.AGENT_DECK_MCP_PORT);
  const host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';
  const backendUrl = `http://${host}:${backendPort}`;
  const uiDist = options.skipUi ? undefined : resolveUiDist();

  startupPhase = 'probing for a running instance';
  const probe = await probeAgentDeck(host, backendPort, mcpPort);

  if (probe.backendUp && probe.mcpUp) {
    if (options.force) {
      console.log('[agent-deck] Restarting existing instance (--force) ...');
      await runStop({ source: 'agent-deck start --force', detail: 'restarting existing instance' });
      await new Promise((resolve) => setTimeout(resolve, 500));
    } else {
      await printRunningEndpoints(host, backendPort, mcpPort, backendUrl);
      console.log('Already running. Use `agent-deck stop` or `agent-deck start --force` to restart.');
      await maybeOpenDashboard(backendUrl, options.openBrowser);
      return 0;
    }
  }

  startupPhase = 'checking ports';
  const refreshedProbe = options.force ? await probeAgentDeck(host, backendPort, mcpPort) : probe;
  const portError = await ensurePortsAvailable(host, backendPort, mcpPort, refreshedProbe);
  if (portError !== null) {
    return failStart(portError, supervisor);
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

  startupPhase = 'resolving the backend build';
  let backendEntry: string;
  let mcpEntry: string;
  try {
    backendEntry = resolveBackendEntry('index');
    mcpEntry = resolveBackendEntry('mcp-index');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failStart({ reason: message, lines: [`[agent-deck] ${message}`] }, supervisor);
  }

  const logStart = (line: string) => {
    if (ioMode === 'file') {
      appendDaemonLogLine('supervisor', `${new Date().toISOString()} ${line}`);
    } else {
      console.log(line);
    }
  };

  startupPhase = 'starting backend';
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

  // A backend that exits takes the shutdown path immediately; polling out the
  // remaining health budget would only postpone this process's own exit.
  const healthy = await waitForHealth(`${backendUrl}/health`, 60, () => shuttingDown);
  if (!healthy) {
    if (shuttingDown) {
      // Something else (the backend's own exit, or a stop) already logged the
      // cause and is shutting down with its own exit code. Returning here would
      // race that exit and could report a failure for a requested stop; repeating
      // the tail would only double it in supervisor.log.
      await new Promise<void>(() => {
        // shutdown() exits this process.
      });
    }
    const failMsg = '[agent-deck] Backend failed health check (port conflict or crash).';
    if (ioMode === 'file') {
      appendDaemonLogLine('supervisor', `${new Date().toISOString()} ${failMsg}`);
    } else {
      console.error(failMsg);
      console.error(`[agent-deck] See ${resolveDaemonLogPath('backend')}`);
      console.error('[agent-deck] Run: agent-deck status');
    }
    surfaceChildLogTail('backend', ioMode);
    await shutdown(1, 'backend failed health check during start');
    return 1;
  }

  startupPhase = 'starting MCP server';
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
        appendDaemonLogLine('supervisor', `${new Date().toISOString()} ${mcpFail}`);
      } else {
        console.error(mcpFail);
        console.error(`[agent-deck] See ${resolveDaemonLogPath('mcp')}`);
        console.error('[agent-deck] Run: agent-deck stop && agent-deck start');
      }
      surfaceChildLogTail('mcp', ioMode);
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
  ownsRunState = true;
  startupPhase = null;
  clearLastStartFailure();

  const dashboardLine = uiDist
    ? formatDashboardStatusLine()
    : 'Dashboard  (UI bundle missing — use npm run dev:all for dev UI)';
  const runningLines = [
    '',
    'Agent Deck is running',
    formatStartVersionLine(),
    `  ${dashboardLine}`,
    `  MCP        http://${host}:${mcpPort}/mcp`,
    `  API health ${backendUrl}/health`,
    '',
    'Claude Code:',
    `  ${formatClaudeMcpAddCommand(host, mcpPort)}`,
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

  const shouldOpen = (options.openBrowser ?? shouldOpenDashboardByDefault()) && Boolean(uiDist);
  if (shouldOpen) {
    const result = await openDashboardInBrowser(backendUrl);
    if (result.code !== 0) {
      console.warn(`[agent-deck] ${result.message ?? 'Failed to open dashboard'}`);
    }
  }

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
  } else if (!isSupportedNodeMajor(nodeMajor)) {
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
  const backendPort = readCliBackendPort();
  const mcpPort = parseCliMcpPort(process.env.AGENT_DECK_MCP_PORT);
  const probe = await probeAgentDeck(host, backendPort, mcpPort);
  if (probe.backendUp && probe.mcpUp) {
    console.log(`OK: Agent Deck reachable on :${backendPort} / :${mcpPort}`);
  } else {
    console.warn('WARN: Agent Deck is not running (agent-deck start)');
  }

  return ok ? 0 : 1;
}
