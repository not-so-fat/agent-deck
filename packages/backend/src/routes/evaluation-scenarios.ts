import { FastifyInstance } from 'fastify';
import {
  ApiResponse,
  CreateEvaluationScenarioSchema,
  EvaluationScenarioIdSchema,
  ListEvaluationScenariosQuerySchema,
  UpdateEvaluationScenarioSchema,
  type EvaluationScenario,
} from '@agent-deck/shared';
import { ZodError } from 'zod';
import { DashboardOnlyError, requireDashboardClient } from '../lib/client-scope';

function mutationError(error: unknown): { status: number; message: string } {
  if (error instanceof DashboardOnlyError) {
    return { status: 403, message: error.message };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      message: error.issues.map((issue) => issue.message).join('; '),
    };
  }
  return {
    status: 400,
    message: error instanceof Error ? error.message : 'Invalid evaluation scenario',
  };
}

/** Human-curated evaluation evidence. Intentionally REST-only (no MCP tools). */
export async function registerEvaluationScenarioRoutes(fastify: FastifyInstance) {
  fastify.get<{
    Querystring: { targetPlaybookId?: string; status?: string };
  }>('/', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const query = ListEvaluationScenariosQuerySchema.parse(request.query);
      const scenarios = await fastify.db.listEvaluationScenarios(query);
      return reply.send({
        success: true,
        data: scenarios,
      } satisfies ApiResponse<EvaluationScenario[]>);
    } catch (error) {
      const mapped = mutationError(error);
      return reply.status(mapped.status).send({
        success: false,
        error: mapped.message,
      } satisfies ApiResponse);
    }
  });

  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const id = EvaluationScenarioIdSchema.parse(request.params.id);
      const scenario = await fastify.db.getEvaluationScenario(id);
      if (!scenario) {
        return reply.status(404).send({
          success: false,
          error: 'Evaluation scenario not found',
        } satisfies ApiResponse);
      }
      return reply.send({ success: true, data: scenario } satisfies ApiResponse<EvaluationScenario>);
    } catch (error) {
      const mapped = mutationError(error);
      return reply.status(mapped.status).send({
        success: false,
        error: mapped.message,
      } satisfies ApiResponse);
    }
  });

  fastify.post('/', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const input = CreateEvaluationScenarioSchema.parse(request.body);
      const scenario = await fastify.db.createEvaluationScenario(input);
      return reply.status(201).send({
        success: true,
        data: scenario,
      } satisfies ApiResponse<EvaluationScenario>);
    } catch (error) {
      const mapped = mutationError(error);
      return reply.status(mapped.status).send({
        success: false,
        error: mapped.message,
      } satisfies ApiResponse);
    }
  });

  fastify.put<{ Params: { id: string } }>('/:id', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const id = EvaluationScenarioIdSchema.parse(request.params.id);
      const input = UpdateEvaluationScenarioSchema.parse(request.body);
      const scenario = await fastify.db.updateEvaluationScenario(id, input);
      if (!scenario) {
        return reply.status(404).send({
          success: false,
          error: 'Evaluation scenario not found',
        } satisfies ApiResponse);
      }
      return reply.send({ success: true, data: scenario } satisfies ApiResponse<EvaluationScenario>);
    } catch (error) {
      const mapped = mutationError(error);
      return reply.status(mapped.status).send({
        success: false,
        error: mapped.message,
      } satisfies ApiResponse);
    }
  });
}
