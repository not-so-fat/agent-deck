import { execSync } from 'node:child_process';
import net from 'node:net';

/** Stale-session tally reported by the MCP server's `/health` (NOT-101). */
export interface McpSessionHealth {
  /** New on every MCP process start — a changed id means a restart happened. */
  instanceId?: string;
  startedAt?: string;
  liveSessions?: number;
  /** Requests rejected because they carried a session from a previous process. */
  staleSessionCount: number;
  staleSessionClients: number;
  staleSessionLastAt?: string;
}

export interface AgentDeckProbe {
  backendUp: boolean;
  mcpUp: boolean;
  backendVersion?: string;
  backendUrl: string;
  mcpUrl: string;
  mcpSessions?: McpSessionHealth;
}

async function fetchJson(url: string, timeoutMs = 2000): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function isTcpPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1500);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

export async function probeAgentDeck(
  host: string,
  backendPort: number,
  mcpPort: number,
): Promise<AgentDeckProbe> {
  const backendUrl = `http://${host}:${backendPort}`;
  const mcpUrl = `http://${host}:${mcpPort}`;

  const [backendHealth, mcpHealth] = await Promise.all([
    fetchJson(`${backendUrl}/health`),
    fetchJson(`${mcpUrl}/health`),
  ]);

  const backendUp =
    backendHealth?.status === 'ok' &&
    (backendHealth.service === 'agent-deck-backend' || typeof backendHealth.version === 'string');
  const mcpUp = mcpHealth?.service === 'agent-deck-mcp-server';

  return {
    backendUp,
    mcpUp,
    backendVersion: typeof backendHealth?.version === 'string' ? backendHealth.version : undefined,
    backendUrl,
    mcpUrl,
    mcpSessions: mcpUp ? readMcpSessionHealth(mcpHealth) : undefined,
  };
}

function readMcpSessionHealth(health: Record<string, unknown> | null): McpSessionHealth {
  const stale = (health?.staleSessions ?? {}) as Record<string, unknown>;
  const asCount = (value: unknown): number => (typeof value === 'number' ? value : 0);
  const asText = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;

  return {
    instanceId: asText(health?.instanceId),
    startedAt: asText(health?.startedAt),
    liveSessions: typeof health?.liveSessions === 'number' ? health.liveSessions : undefined,
    staleSessionCount: asCount(stale.count),
    staleSessionClients: asCount(stale.distinctSessions),
    staleSessionLastAt: asText(stale.lastAt),
  };
}

/**
 * Status lines for MCP sessions. A restart orphans every connected client, so a
 * non-zero stale tally is the difference between "running" and "running, and the
 * clients you already have open are talking to a session that no longer exists".
 */
export function formatMcpSessionStatus(sessions: McpSessionHealth | undefined): string[] {
  if (!sessions) {
    return [];
  }

  const lines: string[] = [];
  const live = sessions.liveSessions ?? 0;
  lines.push(`  Sessions   ${live} live${sessions.startedAt ? `  (since ${sessions.startedAt})` : ''}`);

  if (sessions.staleSessionCount > 0) {
    const clients =
      sessions.staleSessionClients === 1 ? '1 client' : `${sessions.staleSessionClients} clients`;
    lines.push(
      `  ⚠ Stale     ${clients} still using a session from before the last MCP restart` +
        `${sessions.staleSessionLastAt ? ` (last attempt ${sessions.staleSessionLastAt})` : ''}`,
    );
    lines.push('             Their tool calls fail with 404 until they re-initialize.');
    lines.push(
      '             agent-deck ≥1.8.3 bridges reconnect on their own; older bridges ' +
        '(supergateway) must be restarted with their host.',
    );
  }

  return lines;
}

export function listListeningPids(port: number): number[] {
  if (process.platform === 'win32') {
    return [];
  }

  try {
    const output = execSync(`lsof -ti :${port} -sTCP:LISTEN`, { encoding: 'utf8' }).trim();
    if (!output) {
      return [];
    }
    return output
      .split('\n')
      .map((value) => Number.parseInt(value, 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch {
    return [];
  }
}

export function formatPortConflict(
  port: number,
  label: string,
  host: string,
  isAgentDeck: boolean,
): string {
  const pids = listListeningPids(port);
  const pidHint =
    pids.length > 0
      ? ` Listening PID(s): ${pids.join(', ')}.`
      : process.platform === 'win32'
        ? ''
        : ` Check: lsof -i :${port}`;

  if (isAgentDeck) {
    return `Port ${port} (${label}) is already used by a running Agent Deck instance on ${host}.${pidHint}`;
  }

  return (
    `Port ${port} (${label}) is in use by another program on ${host}.${pidHint}\n` +
    `  • Free the port, or start on different ports: agent-deck start --port <api> --mcp-port <mcp>\n` +
    `  • If you change ports, re-run: agent-deck setup --client <cursor|claude>`
  );
}
