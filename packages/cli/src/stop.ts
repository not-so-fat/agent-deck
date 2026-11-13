import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAgentDeckHome } from '@agent-deck/shared';
import { listListeningPids, probeAgentDeck } from './ports';
import { clearRunState, isProcessAlive, readRunState } from './runtime-state';
import { readCliBackendPort, parseCliMcpPort } from './defaults';
import { clearStopRequest, readStopRequest, recordStopRequest, writeLastStop } from './shutdown-reason';

export interface StopOptions {
  /** Who is asking — `agent-deck stop`, `menubar`, `api`, a wrapper script. */
  source?: string;
  /** Extra context for the log line (dashboard user, restart reason, ...). */
  detail?: string;
}

/** `agent-deck stop --source menubar --detail menu-bar-stop-item`. */
export function parseStopOptions(args: string[]): StopOptions {
  const options: StopOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--source') {
      options.source = args[++i];
    } else if (args[i] === '--detail') {
      options.detail = args[++i];
    }
  }
  return options;
}

/** SIGTERM has no sender, so the caller identifies itself. */
export function resolveStopSource(options: StopOptions = {}): { source: string; detail?: string } {
  const envSource = process.env.AGENT_DECK_STOP_SOURCE?.trim();
  const envDetail = process.env.AGENT_DECK_STOP_DETAIL?.trim();
  return {
    source: options.source ?? (envSource || 'agent-deck stop'),
    detail: options.detail ?? (envDetail || undefined),
  };
}

/** Injectable seams for tests — production callers pass no deps. */
export interface StopDeps {
  listListeningPids?: (port: number) => number[];
  probeAgentDeck?: typeof probeAgentDeck;
  readRunState?: typeof readRunState;
  clearRunState?: () => void;
  isProcessAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  getPidHome?: (pid: number) => string | null;
  fetchReportedDaemonHome?: (
    host: string,
    backendPort: number,
    mcpPort: number,
  ) => Promise<string | null>;
  currentHome?: string;
  sleep?: (ms: number) => Promise<void>;
}

type ResolvedStopDeps = {
  listListeningPids: (port: number) => number[];
  probeAgentDeck: typeof probeAgentDeck;
  readRunState: typeof readRunState;
  clearRunState: () => void;
  isProcessAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  getPidHome: (pid: number) => string | null;
  fetchReportedDaemonHome: (
    host: string,
    backendPort: number,
    mcpPort: number,
  ) => Promise<string | null>;
  currentHome: string;
  sleep: (ms: number) => Promise<void>;
};

