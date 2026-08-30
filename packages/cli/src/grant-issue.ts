import type { WorkspaceGrantManifest } from '@agent-deck/shared';

import { parseCliBackendPort } from './defaults';
import { readAdminSecret } from './admin-secret';

export type IssuedGrant = {
  workspaceKey: string;
  grantId: string;
  deckId: string;
  deckName: string;
  secret: string;
  status: 'pending' | 'active';
};

type TrustedWriterAuth =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; error: string };

function resolveBackendUrl(host: string): string {
  const port = parseCliBackendPort(process.env.AGENT_DECK_BACKEND_PORT);
  return `http://${host}:${port}`;
}

async function trustedWriterHeaders(_host?: string): Promise<TrustedWriterAuth> {
  const adminSecret = await readAdminSecret();
  if (!adminSecret) {
    return {
      ok: false,
      error:
        'No admin secret — run `agent-deck setup` or `agent-deck start` once to initialize ~/.agent-deck/admin-secret',
    };
  }
  return {
    ok: true,
    headers: {
      Authorization: `Bearer ${adminSecret}`,
      'Content-Type': 'application/json',
    },
  };
}

export async function issueWorkspaceGrant(input: {
  workspaceRoot: string;
  deckId: string;
  host?: string;
}): Promise<IssuedGrant | { error: string }> {
  const auth = await trustedWriterHeaders(input.host);
  if (!auth.ok) {
    return { error: auth.error };
  }

  const backendUrl = resolveBackendUrl(input.host ?? process.env.AGENT_DECK_HOST ?? '127.0.0.1');
  const response = await fetch(`${backendUrl}/api/trusted-session/workspace-grants/issue`, {
    method: 'POST',
    headers: auth.headers,
    body: JSON.stringify({
      workspaceRoot: input.workspaceRoot,
      deckId: input.deckId,
    }),
  });

  const payload = (await response.json()) as {
    success?: boolean;
    error?: string;
    data?: IssuedGrant;
  };

  if (!response.ok || !payload.success || !payload.data) {
    return { error: payload.error ?? `Grant issuance failed (${response.status})` };
  }

  return payload.data;
}

export async function activateWorkspaceGrant(input: {
  grantId: string;
  host?: string;
}): Promise<{ grantId: string; deckId: string; deckName?: string } | { error: string }> {
  const auth = await trustedWriterHeaders(input.host);
  if (!auth.ok) {
    return { error: auth.error };
  }

  const backendUrl = resolveBackendUrl(input.host ?? process.env.AGENT_DECK_HOST ?? '127.0.0.1');
  const response = await fetch(
    `${backendUrl}/api/trusted-session/workspace-grants/${encodeURIComponent(input.grantId)}/activate`,
    { method: 'POST', headers: auth.headers },
  );

  const payload = (await response.json()) as {
    success?: boolean;
    error?: string;
    data?: { grantId: string; deckId: string; deckName?: string };
  };

  if (!response.ok || !payload.success || !payload.data) {
    return { error: payload.error ?? `Grant activation failed (${response.status})` };
  }

  return payload.data;
}

export async function revokePendingWorkspaceGrant(input: {
  grantId: string;
  host?: string;
}): Promise<void | { error: string }> {
  const auth = await trustedWriterHeaders(input.host);
  if (!auth.ok) {
    return { error: auth.error };
  }

  const backendUrl = resolveBackendUrl(input.host ?? process.env.AGENT_DECK_HOST ?? '127.0.0.1');
  await fetch(
    `${backendUrl}/api/trusted-session/workspace-grants/${encodeURIComponent(input.grantId)}/revoke-pending`,
    { method: 'POST', headers: auth.headers },
  );
}

export function toGrantManifest(
  issued: IssuedGrant,
  mcpUrl: string,
  store: 'file' | 'keychain' = 'file',
): WorkspaceGrantManifest {
  return {
    version: 2,
    workspaceKey: issued.workspaceKey,
    grantId: issued.grantId,
    secret: issued.secret,
    deckId: issued.deckId,
    deckName: issued.deckName,
    mcpUrl,
    store,
    updatedAt: new Date().toISOString(),
  };
}
