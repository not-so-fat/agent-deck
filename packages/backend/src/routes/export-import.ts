import { FastifyInstance } from 'fastify';
import {
  ApiResponse,
  ExportRequestSchema,
  ImportReport,
  type BundleV1,
} from '@agent-deck/shared';
import {
  DashboardOnlyError,
  requireDashboardClient,
} from '../lib/client-scope';
import {
  buildExportBundle,
  ExportBundleError,
  importBundle,
  ImportBundleError,
} from '../export-import';
import { migrateSqliteToStore } from '../store/migrate';

function clientErrorResponse(error: unknown): { status: number; body: ApiResponse } {
  if (error instanceof DashboardOnlyError) {
    return { status: 403, body: { success: false, error: error.message } };
  }
  if (error instanceof ExportBundleError) {
    const notFound = error.message.startsWith('Deck not found');
    return {
      status: notFound ? 404 : 400,
      body: { success: false, error: error.message },
    };
  }
  if (error instanceof ImportBundleError) {
    return { status: 400, body: { success: false, error: error.message } };
  }
  const message = error instanceof Error ? error.message : 'Unknown error';
  return { status: 400, body: { success: false, error: message } };
}

export async function registerExportImportRoutes(fastify: FastifyInstance) {
  fastify.post('/export', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const input = ExportRequestSchema.parse(request.body ?? {});
      const bundle = await buildExportBundle(fastify.db, input);
      return reply.send({ success: true, data: bundle } satisfies ApiResponse<BundleV1>);
    } catch (error) {
      const { status, body } = clientErrorResponse(error);
      return reply.status(status).send(body);
    }
  });

  fastify.post('/import', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const report = await importBundle(fastify.db, request.body);
      if (report.status !== 'failed') {
        await migrateSqliteToStore(fastify.db, { force: true });
      }
      return reply.send({
        success: true,
        data: report,
      } satisfies ApiResponse<ImportReport>);
    } catch (error) {
      const { status, body } = clientErrorResponse(error);
      return reply.status(status).send(body);
    }
  });
}