function resolveDeps(deps: StopDeps = {}): ResolvedStopDeps {
  return {
    listListeningPids: deps.listListeningPids ?? listListeningPids,
    probeAgentDeck: deps.probeAgentDeck ?? probeAgentDeck,
    readRunState: deps.readRunState ?? readRunState,
    clearRunState: deps.clearRunState ?? clearRunState,
    isProcessAlive: deps.isProcessAlive ?? isProcessAlive,
    kill: deps.kill ?? ((pid, signal) => process.kill(pid, signal)),
    getPidHome: deps.getPidHome ?? getPidHome,
    fetchReportedDaemonHome: deps.fetchReportedDaemonHome ?? fetchReportedDaemonHome,
    currentHome: deps.currentHome ?? resolveAgentDeckHome(),
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

/** Same home, ignoring lexical differences (`./x` vs `x`, trailing slash). */
export function sameAgentDeckHome(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/**
 * Which home a process with this environment belongs to — the same resolution
 * as `resolveAgentDeckHome`, minus the test-runner guard (the target is
 * another process, not this test).
 */
export function resolveHomeFromEnvVars(env: NodeJS.ProcessEnv): string {
  if (env.AGENT_DECK_HOME?.trim()) {
    return path.resolve(env.AGENT_DECK_HOME.trim());
  }
  const base = path.join(os.homedir(), '.agent-deck');
  const flag = env.AGENT_DECK_DEV?.trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes') {
    return path.join(base, 'dev');
  }
  if (flag === '0' || flag === 'false' || flag === 'no') {
    return base;
  }
  return env.NODE_ENV === 'development' ? path.join(base, 'dev') : base;
}

/**
 * Environment of another process, best effort. Linux reads `/proc/<pid>/environ`;
 * macOS parses `ps eww` (which prints the environment after the command). Empty
 * means "shown, but no Agent Deck vars" (i.e. the default home); null means
 * "could not read" (Windows, permissions, truncated output) — fail closed.
 */
export function readPidEnviron(pid: number): Record<string, string> | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (process.platform !== 'win32') {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
      const env: Record<string, string> = {};
      for (const entry of raw.split('\0')) {
        const eq = entry.indexOf('=');
        if (eq > 0) {
          env[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
      }
      return env;
    } catch {
      // Not Linux, or unreadable — fall through to `ps`.
    }
  }
  if (process.platform === 'win32') {
    return null;
  }
  try {
    const output = execSync(`ps eww -p ${pid}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!output.includes('=')) {
      return null;
    }
    const env: Record<string, string> = {};
    // Values may contain spaces; each var runs until the next ` NAME=` or EOL.
    for (const name of ['AGENT_DECK_HOME', 'AGENT_DECK_DEV', 'NODE_ENV'] as const) {
      const match = new RegExp(`${name}=(.+?)(?=\\s[A-Z_][A-Z0-9_]*=|\\s*$)`).exec(output);
      if (match) {
        env[name] = match[1].trim();
      }
    }
    return env;
  } catch {
    return null;
  }
}

/** Home a listener belongs to, via its process environment — null when unknown. */
export function getPidHome(pid: number): string | null {
  const env = readPidEnviron(pid);
  if (!env) {
    return null;
  }
  try {
    return resolveHomeFromEnvVars(env);
  } catch {
    return null;
  }
}

/**
 * Home the daemon on these ports claims, via its public `/health` identity.
 * Current backends report no home (null) — the field is read future-proof so a
 * backend that starts reporting `home` is honoured without a CLI change.
 */
export async function fetchReportedDaemonHome(
  host: string,
  backendPort: number,
  mcpPort: number,
): Promise<string | null> {
  for (const url of [
    `http://${host}:${backendPort}/health`,
    `http://${host}:${mcpPort}/health`,
  ]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        continue;
      }
      const body = (await response.json()) as Record<string, unknown>;
      const raw = body.home ?? body.agentDeckHome ?? body.dataPath ?? body.dataDir;
      if (typeof raw === 'string' && raw.trim()) {
        return path.resolve(raw.trim());
      }
    } catch {
      // Next candidate.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

export function formatOtherHomeMessage(
  currentHome: string,
  otherHomes: string[],
  unknownPids: number[],
  backendPort: number,
  mcpPort: number,
): string {
  const where = `:${backendPort}/:${mcpPort}`;
  const known = [...new Set(otherHomes)];
  if (known.length > 0) {
    const pids = unknownPids.length > 0 ? ` (plus pid ${unknownPids.join(', ')} of unknown home)` : '';
    return (
      `[agent-deck] Daemon on ${where} belongs to another home (${known.join(', ')}), ` +
      `not ${currentHome}; leaving it running${pids}. ` +
      `To stop it, run with AGENT_DECK_HOME=${known[0]} agent-deck stop`
    );
  }
  const pids = unknownPids.length > 0 ? ` (pid ${unknownPids.join(', ')})` : '';
  return (
    `[agent-deck] Daemon on ${where} belongs to another home (not ${currentHome}); ` +
    `leaving it running${pids}. It is not recorded in ${currentHome}/run.json.`
  );
}

function terminatePid(
  pid: number,
  label: string,
  deps: Pick<ResolvedStopDeps, 'isProcessAlive' | 'kill'>,
): boolean {
  if (!deps.isProcessAlive(pid)) {
    return false;
  }
  try {
    deps.kill(pid, 'SIGTERM');
    console.log(`[agent-deck] Stopped ${label} (pid ${pid})`);
    return true;
  } catch (error) {
    console.warn(
      `[agent-deck] Could not stop ${label} (pid ${pid}): ${error instanceof Error ? error.message : error}`,
    );
    return false;
  }
}

/** Give the supervisor time to consume the stop note before deciding it never did. */
async function waitForSupervisorExit(
  pid: number | undefined,
  deps: Pick<ResolvedStopDeps, 'isProcessAlive' | 'sleep'>,
): Promise<void> {
  if (!pid || !deps.isProcessAlive(pid)) {
    return;
  }
  for (let i = 0; i < 20; i += 1) {
    await deps.sleep(100);
    if (!deps.isProcessAlive(pid)) {
      return;
    }
  }
}

/**
 * The supervisor takes the note at the top of its shutdown, which can be a few
 * ms behind its ports closing — and with no run.json there is no pid to wait on
 * at all. Concluding "nobody recorded this stop" too early would throw away the
 * attribution and overwrite the supervisor's own record.
 */
async function waitForStopRequestConsumed(
  deps: Pick<ResolvedStopDeps, 'sleep'>,
  attempts = 20,
): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (!readStopRequest()) {
      return true;
    }
    await deps.sleep(100);
  }
  return !readStopRequest();
}

async function waitForShutdown(
  host: string,
  backendPort: number,
  mcpPort: number,
  deps: Pick<ResolvedStopDeps, 'probeAgentDeck' | 'sleep'>,
): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const probe = await deps.probeAgentDeck(host, backendPort, mcpPort);
    if (!probe.backendUp && !probe.mcpUp) {
      return;
    }
    await deps.sleep(200);
  }
}

