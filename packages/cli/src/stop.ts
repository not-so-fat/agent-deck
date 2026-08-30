import { listListeningPids, probeAgentDeck } from './ports';
import { clearRunState, isProcessAlive, readRunState } from './runtime-state';
import { readCliBackendPort, parseCliMcpPort } from './defaults';

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

async function waitForShutdown(host: string, backendPort: number, mcpPort: number): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const probe = await probeAgentDeck(host, backendPort, mcpPort);
    if (!probe.backendUp && !probe.mcpUp) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export async function runStop(): Promise<number> {
  const host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';
  const backendPort = readCliBackendPort();
  const mcpPort = parseCliMcpPort(process.env.AGENT_DECK_MCP_PORT);

  const state = readRunState();
  let stopped = 0;

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
