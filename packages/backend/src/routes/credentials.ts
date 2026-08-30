import { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import {
  ApiResponse,
  CreateCredentialSchema,
  CreateCredentialSimpleSchema,
  Credential,
  deriveCredentialDefaults,
  RotateCredentialSchema,
  UpdateCredentialSchema,
} from '@agent-deck/shared';
import { getServiceIconPath } from '../services/icon-resolver';
import {
  DashboardOnlyError,
  isDashboardClient,
  requireDashboardClient,
} from '../lib/client-scope';
import { AgentDeckContextError, resolveAgentDeckId } from '../lib/agent-deck-context';
import { PlaybookDependencyError } from '../playbooks/playbook-manager';

interface CredentialIdRequest {
  Params: { id: string };
}

function mimeFromIconBuffer(buffer: Buffer): string {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return 'image/jpeg';
  }
  if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) {
    return 'image/x-icon';
  }
  return 'application/octet-stream';
}

function dashboardOnlyResponse(error: unknown): { status: number; body: ApiResponse } {
  const message =
    error instanceof DashboardOnlyError
      ? error.message
      : error instanceof Error
        ? error.message
        : 'Unknown error';

  return {
    status: error instanceof DashboardOnlyError ? 403 : 400,
    body: { success: false, error: message },
  };
}

export async function registerCredentialRoutes(fastify: FastifyInstance) {
  // Metadata for all registered credentials (no secret values) — agent-safe for linking to decks
  fastify.get('/collection', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const credentials = await fastify.credentialManager.list();
      const response: ApiResponse<Credential[]> = {
        success: true,
        data: credentials,
      };
      return reply.send(response);
    } catch (error) {
      const response: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      return reply.status(500).send(response);
    }
  });

  // Full vault — dashboard only (human collection UI)
  fastify.get('/vault', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const credentials = await fastify.credentialManager.list();
      const response: ApiResponse<Credential[]> = {
        success: true,
        data: credentials,
      };
      return reply.send(response);
    } catch (error) {
      const { status, body } = dashboardOnlyResponse(error);
      return reply.status(status).send(body);
    }
  });

  // Bound-deck credentials only (agent-safe; requires workspace or deck-id context)
  fastify.get('/', async (request, reply) => {
    try {
      const deckId = await resolveAgentDeckId(request, fastify.db);
      const credentials = await fastify.credentialManager.listForDeck(deckId);
      const response: ApiResponse<Credential[]> = {
        success: true,
        data: credentials,
      };
      return reply.send(response);
    } catch (error) {
      const status = error instanceof AgentDeckContextError ? 400 : 500;
      const response: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      return reply.status(status).send(response);
    }
  });

  fastify.get<CredentialIdRequest>('/:id/icon', async (request, reply) => {
    try {
      const iconPath = getServiceIconPath(request.params.id);
      const buffer = await fs.readFile(iconPath);
      return reply.type(mimeFromIconBuffer(buffer)).send(buffer);
    } catch {
      return reply.status(404).send({
        success: false,
        error: 'Icon not found',
      });
    }
  });

  fastify.get<CredentialIdRequest>('/:id', async (request, reply) => {
    try {
      let credential: Credential | null;

      if (isDashboardClient(request)) {
        credential = await fastify.credentialManager.get(request.params.id);
      } else {
        const deckId = await resolveAgentDeckId(request, fastify.db);
        const onDeck = await fastify.credentialManager.isCredentialOnDeck(
          deckId,
          request.params.id,
        );
        credential = onDeck ? await fastify.credentialManager.get(request.params.id) : null;
      }

      if (!credential) {
        const response: ApiResponse = {
          success: false,
          error: isDashboardClient(request)
            ? 'Credential not found'
            : 'Credential not found on bound deck',
        };
        return reply.status(isDashboardClient(request) ? 404 : 403).send(response);
      }

      const response: ApiResponse<Credential> = {
        success: true,
        data: credential,
      };
      return reply.send(response);
    } catch (error) {
      const response: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      return reply.status(500).send(response);
    }
  });

  fastify.post('/', async (request, reply) => {
    try {
      requireDashboardClient(request);

      const simple = CreateCredentialSimpleSchema.safeParse(request.body);
      const input = simple.success
        ? CreateCredentialSchema.parse({
            ...deriveCredentialDefaults(simple.data.label),
            value: simple.data.value,
            docsUrl: simple.data.docsUrl,
          })
        : CreateCredentialSchema.parse(request.body);

      const credential = await fastify.credentialManager.create(input);

      const response: ApiResponse<Credential> = {
        success: true,
        data: credential,
      };
      return reply.status(201).send(response);
    } catch (error) {
      const { status, body } = dashboardOnlyResponse(error);
      return reply.status(status).send(body);
    }
  });

  fastify.put<CredentialIdRequest>('/:id', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const parsed = UpdateCredentialSchema.parse(request.body);
      const input = {
        ...parsed,
        ...(parsed.docsUrl === '' ? { docsUrl: undefined } : {}),
      };
      const credential = await fastify.credentialManager.update(request.params.id, input);

      if (!credential) {
        const response: ApiResponse = {
          success: false,
          error: 'Credential not found',
        };
        return reply.status(404).send(response);
      }

      const response: ApiResponse<Credential> = {
        success: true,
        data: credential,
      };
      return reply.send(response);
    } catch (error) {
      const { status, body } = dashboardOnlyResponse(error);
      return reply.status(status).send(body);
    }
  });

  fastify.post<CredentialIdRequest>('/:id/rotate', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const input = RotateCredentialSchema.parse(request.body);
      const credential = await fastify.credentialManager.rotate(request.params.id, input);

      if (!credential) {
        const response: ApiResponse = {
          success: false,
          error: 'Credential not found',
        };
        return reply.status(404).send(response);
      }

      const response: ApiResponse<Credential> = {
        success: true,
        data: credential,
      };
      return reply.send(response);
    } catch (error) {
      const { status, body } = dashboardOnlyResponse(error);
      return reply.status(status).send(body);
    }
  });

  fastify.delete<CredentialIdRequest>('/:id', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const deleted = await fastify.credentialManager.delete(request.params.id);
      if (!deleted) {
        const response: ApiResponse = {
          success: false,
          error: 'Credential not found',
        };
        return reply.status(404).send(response);
      }

      const response: ApiResponse = {
        success: true,
        message: 'Credential deleted successfully',
      };
      return reply.send(response);
    } catch (error) {
      if (error instanceof PlaybookDependencyError) {
        return reply.status(409).send({
          success: false,
          error: error.message,
          data: error.dependents,
        } satisfies ApiResponse);
      }
      const { status, body } = dashboardOnlyResponse(error);
      return reply.status(status).send(body);
    }
  });
}
