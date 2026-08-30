import type { WorkspaceGrantManifest } from '@agent-deck/shared';

import { parseCliBackendPort } from './defaults';
import { readAdminSecret } from './admin-secret';

export type IssuedGrant = {
  workspaceKey: string;
  grantId: string;
  deckId: string;
  deckName: string;
  secret: string;
};

function resolveBackendUrl(host: string): string {
  const port = parseCliBackendPort(process.env.AGENT_DECK_BACKEND_PORT);
  return `http://${host}:${port}`;
}

export async function issueWorkspaceGrant(input: {
  workspaceRoot: string;
  deckId: string;
  host?: string;
}): Promise<IssuedGrant | { error: string }> {
  const adminSecret = await readAdminSecret();
  if (!adminSecret) {
    return {
      error:
        'No admin secret — run `agent-deck setup` or `agent-deck start` once to initialize ~/.agent-deck/admin-secret',
    };
  }

  const backendUrl = resolveBackendUrl(input.host ?? process.env.AGENT_DECK_HOST ?? '127.0.0.1');
  const response = await fetch(`${backendUrl}/api/trusted-session/workspace-grants/issue`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminSecret}`,
      'Content-Type': 'application/json',
    },
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
