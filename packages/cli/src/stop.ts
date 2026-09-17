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

/** SIGTERM has no sender, so the caller identifies itself. */
export function resolveStopSource(options: StopOptions = {}): { source: string; detail?: string } {
  const envSource = process.env.AGENT_DECK_STOP_SOURCE?.trim();
  const envDetail = process.env.AGENT_DECK_STOP_DETAIL?.trim();
  return {
    source: options.source ?? (envSource || 'agent-deck stop'),
    detail: options.detail ?? (envDetail || undefined),
  };
}

function terminatePid(pid: number, label: string): boolean {
  if (!isProcessAlive(pid)) {
    return false;
  }
  try {
    process.kill(pid, 'SIGTERM');
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
async function waitForSupervisorExit(pid: number | undefined): Promise<void> {
  if (!pid || !isProcessAlive(pid)) {
    return;
  }
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!isProcessAlive(pid)) {
      return;
    }
  }
}

async function waitForShutdown(host: string, backendPort: number, mcpPort: number): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const probe = await probeAgentDeck(host, backendPort, mcpPort);
    if (!probe.backendUp && !probe.mcpUp) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export async function runStop(options: StopOptions = {}): Promise<number> {
  const host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';
  const backendPort = readCliBackendPort();
  const mcpPort = parseCliMcpPort(process.env.AGENT_DECK_MCP_PORT);

  const state = readRunState();
  let stopped = 0;

  // Leave the note before the first signal: the supervisor consumes it while
  // shutting down so supervisor.log names this caller, not just "exit 0".
  const { source, detail } = resolveStopSource(options);
  recordStopRequest({ source, detail, targetPid: state?.cliPid ?? 0 });

  if (state) {
    if (terminatePid(state.mcpPid, 'MCP server')) {
      stopped += 1;
    }
    if (terminatePid(state.backendPid, 'backend')) {
      stopped += 1;
    }
    if (terminatePid(state.cliPid, 'CLI supervisor')) {
      stopped += 1;
    }
    clearRunState();
  }

  let probe = await probeAgentDeck(host, backendPort, mcpPort);
  if (probe.backendUp || probe.mcpUp) {
    for (const pid of listListeningPids(mcpPort)) {
      if (terminatePid(pid, `listener on :${mcpPort}`)) {
        stopped += 1;
      }
    }
    for (const pid of listListeningPids(backendPort)) {
      if (terminatePid(pid, `listener on :${backendPort}`)) {
        stopped += 1;
      }
    }
    await waitForShutdown(host, backendPort, mcpPort);
    probe = await probeAgentDeck(host, backendPort, mcpPort);
  }

  await waitForSupervisorExit(state?.cliPid);

  // Note still there ⇒ no supervisor recorded this stop (killed listeners
  // directly, or nothing was running). Record it so `status` still answers why.
  if (readStopRequest()) {
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
