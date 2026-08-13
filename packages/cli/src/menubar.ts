import path from 'node:path';
import type { LiveBinding } from '@agent-deck/shared';
import { resolveBackendPorts } from './statusline';

const DEFAULT_TIMEOUT_MS = 1500;
const NAME_MAX = 24;

export function truncateName(name: string, max = NAME_MAX): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

export function formatAge(lastActivityAt: string, now: Date): string {
  const then = new Date(lastActivityAt).getTime();
  if (Number.isNaN(then)) {
    return '';
  }
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/** SwiftBar/xbar output. `null` bindings = backend offline (accuracy first: dim, never guess). */
export function renderMenubar(bindings: LiveBinding[] | null, now: Date): string {
  if (bindings === null) {
    return ['◆ off | color=gray', '---', 'Agent Deck offline | color=gray', ''].join('\n');
  }

  if (bindings.length === 0) {
    return ['◆ —', '---', 'No live sessions — bind_workspace in an agent chat', ''].join('\n');
  }

  const title =
    bindings.length === 1
      ? `◆ ${truncateName(bindings[0].deckName)} ⌘${bindings[0].badge}`
      : `◆ ${bindings.length}`;

  const lines = [title, '---'];

  // Group by workspace; header/auto-bound sessions have no folder, so group
  // those under their deck name instead.
  const byGroup = new Map<string, { label: string; rows: LiveBinding[] }>();
  for (const row of bindings) {
    const key = row.workspaceRoot || `deck:${row.deckId}`;
    const label = row.workspaceRoot
      ? `${path.basename(row.workspaceRoot)}/`
      : `◆ ${truncateName(row.deckName)}`;
    const group = byGroup.get(key) ?? { label, rows: [] };
    group.rows.push(row);
    byGroup.set(key, group);
  }

  for (const key of [...byGroup.keys()].sort()) {
    const { label, rows: groupRows } = byGroup.get(key)!;
    lines.push(`${label} | size=11 color=gray`);
    const rows = [...groupRows].sort((a, b) =>
      a.lastActivityAt < b.lastActivityAt ? 1 : -1,
    );
    for (const row of rows) {
      const client = row.clientName ?? 'agent';
      const age = formatAge(row.lastActivityAt, now);
      const meta = age ? `${client} · ${age}` : client;
      lines.push(`● ${truncateName(row.deckName)} ⌘${row.badge} — ${meta} | font=Menlo`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

async function fetchBindings(backendUrl: string, timeoutMs: number): Promise<LiveBinding[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${backendUrl}/api/scope/bindings`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { success?: boolean; data?: LiveBinding[] };
    return body.success && Array.isArray(body.data) ? body.data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function runMenubar(): Promise<number> {
  const host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';
  const timeoutMs =
    Number.parseInt(process.env.AGENT_DECK_STATUSLINE_TIMEOUT_MS ?? '', 10) || DEFAULT_TIMEOUT_MS;

  for (const port of resolveBackendPorts()) {
    const bindings = await fetchBindings(`http://${host}:${port}`, timeoutMs);
    if (bindings !== null) {
      process.stdout.write(renderMenubar(bindings, new Date()));
      return 0;
    }
  }

  process.stdout.write(renderMenubar(null, new Date()));
  return 0;
}
