import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  CreateDeckInput, 
  UpdateDeckInput,
  AddServiceToDeckInput,
  RemoveServiceFromDeckInput,
  ReorderDeckServicesInput,
  ApiResponse,
  Deck,
  DeckListEntry,
  PlaybookSummary,
  countDeckCards,
  trustedSessionError,
} from '@agent-deck/shared';
import {
  applyDeckScope,
  getClientScope,
  isDashboardClient,
} from '../lib/client-scope';
import {
  boundDeckScopeResponse,
  requireBoundDeckScope,
} from '../lib/bound-deck-scope';
import { AgentDeckContextError, resolveAgentDeckId, resolveAgentMode } from '../lib/agent-deck-context';
import { requireAgentAdmin, requireDashboard, RoutePolicyError, sendRoutePolicyError } from '../lib/route-policy';
import { resolveDeckRef } from '../lib/deck-resolve';
import { triggerWarningsForDeck } from '../playbooks/stub-workspace-sync';
import { CredentialManager } from '../vault/credential-manager';
import { ServiceHeaderVault } from '../vault/service-header-vault';
import { DatabaseManager } from '../models/database';
import { FileStoreWriter } from '../store/writer';

async function flushDeck(
  db: DatabaseManager,
  deckId: string,
  writer?: FileStoreWriter,
): Promise<void> {
  if (!writer) {
    return;
  }

  try {
    const deck = await db.getDeck(deckId);
    if (!deck) {
      throw new Error(`Deck not found after mutation: ${deckId}`);
    }
    await writer.writeDeck({
      id: deck.id,
      name: deck.name,
      serviceIds: deck.services.map(({ id }) => id),
      credentialIds: deck.credentials.map(({ id }) => id),
      playbookIds: deck.playbooks.map(({ id }) => id),
      createdAt: deck.createdAt,
      updatedAt: deck.updatedAt,
    });
  } catch (error) {
    console.error(`Failed to write deck ${deckId} to file store:`, error);
    throw error;
  }
}

async function deleteDeckFile(
  _db: DatabaseManager,
  deckId: string,
  writer?: FileStoreWriter,
): Promise<void> {
  if (!writer) {
    return;
  }

  try {
    await writer.deleteDeck(deckId);
  } catch (error) {
    console.error(`Failed to delete deck ${deckId} from file store:`, error);
    throw error;
  }
}

async function enrichDecksWithCredentialSecrets(
  credentialManager: CredentialManager,
  decks: Deck[],
): Promise<Deck[]> {
  return Promise.all(
    decks.map(async (deck) => ({
      ...deck,
      credentials: deck.credentials
        ? await credentialManager.applySecretStatus(deck.credentials)
        : [],
    })),
  );
}

/**
 * Overlay each deck service's secret headers (Authorization / API keys) from the
 * vault. Deck services come straight from a DB join, so — like single-service
 * reads — they must re-merge vault secrets for the dashboard. Agent responses are
 * still stripped downstream by {@link applyDeckScope}.
 */
async function enrichDeckServicesWithSecretHeaders(
  headerVault: ServiceHeaderVault | undefined,
  decks: Deck[],
): Promise<Deck[]> {
  if (!headerVault) {
    return decks;
  }
  return Promise.all(
    decks.map(async (deck) => ({
      ...deck,
      services: deck.services
        ? await Promise.all(
            deck.services.map(async (service) => {
              const secret = await headerVault.get(service.id);
              return secret
                ? { ...service, headers: { ...(service.headers ?? {}), ...secret } }
                : service;
            }),
          )
        : deck.services,
    })),
  );
}

interface CreateDeckRequest {
  Body: CreateDeckInput;
}

interface UpdateDeckRequest {
  Params: { id: string };
  Body: UpdateDeckInput;
}

interface DeckIdRequest {
  Params: { id: string };
}

interface AddServiceToDeckRequest {
  Params: { id: string };
  Body: { serviceId: string; position?: number };
}

interface RemoveServiceFromDeckRequest {
  Params: { id: string };
  Body: { serviceId: string };
}

interface ReorderDeckServicesRequest {
  Params: { id: string };
  Body: { serviceIds: string[] };
}

interface DeckRouteOptions {
  storeWriter?: FileStoreWriter;
}

