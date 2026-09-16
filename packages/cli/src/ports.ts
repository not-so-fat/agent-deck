import { execSync } from 'node:child_process';
import net from 'node:net';

/** Sessions from a previous MCP process, as `/health` tallies them (NOT-101). */
export interface McpStaleSessionTally {
  /** Requests rejected because they carried a session this process never issued. */
  count: number;
  /** How many distinct pre-restart sessions those requests came from. */
  distinctSessions: number;
  /** Of those, the ones whose client re-initialized on its own. */
  recoveredSessions?: number;
  /** The rest — nobody reconnected from them, so those clients are stranded. */
  unresolvedSessions?: number;
  lastAt?: string;
  lastUnresolvedAt?: string;
}

/**
 * MCP session health, field for field as the server reports it — one vocabulary
 * across the wire, the server, and `agent-deck status`.
 */
export interface McpSessionHealth {
  /** New on every MCP process start — a changed id means a restart happened. */
  instanceId?: string;
  startedAt?: string;
  liveSessions?: number;
  staleSessions: McpStaleSessionTally;
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

/** Read `/health` defensively — an older MCP server reports fewer fields. */
export function readMcpSessionHealth(health: Record<string, unknown> | null): McpSessionHealth {
  const stale = (health?.staleSessions ?? {}) as Record<string, unknown>;
  const asOptionalCount = (value: unknown): number | undefined =>
    typeof value === 'number' ? value : undefined;
  const asText = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;

  return {
    instanceId: asText(health?.instanceId),
    startedAt: asText(health?.startedAt),
    liveSessions: asOptionalCount(health?.liveSessions),
    staleSessions: {
      count: asOptionalCount(stale.count) ?? 0,
      distinctSessions: asOptionalCount(stale.distinctSessions) ?? 0,
      // Absent on a server that predates NOT-101: only the totals are known there.
      recoveredSessions: asOptionalCount(stale.recoveredSessions),
      unresolvedSessions: asOptionalCount(stale.unresolvedSessions),
      lastAt: asText(stale.lastAt),
      lastUnresolvedAt: asText(stale.lastUnresolvedAt),
    },
  };
}

/**
 * Status lines for MCP sessions. A restart orphans every connected client, so a
 * non-zero stale tally is the difference between "running" and "running, and the
 * clients you already have open are talking to a session that no longer exists".
 *
 * The tally is cumulative for the life of the process, so it cannot be read as
 * "clients are stranded right now" — a client that recovered still shows up in
 * it. Only the unresolved sessions (nobody re-initialized away from them) earn a
 * warning; the rest is reported as what it is, past activity.
 */
export function formatMcpSessionStatus(sessions: McpSessionHealth | undefined): string[] {
  if (!sessions) {
    return [];
  }

  const lines: string[] = [];
  const live = sessions.liveSessions ?? 0;
  lines.push(`  Sessions   ${live} live${sessions.startedAt ? `  (since ${sessions.startedAt})` : ''}`);

  const stale = sessions.staleSessions;
  if (stale.count === 0) {
    return lines;
  }

  // A server that predates recovery reporting only gives us the totals; treat
  // every stale session it saw as unresolved, which is what it meant back then.
  const unresolved = stale.unresolvedSessions ?? stale.distinctSessions;

  if (unresolved > 0) {
    const clients = unresolved === 1 ? '1 client' : `${unresolved} clients`;
    const lastAt = stale.lastUnresolvedAt ?? stale.lastAt;
    lines.push(
      `  ⚠ Stale     ${clients} still using a session from before the last MCP restart` +
        `${lastAt ? ` (last attempt ${lastAt})` : ''}`,
    );
    lines.push('             Their tool calls fail with 404 until they re-initialize.');
    lines.push(
      "             Agent Deck's own bridge reconnects; a supergateway bridge must be " +
        'restarted with its host.',
    );
    return lines;
  }

  const attempts = stale.count === 1 ? '1 request' : `${stale.count} requests`;
  const recovered = stale.recoveredSessions ?? stale.distinctSessions;
  lines.push(
    `  Recovered  ${recovered === 1 ? '1 client' : `${recovered} clients`} re-initialized after a ` +
      `restart (${attempts} rejected before they did${stale.lastAt ? `, last ${stale.lastAt}` : ''})`,
  );

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
