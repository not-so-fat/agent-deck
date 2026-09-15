import type { FastifyRequest } from 'fastify';

export function parseBearerToken(request: FastifyRequest | { headers: Record<string, unknown> }): string | null {
  const header = request.headers.authorization;
  if (!header || typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice('Bearer '.length).trim() || null;
}
