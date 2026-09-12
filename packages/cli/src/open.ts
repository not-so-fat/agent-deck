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

Mints a short-lived dashboard bootstrap URL and opens the system browser.
The bare dashboard origin remains unauthorized without an existing session;
run agent-deck open whenever access needs to be restored.`);
}

export async function runOpenCommand(args: string[]): Promise<number> {
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
  const probe = await probeAgentDeck(host, backendPort, mcpPort);
  if (!probe.backendUp) {
    console.error('[agent-deck] Backend is not running. Start it first: agent-deck start');
    return 1;
  }

  const result = await openDashboardInBrowser(probe.backendUrl, parsed.path);
  if (result.code !== 0) {
    console.error(`[agent-deck] ${result.message ?? 'Failed to open dashboard'}`);
    return result.code;
  }
  console.log('Opened dashboard in your browser.');
  return 0;
}
