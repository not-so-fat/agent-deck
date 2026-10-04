import type { FastifyInstance } from 'fastify';

export const DEFAULT_AUDIT_PAGE_LIMIT = 50;
export const MAX_AUDIT_PAGE_LIMIT = 100;

export async function registerAuditRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { limit?: string; before?: string } }>('/audit', async (request, reply) => {
    const limit = parseLimit(request.query?.limit);
    if (limit === null) {
      return reply.status(400).send({ success: false, error: 'limit must be an integer from 1 to 100' });
    }
    const before = request.query?.before?.trim() || undefined;
    const entries = fastify.auditStore.list({ limit, ...(before ? { before } : {}) });
    return reply.send({
      success: true,
      data: entries,
      paging: {
        limit,
        nextBefore: entries.length === limit ? entries.at(-1)?.id ?? null : null,
      },
    });
  });
}

function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return DEFAULT_AUDIT_PAGE_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return parsed >= 1 && parsed <= MAX_AUDIT_PAGE_LIMIT ? parsed : null;
}

