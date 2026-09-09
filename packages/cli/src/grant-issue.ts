import type { WorkspaceGrantManifest } from '@agent-deck/shared';

import { readCliBackendPort } from './defaults';
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
  | { ok: true; authorization: string }
  | { ok: false; error: string };

function resolveBackendUrl(host: string): string {
  return `http://${host}:${readCliBackendPort()}`;
}

async function trustedWriterAuth(): Promise<TrustedWriterAuth> {
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
    authorization: `Bearer ${adminSecret}`,
  };
}

/** Prefer Fastify `message` / API `error` over a bare status phrase like "Bad Request". */
export function formatTrustedWriterError(
  status: number,
  payload: { error?: string; message?: string } | null,
  fallback: string,
): string {
  const detail = payload?.message?.trim() || payload?.error?.trim();
  if (detail && detail.toLowerCase() !== 'bad request' && detail.toLowerCase() !== 'error') {
    return detail;
  }
  if (payload?.error?.trim() && payload.error.trim().toLowerCase() !== 'bad request') {
    return payload.error.trim();
  }
  if (detail) {
    return `${detail} (${status})`;
  }
  return `${fallback} (${status})`;
}

async function readJsonPayload(response: Response): Promise<{
  success?: boolean;
  error?: string;
  message?: string;
  data?: unknown;
} | null> {
  try {
    return (await response.json()) as {
      success?: boolean;
      error?: string;
      message?: string;
      data?: unknown;
    };
  } catch {
    return null;
  }
}

export async function issueWorkspaceGrant(input: {
  workspaceRoot: string;
  deckId: string;
  host?: string;
}): Promise<IssuedGrant | { error: string }> {
  const auth = await trustedWriterAuth();
  if (!auth.ok) {
    return { error: auth.error };
  }

  const backendUrl = resolveBackendUrl(input.host ?? process.env.AGENT_DECK_HOST ?? '127.0.0.1');
  const response = await fetch(`${backendUrl}/api/trusted-session/workspace-grants/issue`, {
    method: 'POST',
    headers: {
      Authorization: auth.authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      workspaceRoot: input.workspaceRoot,
      deckId: input.deckId,
    }),
  });

  const payload = await readJsonPayload(response);
  const data = payload?.data as IssuedGrant | undefined;

  if (!response.ok || !payload?.success || !data) {
    return {
      error: formatTrustedWriterError(
        response.status,
        payload,
        'Grant issuance failed',
      ),
    };
  }

  return data;
}

export async function activateWorkspaceGrant(input: {
  grantId: string;
  host?: string;
}): Promise<{ grantId: string; deckId: string; deckName?: string } | { error: string }> {
  const auth = await trustedWriterAuth();
  if (!auth.ok) {
    return { error: auth.error };
  }

  const backendUrl = resolveBackendUrl(input.host ?? process.env.AGENT_DECK_HOST ?? '127.0.0.1');
  // Fastify rejects Content-Type: application/json with an empty body
  // (FST_ERR_CTP_EMPTY_JSON_BODY). Send {}.
  const response = await fetch(
    `${backendUrl}/api/trusted-session/workspace-grants/${encodeURIComponent(input.grantId)}/activate`,
    {
      method: 'POST',
      headers: {
        Authorization: auth.authorization,
        'Content-Type': 'application/json',
      },
      body: '{}',
    },
  );

  const payload = await readJsonPayload(response);
  const data = payload?.data as
    | { grantId: string; deckId: string; deckName?: string }
    | undefined;

  if (!response.ok || !payload?.success || !data) {
    return {
      error: formatTrustedWriterError(
        response.status,
        payload,
        'Grant activation failed',
      ),
    };
  }

  return data;
}

export async function revokePendingWorkspaceGrant(input: {
  grantId: string;
  host?: string;
}): Promise<void | { error: string }> {
  const auth = await trustedWriterAuth();
  if (!auth.ok) {
    return { error: auth.error };
  }

  const backendUrl = resolveBackendUrl(input.host ?? process.env.AGENT_DECK_HOST ?? '127.0.0.1');
  const response = await fetch(
    `${backendUrl}/api/trusted-session/workspace-grants/${encodeURIComponent(input.grantId)}/revoke-pending`,
    {
      method: 'POST',
      headers: {
        Authorization: auth.authorization,
        'Content-Type': 'application/json',
      },
      body: '{}',
    },
  );

  if (!response.ok) {
    const payload = await readJsonPayload(response);
    return {
      error: formatTrustedWriterError(
        response.status,
        payload,
        'Grant revoke-pending failed',
      ),
    };
  }
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
