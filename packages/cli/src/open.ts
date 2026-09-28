import { readCliBackendPort } from './defaults';
import { openDashboardInBrowser } from './dashboard-open';
import { probeAgentDeck } from './ports';

export function parseOpenArgs(args: string[]): { path: string } | { error: string } {
  let pathAndQuery = '/';
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--path') {
      const raw = args[++i] ?? '';
      if (!raw) {
        return { error: '--path requires a value (e.g. / or /admin/approve?challenge=...)' };
      }
      try {
        pathAndQuery = decodeURIComponent(raw);
      } catch {
        pathAndQuery = raw;
      }
    } else if (arg === '--help' || arg === '-h') {
      return { error: 'help' };
    } else if (arg.startsWith('-')) {
      return { error: `Unknown open option: ${arg}` };
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }
  }
  return { path: pathAndQuery };
}

function printOpenUsage(): void {
  console.log(`Usage:
  agent-deck open [--path /admin/approve?...]

Starts the local backend when it is stopped, then mints a short-lived
dashboard bootstrap URL and opens the system browser.
The bare dashboard origin remains unauthorized without an existing session;
run agent-deck open whenever access needs to be restored.`);
}

export type OpenCommandDeps = {
  probeBackend?: typeof probeAgentDeck;
  startBackend?: (options: { backendPort: number; mcpPort: number }) => Promise<number>;
  openDashboard?: typeof openDashboardInBrowser;
};

/**
 * NOT-286: cold-open starter. Reuses the existing `runStart` daemon path so
 * `agent-deck open` never grows its own supervisor — it just asks for a
 * background deck without opening a second browser tab (`openBrowser: false`;
 * this command mints and opens its own bootstrap URL below). Lazily imported
 * so `open --help` and unit tests stay light.
 */
async function defaultStartBackend(options: { backendPort: number; mcpPort: number }): Promise<number> {
  const { runStart } = await import('./start');
  return runStart({ daemon: true, openBrowser: false, ...options });
}

export async function runOpenCommand(args: string[], deps: OpenCommandDeps = {}): Promise<number> {
  const parsed = parseOpenArgs(args);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      printOpenUsage();
      return 0;
    }
    console.error(parsed.error);
    printOpenUsage();
    return 1;
  }

  const host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';
  const backendPort = readCliBackendPort();
  const mcpPort = Number.parseInt(process.env.AGENT_DECK_MCP_PORT ?? '1110', 10) || 1110;
  const probeBackend = deps.probeBackend ?? probeAgentDeck;
  const startBackend = deps.startBackend ?? defaultStartBackend;
  const openDashboard = deps.openDashboard ?? openDashboardInBrowser;

  let probe = await probeBackend(host, backendPort, mcpPort);
  if (!probe.backendUp) {
    console.log('[agent-deck] Backend is not running. Starting it now ...');
    const startCode = await startBackend({ backendPort, mcpPort });
    if (startCode !== 0) {
      console.error(
        '[agent-deck] Could not start the backend. Run `agent-deck status` for the cause, then retry `agent-deck open`.',
      );
      return startCode;
    }
    probe = await probeBackend(host, backendPort, mcpPort);
    if (!probe.backendUp) {
      console.error(
        '[agent-deck] The backend started but is not answering yet. Run `agent-deck status`, then retry `agent-deck open`.',
      );
      return 1;
    }
  }

  const result = await openDashboard(probe.backendUrl, parsed.path);
  if (result.code !== 0) {
    console.error(`[agent-deck] ${result.message ?? 'Failed to open dashboard'}`);
    return result.code;
  }
  console.log('Opened dashboard in your browser.');
  return 0;
}
