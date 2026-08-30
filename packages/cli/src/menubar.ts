import path from 'node:path';

import type { LiveBinding, PendingAdminChallenge } from '@agent-deck/shared';
import { resolveBackendPorts } from './statusline';

const DEFAULT_TIMEOUT_MS = 1500;
const NAME_MAX = 24;

export function truncateName(name: string, max = NAME_MAX): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

export function formatTimeUntil(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return '';
  }
  const seconds = Math.max(0, Math.floor((then - now.getTime()) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
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

export function resolveDashboardBaseUrl(): string {
  const origin = process.env.AGENT_DECK_DASHBOARD_ORIGIN?.trim();
  if (origin) {
    return origin.replace(/\/$/, '');
  }
  return 'http://127.0.0.1:1111';
}

export function buildApprovalHref(challenge: PendingAdminChallenge, dashboardBaseUrl: string): string {
  const base = dashboardBaseUrl.replace(/\/$/, '');
  const pathPart = challenge.approvalPath.startsWith('/')
    ? challenge.approvalPath
    : `/${challenge.approvalPath}`;
  return `${base}${pathPart}`;
}

/** SwiftBar/xbar output. `null` bindings = backend offline (accuracy first: dim, never guess). */
export function renderMenubar(
  bindings: LiveBinding[] | null,
  now: Date,
  pendingApprovals: PendingAdminChallenge[] = [],
  dashboardBaseUrl = resolveDashboardBaseUrl(),
): string {
  if (bindings === null) {
    return ['◆ off | color=gray', '---', 'Agent Deck offline | color=gray', ''].join('\n');
  }

  const pendingCount = pendingApprovals.length;
  const title =
    pendingCount > 0
      ? `◆ ⚠ ${pendingCount}`
      : bindings.length === 1
        ? `◆ ${truncateName(bindings[0].deckName)} ⌘${bindings[0].badge}`
        : bindings.length === 0
          ? '◆ —'
          : `◆ ${bindings.length}`;

  const lines = [title, '---'];

  if (pendingCount > 0) {
    lines.push('Admin approval pending | size=11 color=orange');
    for (const challenge of pendingApprovals) {
      const deckLabel = challenge.deckName ? truncateName(challenge.deckName) : 'agent session';
      const age = formatTimeUntil(challenge.expiresAt, now);
      const meta = age ? `expires in ${age}` : 'pending';
      const href = buildApprovalHref(challenge, dashboardBaseUrl);
      lines.push(
        `⚠ Approve ${deckLabel} — ${meta} | href=${href}`,
      );
    }
    lines.push('---');
  }

  if (bindings.length === 0 && pendingCount === 0) {
    lines.push('No live sessions — bind_workspace in an agent chat', '');
    return lines.join('\n');
  }

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

async function fetchJson<T>(
  backendUrl: string,
  pathname: string,
  timeoutMs: number,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${backendUrl}${pathname}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { success?: boolean; data?: T };
    return body.success && body.data !== undefined ? body.data : null;
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
    const backendUrl = `http://${host}:${port}`;
    const bindings = await fetchJson<LiveBinding[]>(backendUrl, '/api/scope/bindings', timeoutMs);
    if (bindings !== null) {
      const pendingApprovals =
        (await fetchJson<PendingAdminChallenge[]>(
          backendUrl,
          '/api/trusted-session/admin/challenges',
          timeoutMs,
        )) ?? [];
      process.stdout.write(
        renderMenubar(bindings, new Date(), pendingApprovals, resolveDashboardBaseUrl()),
      );
      return 0;
    }
  }

  process.stdout.write(renderMenubar(null, new Date()));
  return 0;
}