export async function runStop(options: StopOptions = {}, depsInput: StopDeps = {}): Promise<number> {
  const deps = resolveDeps(depsInput);
  const host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';
  const backendPort = readCliBackendPort();
  const mcpPort = parseCliMcpPort(process.env.AGENT_DECK_MCP_PORT);
  const currentHome = deps.currentHome;

  const state = deps.readRunState();
  const recordedPids = new Set(
    [state?.mcpPid, state?.backendPid, state?.cliPid].filter(
      (pid): pid is number => typeof pid === 'number' && pid > 0,
    ),
  );
  let stopped = 0;

  // Leave the note before the first signal: the supervisor consumes it while
  // shutting down so supervisor.log names this caller, not just "exit 0".
  const { source, detail } = resolveStopSource(options);
  recordStopRequest({ source, detail, targetPid: state?.cliPid ?? 0 });

  if (state) {
    if (terminatePid(state.mcpPid, 'MCP server', deps)) {
      stopped += 1;
    }
    if (terminatePid(state.backendPid, 'backend', deps)) {
      stopped += 1;
    }
    if (terminatePid(state.cliPid, 'CLI supervisor', deps)) {
      stopped += 1;
    }
    deps.clearRunState();
  }

  // NOT-605: a listener that is not ours must never get a signal. The fallback
  // below used to kill whatever held the configured ports — including the
  // production daemon when this ran with an isolated AGENT_DECK_HOME.
  let otherHomes: string[] = [];
  let unknownOtherPids: number[] = [];

  let probe = await deps.probeAgentDeck(host, backendPort, mcpPort);
  if (probe.backendUp || probe.mcpUp) {
    const listeners: Array<{ pid: number; label: string }> = [
      ...deps.listListeningPids(mcpPort).map((pid) => ({ pid, label: `listener on :${mcpPort}` })),
      ...deps.listListeningPids(backendPort).map((pid) => ({
        pid,
        label: `listener on :${backendPort}`,
      })),
    ];
    const toKill: Array<{ pid: number; label: string }> = [];
    let unrecorded: Array<{ pid: number; label: string }> = [];
    for (const entry of listeners) {
      if (recordedPids.has(entry.pid)) {
        toKill.push(entry);
      } else {
        unrecorded.push(entry);
      }
    }

    if (unrecorded.length > 0) {
      let reported: string | null = null;
      try {
        reported = await deps.fetchReportedDaemonHome(host, backendPort, mcpPort);
      } catch {
        reported = null;
      }
      if (reported && sameAgentDeckHome(reported, currentHome)) {
        toKill.push(...unrecorded);
        unrecorded = [];
      } else if (reported) {
        otherHomes.push(reported);
      } else {
        const stillUnknown: Array<{ pid: number; label: string }> = [];
        for (const entry of unrecorded) {
          let pidHome: string | null = null;
          try {
            pidHome = deps.getPidHome(entry.pid);
          } catch {
            pidHome = null;
          }
          if (pidHome && sameAgentDeckHome(pidHome, currentHome)) {
            toKill.push(entry);
          } else if (pidHome) {
            otherHomes.push(pidHome);
          } else {
            stillUnknown.push(entry);
          }
        }
        unrecorded = stillUnknown;
        unknownOtherPids = stillUnknown.map((entry) => entry.pid);
      }
    }

    const seen = new Set<number>();
    const dedupedToKill = toKill.filter((entry) => {
      if (seen.has(entry.pid)) {
        return false;
      }
      seen.add(entry.pid);
      return true;
    });
    for (const { pid, label } of dedupedToKill) {
      if (terminatePid(pid, label, deps)) {
        stopped += 1;
      }
    }
    if (dedupedToKill.length > 0) {
      await waitForShutdown(host, backendPort, mcpPort, deps);
      probe = await deps.probeAgentDeck(host, backendPort, mcpPort);
    }

    const otherStillUp =
      (probe.backendUp || probe.mcpUp) && (otherHomes.length > 0 || unrecorded.length > 0);
    if (otherStillUp && stopped === 0) {
      // Pure other-home case: nothing of ours to wait for, and no supervisor
      // here will ever consume the note — drop it and leave them running.
      clearStopRequest();
      console.log(
        formatOtherHomeMessage(currentHome, otherHomes, unknownOtherPids, backendPort, mcpPort),
      );
      return 0;
    }
  }

  await waitForSupervisorExit(state?.cliPid, deps);

  // Note still there ⇒ no supervisor recorded this stop (killed listeners
  // directly, or nothing was running). Record it so `status` still answers why.
  const supervisorTookTheNote = stopped > 0 && (await waitForStopRequestConsumed(deps));
  if (!supervisorTookTheNote) {
    clearStopRequest();
    if (stopped > 0) {
      writeLastStop({
        at: new Date().toISOString(),
        exitCode: 0,
        reason: `${source}${detail ? ` — ${detail}` : ''} (pid ${process.pid}); no supervisor shutdown recorded`,
        supervisorPid: state?.cliPid ?? 0,
      });
    }
  }

  if (probe.backendUp || probe.mcpUp) {
    // Mixed case: ours stopped, but the ports still answer for another home.
    // That is not a failure to report as "kill manually" — it is someone
    // else's daemon, still correctly running.
    if (otherHomes.length > 0 || unknownOtherPids.length > 0) {
      console.log(
        formatOtherHomeMessage(currentHome, otherHomes, unknownOtherPids, backendPort, mcpPort),
      );
      if (stopped > 0) {
        console.log('[agent-deck] Agent Deck stopped.');
      }
      return 0;
    }
    console.warn(
      '[agent-deck] Agent Deck still responds on configured ports. Kill remaining processes manually:',
    );
    console.warn(`  lsof -ti :${backendPort} -sTCP:LISTEN | xargs kill`);
    console.warn(`  lsof -ti :${mcpPort} -sTCP:LISTEN | xargs kill`);
    return 1;
  }

  if (stopped === 0) {
    console.log('[agent-deck] No running Agent Deck instance found.');
  } else {
    console.log('[agent-deck] Agent Deck stopped.');
  }

  return 0;
}
