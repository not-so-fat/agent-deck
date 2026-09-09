import type { FastifyRequest } from 'fastify';

export function parseBearerToken(request: FastifyRequest | { headers: Record<string, unknown> }): string | null {
  const header = request.headers.authorization;
  if (!header || typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice('Bearer '.length).trim() || null;
}

export type WorkspaceGrantBearer = {
  /** Raw secret used for hash lookup (`mcp-launch` canonical form). */
  secret: string;
  /** Present when the client sent `wgr_…:secret`. */
  claimedGrantId: string | null;
};

/**
 * Workspace grants authenticate with the raw secret (`mcp-launch`).
 * Some manual clients send `grantId:secret` (`wgr_…:…`) — accept both and
 * surface the claimed grant id so callers can verify it matches the lookup.
 */
export function parseWorkspaceGrantBearer(token: string): WorkspaceGrantBearer {
  const trimmed = token.trim();
  const colon = trimmed.indexOf(':');
  if (colon > 0) {
    const maybeGrantId = trimmed.slice(0, colon);
    if (/^wgr_[A-Za-z0-9]+$/.test(maybeGrantId)) {
      return {
        secret: trimmed.slice(colon + 1),
        claimedGrantId: maybeGrantId,
      };
    }
  }
  return { secret: trimmed, claimedGrantId: null };
}

/** @deprecated Prefer parseWorkspaceGrantBearer — kept for call sites that only need the secret. */
export function normalizeWorkspaceGrantSecret(token: string): string {
  return parseWorkspaceGrantBearer(token).secret;
}