export async function registerDeckRoutes(
  fastify: FastifyInstance,
  options: DeckRouteOptions,
) {
  const storeWriter = options.storeWriter;
  // Create deck
  fastify.post<CreateDeckRequest>('/', async (request, reply) => {
    try {
      if (!isDashboardClient(request)) {
        requireAgentAdmin(request);
      }
      const deck = await fastify.db.createDeck(request.body);
      await flushDeck(fastify.db, deck.id, storeWriter);
      
      const response: ApiResponse<Deck> = {
        success: true,
        data: deck,
      };
      
      return reply.status(201).send(response);
    } catch (error) {
      if (error instanceof RoutePolicyError) {
        return sendRoutePolicyError(reply, error);
      }
      const response: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      
      return reply.status(400).send(response);
    }
  });

  // Get all decks
  fastify.get('/', async (request, reply) => {
    try {
      const scope = getClientScope(request);

      if (scope === 'agent') {
        const mode = await resolveAgentMode(request);
        if (mode === 'agent-admin') {
          const decks = await fastify.db.getAllDecks();
          const list: DeckListEntry[] = decks.map((deck) => ({
            id: deck.id,
            name: deck.name,
            isActive: deck.isActive,
            cardCounts: countDeckCards(deck),
            workspaceCount: fastify.trustedSessionStore.countWorkspacesForDeck(deck.id),
          }));
          return reply.send({ success: true, data: list } satisfies ApiResponse<DeckListEntry[]>);
        }

        const visibleDeckId = await resolveAgentDeckId(request, fastify.db);
        const deck = await fastify.db.getDeck(visibleDeckId);
        if (!deck) {
          return reply.send({ success: true, data: [] } satisfies ApiResponse<DeckListEntry[]>);
        }
        const list: DeckListEntry[] = [{
          id: deck.id,
          name: deck.name,
          isActive: deck.isActive,
          cardCounts: countDeckCards(deck),
        }];
        return reply.send({ success: true, data: list } satisfies ApiResponse<DeckListEntry[]>);
      }

      let visibleDeckId: string | undefined;
      const decks = await fastify.db.getAllDecks();
      const decksWithSecrets = await enrichDeckServicesWithSecretHeaders(
        fastify.serviceHeaderVault,
        await enrichDecksWithCredentialSecrets(fastify.credentialManager, decks),
      );
      const scopedDecks = decksWithSecrets.map((deck) =>
        applyDeckScope(deck, scope, visibleDeckId),
      );

      const response: ApiResponse<Deck[]> = {
        success: true,
        data: scopedDecks,
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

  // Get active deck
  fastify.get('/active', async (request, reply) => {
    try {
      const deck = await fastify.db.getActiveDeck();

      if (!deck) {
        const response: ApiResponse = {
          success: false,
          error: 'No active deck found',
        };

        return reply.status(404).send(response);
      }

      const [deckWithSecrets] = getClientScope(request) === 'dashboard'
        ? await enrichDeckServicesWithSecretHeaders(
            fastify.serviceHeaderVault,
            await enrichDecksWithCredentialSecrets(fastify.credentialManager, [deck]),
          )
        : await enrichDecksWithCredentialSecrets(fastify.credentialManager, [deck]);

      const response: ApiResponse<Deck> = {
        success: true,
        data: deckWithSecrets,
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

  // Get deck by ID
  fastify.get<DeckIdRequest>('/:id', async (request, reply) => {
    try {
      const deck = await resolveDeckRef(fastify.db, request.params.id);
      
      if (!deck) {
        const response: ApiResponse = {
          success: false,
          error: 'Deck not found',
        };
        
        return reply.status(404).send(response);
      }

      const scope = getClientScope(request);
      let visibleDeckId: string | undefined;

      if (scope === 'agent') {
        visibleDeckId = await resolveAgentDeckId(request, fastify.db);
        if (deck.id !== visibleDeckId) {
          return reply
            .status(403)
            .send(trustedSessionError('RESOURCE_OUT_OF_SCOPE', 'Deck is outside the bound deck'));
        }
      }

      const [deckWithSecrets] = await enrichDeckServicesWithSecretHeaders(
        fastify.serviceHeaderVault,
        await enrichDecksWithCredentialSecrets(fastify.credentialManager, [deck]),
      );
      const scopedDeck = applyDeckScope(deckWithSecrets, scope, visibleDeckId);
      const playbookSummaries = await fastify.playbookManager.listSummariesForDeck(deck.id);

      const response: ApiResponse<Omit<Deck, 'playbooks'> & { playbooks: PlaybookSummary[] }> = {
        success: true,
        data: {
          ...scopedDeck,
          playbooks: playbookSummaries,
        },
      };

      return reply.send(response);
    } catch (error) {
      const scoped = boundDeckScopeResponse(error);
      if (scoped.error_code) {
        return reply.status(scoped.status).send(trustedSessionError(scoped.error_code, scoped.message));
      }
      return reply.status(scoped.status).send({
        success: false,
        error: scoped.message,
      } satisfies ApiResponse);
    }
  });

  // Update deck
  fastify.put<UpdateDeckRequest>('/:id', async (request, reply) => {
    try {
      const deck = await fastify.db.updateDeck(request.params.id, request.body);
      
      if (!deck) {
        const response: ApiResponse = {
          success: false,
          error: 'Deck not found',
        };
        
        return reply.status(404).send(response);
      }

      await flushDeck(fastify.db, deck.id, storeWriter);
      
      const response: ApiResponse<Deck> = {
        success: true,
        data: deck,
      };
      
      return reply.send(response);
    } catch (error) {
      const response: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      
      return reply.status(400).send(response);
    }
  });

  // Delete deck
  fastify.delete<DeckIdRequest>('/:id', async (request, reply) => {
    try {
      const deleted = await fastify.db.deleteDeck(request.params.id);
      
      if (!deleted) {
        const response: ApiResponse = {
          success: false,
          error: 'Deck not found',
        };
        
        return reply.status(404).send(response);
      }
      await deleteDeckFile(fastify.db, request.params.id, storeWriter);
      
      const response: ApiResponse = {
        success: true,
        message: 'Deck deleted successfully',
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

  // Set active deck
  fastify.post<DeckIdRequest>('/:id/activate', async (request, reply) => {
    try {
      await fastify.db.setActiveDeck(request.params.id);
      
      // Broadcast deck update via WebSocket
      fastify.broadcastDeckUpdate({
        deckId: request.params.id,
        action: 'updated',
        data: { isActive: true }
      });
      
      const response: ApiResponse = {
        success: true,
        message: 'Deck activated successfully',
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

  // Add service to deck
  fastify.post<AddServiceToDeckRequest>('/:id/services', async (request, reply) => {
    try {
      await requireBoundDeckScope(request, fastify.db, request.params.id);

      await fastify.db.addServiceToDeck({
        deckId: request.params.id,
        serviceId: request.body.serviceId,
        position: request.body.position,
      });
      await flushDeck(fastify.db, request.params.id, storeWriter);
      
      // Broadcast deck update via WebSocket
      fastify.broadcastDeckUpdate({
        deckId: request.params.id,
        action: 'service_added',
        data: { serviceId: request.body.serviceId }
      });
      
      const response: ApiResponse = {
        success: true,
        message: 'Service added to deck successfully',
      };
      
      return reply.send(response);
    } catch (error) {
      const scoped = boundDeckScopeResponse(error);
      const response: ApiResponse = {
        success: false,
        error: scoped.message,
        ...(scoped.error_code ? { error_code: scoped.error_code } : {}),
      };
      
      return reply.status(scoped.status).send(response);
    }
  });

  // Remove service from deck
  fastify.delete<RemoveServiceFromDeckRequest>('/:id/services', async (request, reply) => {
    try {
      await requireBoundDeckScope(request, fastify.db, request.params.id);

      await fastify.db.removeServiceFromDeck({
        deckId: request.params.id,
        serviceId: request.body.serviceId,
      });
      await flushDeck(fastify.db, request.params.id, storeWriter);
      
      // Broadcast deck update via WebSocket
      fastify.broadcastDeckUpdate({
        deckId: request.params.id,
        action: 'service_removed',
        data: { serviceId: request.body.serviceId }
      });
      
      const response: ApiResponse = {
        success: true,
        message: 'Service removed from deck successfully',
      };
      
      return reply.send(response);
    } catch (error) {
      const scoped = boundDeckScopeResponse(error);
      const response: ApiResponse = {
        success: false,
        error: scoped.message,
        ...(scoped.error_code ? { error_code: scoped.error_code } : {}),
      };
      
      return reply.status(scoped.status).send(response);
    }
  });

  // Reorder deck services
  fastify.put<ReorderDeckServicesRequest>('/:id/services/reorder', async (request, reply) => {
    try {
      await requireBoundDeckScope(request, fastify.db, request.params.id);

      await fastify.db.reorderDeckServices({
        deckId: request.params.id,
        serviceIds: request.body.serviceIds,
      });
      await flushDeck(fastify.db, request.params.id, storeWriter);
      
      // Broadcast deck update via WebSocket
      fastify.broadcastDeckUpdate({
        deckId: request.params.id,
        action: 'updated',
        data: { serviceIds: request.body.serviceIds }
      });
      
      const response: ApiResponse = {
        success: true,
        message: 'Deck services reordered successfully',
      };
      
      return reply.send(response);
    } catch (error) {
      const scoped = boundDeckScopeResponse(error);
      const response: ApiResponse = {
        success: false,
        error: scoped.message,
        ...(scoped.error_code ? { error_code: scoped.error_code } : {}),
      };
      
      return reply.status(scoped.status).send(response);
    }
  });

  // Clear all services from deck
  fastify.delete<DeckIdRequest>('/:id/services/clear', async (request, reply) => {
    try {
      await requireBoundDeckScope(request, fastify.db, request.params.id);

      await fastify.db.clearDeckServices(request.params.id);
      await flushDeck(fastify.db, request.params.id, storeWriter);
      
      // Broadcast deck update via WebSocket
      fastify.broadcastDeckUpdate({
        deckId: request.params.id,
        action: 'service_removed',
        data: { allServices: true }
      });
      
      const response: ApiResponse = {
        success: true,
        message: 'All services removed from deck successfully',
      };
      
      return reply.send(response);
    } catch (error) {
      const scoped = boundDeckScopeResponse(error);
      const response: ApiResponse = {
        success: false,
        error: scoped.message,
        ...(scoped.error_code ? { error_code: scoped.error_code } : {}),
      };
      
      return reply.status(scoped.status).send(response);
    }
  });

  // Add credential to deck
  fastify.post<{ Params: { id: string }; Body: { credentialId: string; position?: number } }>(
    '/:id/credentials',
    async (request, reply) => {
      try {
        await requireBoundDeckScope(request, fastify.db, request.params.id);

        await fastify.credentialManager.addToDeck({
          deckId: request.params.id,
          credentialId: request.body.credentialId,
          position: request.body.position,
        });
        await flushDeck(fastify.db, request.params.id, storeWriter);

        fastify.broadcastDeckUpdate({
          deckId: request.params.id,
          action: 'updated',
          data: { credentialId: request.body.credentialId },
        });

        const response: ApiResponse = {
          success: true,
          message: 'Credential added to deck successfully',
        };

        return reply.send(response);
      } catch (error) {
        const scoped = boundDeckScopeResponse(error);
        const response: ApiResponse = {
          success: false,
          error: scoped.message,
        };

        return reply.status(scoped.status).send(response);
      }
    },
  );

  // Remove credential from deck
  fastify.delete<{ Params: { id: string }; Body: { credentialId: string } }>(
    '/:id/credentials',
    async (request, reply) => {
      try {
        await requireBoundDeckScope(request, fastify.db, request.params.id);

        await fastify.credentialManager.removeFromDeck({
          deckId: request.params.id,
          credentialId: request.body.credentialId,
        });
        await flushDeck(fastify.db, request.params.id, storeWriter);

        fastify.broadcastDeckUpdate({
          deckId: request.params.id,
          action: 'updated',
          data: { credentialId: request.body.credentialId },
        });

        const response: ApiResponse = {
          success: true,
          message: 'Credential removed from deck successfully',
        };

        return reply.send(response);
      } catch (error) {
        const scoped = boundDeckScopeResponse(error);
        const response: ApiResponse = {
          success: false,
          error: scoped.message,
        };

        return reply.status(scoped.status).send(response);
      }
    },
  );

  // Add playbook to deck
  fastify.post<{ Params: { id: string }; Body: { playbookId: string; position?: number } }>(
    '/:id/playbooks',
    async (request, reply) => {
      try {
        await requireBoundDeckScope(request, fastify.db, request.params.id);

        await fastify.playbookManager.addToDeck({
          deckId: request.params.id,
          playbookId: request.body.playbookId,
          position: request.body.position,
        });
        await flushDeck(fastify.db, request.params.id, storeWriter);

        const playbook = await fastify.playbookManager.get(request.body.playbookId);
        const trigger_warnings = playbook
          ? await triggerWarningsForDeck(fastify.playbookManager, request.params.id, {
              id: playbook.id,
              title: playbook.title,
              triggers: playbook.triggers,
            })
          : [];

        fastify.broadcastDeckUpdate({
          deckId: request.params.id,
          action: 'updated',
          data: { playbookId: request.body.playbookId },
        });

        return reply.send({
          success: true,
          message: 'Playbook added to deck successfully',
          data: { trigger_warnings },
        } satisfies ApiResponse);
      } catch (error) {
        const scoped = boundDeckScopeResponse(error);
        return reply.status(scoped.status).send({
          success: false,
          error: scoped.message,
          ...(scoped.error_code ? { error_code: scoped.error_code } : {}),
        } satisfies ApiResponse);
      }
    },
  );

  // Remove playbook from deck
  fastify.delete<{ Params: { id: string }; Body: { playbookId: string } }>(
    '/:id/playbooks',
    async (request, reply) => {
      try {
        await requireBoundDeckScope(request, fastify.db, request.params.id);

        await fastify.playbookManager.removeFromDeck({
          deckId: request.params.id,
          playbookId: request.body.playbookId,
        });
        await flushDeck(fastify.db, request.params.id, storeWriter);

        fastify.broadcastDeckUpdate({
          deckId: request.params.id,
          action: 'updated',
          data: { playbookId: request.body.playbookId },
        });

        return reply.send({
          success: true,
          message: 'Playbook removed from deck successfully',
        } satisfies ApiResponse);
      } catch (error) {
        const scoped = boundDeckScopeResponse(error);
        return reply.status(scoped.status).send({
          success: false,
          error: scoped.message,
          ...(scoped.error_code ? { error_code: scoped.error_code } : {}),
        } satisfies ApiResponse);
      }
    },
  );
}
