/**
 * NOT-304: coordinator read surface over a normal launch-selected session.
 *
 * A launch-selected MCP connection carrying x-agent-deck-correlation-id
 * attributes every playbook/service/credential usage event to that id, and
 * get_card_usage_events({ correlation_id }) returns exactly the bound
 * deck's events for it — dashboard-free, and never another deck's events.
 */
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_DECK_CORRELATION_HEADER,
  AGENT_DECK_DECK_ID_HEADER,
} from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import type { AgentDeckMCPServer } from '../mcp-server';
import { PatchManager } from '../playbooks/patch-manager';
import { PlaybookManager } from '../playbooks/playbook-manager';
import { registerCredentialRoutes } from '../routes/credentials';
import { registerDeckRoutes } from '../routes/decks';
import { registerPlaybookPatchRoutes } from '../routes/playbook-patches';
import { registerPlaybookRoutes } from '../routes/playbooks';
import { registerScopeRoutes } from '../routes/scope';
import { registerServiceRoutes } from '../routes/services';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import { registerUsageRoutes } from '../routes/usage';
import { LiveDisplayRegistry } from '../scope/live-display-registry';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import type { ServiceManager } from '../services/service-manager';
import {
  callToolMcpResult,
  listTools,
  openSession,
  startMcpServer,
} from './test-harness';

const CORRELATION = '123e4567-e89b-42d3-a456-426614174000';
const OTHER = 'dealer-run_other001';
const WIDE = { from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' };

describe('MCP card usage correlation (NOT-304)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];
  let mcpServer: AgentDeckMCPServer | undefined;
  let previousSkipDeckHeader: string | undefined;
  let previousSkipAdmin: string | undefined;
  let previousStubSync: string | undefined;

  beforeEach(() => {
    previousSkipDeckHeader = process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER;
    previousSkipAdmin = process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;
    previousStubSync = process.env.AGENT_DECK_STUB_SYNC;
    process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER = '0';
    process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK = '0';
    delete process.env.AGENT_DECK_STUB_SYNC;
  });

  afterEach(async () => {
    if (mcpServer) {
      await mcpServer.stop();
      mcpServer = undefined;
    }
    while (servers.length) {
      await servers.pop()?.close();
    }
    if (previousSkipDeckHeader === undefined) {
      delete process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER;
    } else {
      process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER = previousSkipDeckHeader;
    }
    if (previousSkipAdmin === undefined) {
      delete process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;
    } else {
      process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK = previousSkipAdmin;
    }
    if (previousStubSync === undefined) {
      delete process.env.AGENT_DECK_STUB_SYNC;
    } else {
      process.env.AGENT_DECK_STUB_SYNC = previousStubSync;
    }
  });

  async function buildListeningBackend() {
    const db = new DatabaseManager(':memory:');
    const deckA = await db.createDeck({ name: 'alpha' });
    const deckB = await db.createDeck({ name: 'beta' });

    const playbookA = await db.createPlaybook({
      id: 'pb_corr_a',
      title: 'corr-a',
      body: '## Gotchas\n- Keep it short.\n',
      triggers: ['corr'],
    });
    const playbookB = await db.createPlaybook({
      id: 'pb_corr_b',
      title: 'corr-b',
      body: '## Gotchas\n- Keep it short.\n',
      triggers: ['corr'],
    });
    await db.addPlaybookToDeck({ deckId: deckA.id, playbookId: playbookA.id, position: 0 });
    await db.addPlaybookToDeck({ deckId: deckB.id, playbookId: playbookB.id, position: 0 });

    const credential = await db.createCredential({
      id: 'cred-corr',
      label: 'corr key',
      scheme: 'bearer',
      envName: 'TEST_API_KEY',
      keychainAccount: 'cred-corr',
      tags: [],
      hasSecret: true,
    });
    const service = await db.createService({
      name: 'corr-svc',
      type: 'mcp',
      url: 'http://127.0.0.1:9/corr',
      credentialId: credential.id,
    });
    await db.addServiceToDeck({ deckId: deckA.id, serviceId: service.id, position: 0 });

    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const liveDisplayRegistry = new LiveDisplayRegistry();
    const playbookManager = new PlaybookManager(db);
    const patchManager = new PatchManager(db, playbookManager);

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('liveDisplayRegistry', liveDisplayRegistry);
    fastify.decorate('serviceManager', {
      discoverServiceTools: async () => [],
      callServiceTool: async () => ({ success: true, result: {} }),
      getAllServices: async () => [service],
      getService: async (id: string) => db.getService(id),
      updateToolSettings: async () => null,
    } as unknown as ServiceManager);
    fastify.decorate('credentialManager', {
      get: async () => null,
      listForDeck: async () => [],
      isCredentialOnDeck: async () => false,
      applySecretStatus: async (credentials: unknown[]) => credentials,
    });
    fastify.decorate('playbookManager', playbookManager);
    fastify.decorate('patchManager', patchManager);
    fastify.decorate('broadcastServiceUpdate', () => {});
    fastify.decorate('storeWriter', { writeDeck: async () => {} });

    registerHttpPolicyHook(fastify);
    await fastify.register(registerServiceRoutes, { prefix: '/api/services' });
    await fastify.register(registerPlaybookRoutes, { prefix: '/api/playbooks' });
    await fastify.register(registerPlaybookPatchRoutes, { prefix: '/api/playbook-patches' });
    await fastify.register(registerCredentialRoutes, { prefix: '/api/credentials' });
    await fastify.register(registerDeckRoutes, {
      prefix: '/api/decks',
      storeWriter: { writeDeck: async () => {} },
    });
    await fastify.register(registerTrustedSessionRoutes, { prefix: '/api/trusted-session' });
    await fastify.register(registerScopeRoutes, { prefix: '/api/scope' });
    await fastify.register(registerUsageRoutes, { prefix: '/api/usage' });
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    servers.push(fastify);

    const address = fastify.server.address();
    const backendPort =
      typeof address === 'object' && address && 'port' in address ? address.port : 0;

    return {
      backendUrl: `http://127.0.0.1:${backendPort}`,
      db,
      deckA,
      deckB,
      playbookA,
      playbookB,
      service,
      credential,
    };
  }

  function headersFor(deckId: string, correlation?: string) {
    return {
      [AGENT_DECK_DECK_ID_HEADER]: deckId,
      ...(correlation ? { [AGENT_DECK_CORRELATION_HEADER]: correlation } : {}),
    };
  }

  it('attributes every usage event to the launch correlation id', async () => {
    const { backendUrl, db, deckA, playbookA, service } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const headers = headersFor(deckA.id, CORRELATION);
    const sessionId = await openSession(started.port, 1, headers);

    const fetched = await callToolMcpResult(
      started.port,
      sessionId,
      'get_playbook',
      { playbook_id: playbookA.id },
      2,
      headers,
    );
    expect(fetched.isError).toBe(false);

    const called = await callToolMcpResult(
      started.port,
      sessionId,
      'call_service_tool',
      { serviceId: service.id, toolName: 'search', arguments: {} },
      3,
      headers,
    );
    expect(called.isError).toBe(false);

    // One playbook fetch + one service call (+ its credential event).
    const { events } = await db.listCardUsageEvents({ ...WIDE, limit: 50 });
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.correlationId).toBe(CORRELATION);
      expect(event.deckId).toBe(deckA.id);
    }
    expect(events.map((event) => event.cardType).sort()).toEqual(
      ['credential', 'playbook', 'service'].sort(),
    );
  });

  it('coordinator read returns only the bound deck events for the correlation id', async () => {
    const { backendUrl, db, deckA, deckB, playbookA, playbookB, service } =
      await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const headersA = headersFor(deckA.id, CORRELATION);
    const sessionA = await openSession(started.port, 1, headersA);
    await callToolMcpResult(
      started.port,
      sessionA,
      'get_playbook',
      { playbook_id: playbookA.id },
      2,
      headersA,
    );
    await callToolMcpResult(
      started.port,
      sessionA,
      'call_service_tool',
      { serviceId: service.id, toolName: 'search', arguments: {} },
      3,
      headersA,
    );

    // Same correlation id, other deck: a second worker's events. They share
    // the id but must never be observable from deck A's session.
    await db.recordCardUsageEvent({
      cardType: 'playbook',
      cardId: playbookB.id,
      deckId: deckB.id,
      action: 'fetch',
      success: true,
      source: 'agent',
      correlationId: CORRELATION,
      occurredAt: new Date().toISOString(),
    });

    // No dashboard authentication anywhere — a normal launch-selected
    // session reads its own run back.
    const tools = await listTools(started.port, sessionA, 4, headersA);
    expect(tools.map((tool) => tool.name)).toContain('get_card_usage_events');

    const read = await callToolMcpResult(
      started.port,
      sessionA,
      'get_card_usage_events',
      { correlation_id: CORRELATION },
      5,
      headersA,
    );
    expect(read.isError).toBe(false);
    const payload = read.data as {
      events: Array<{ cardId: string; deckId: string; correlationId: string }>;
      nextCursor: string | null;
    };
    expect(payload.events).toHaveLength(3);
    for (const event of payload.events) {
      expect(event.correlationId).toBe(CORRELATION);
      expect(event.deckId).toBe(deckA.id);
    }
    expect(payload.nextCursor).toBeNull();

    // And the deck-B session sees only its own event under the same id.
    const headersB = headersFor(deckB.id, CORRELATION);
    const sessionB = await openSession(started.port, 10, headersB);
    const readB = await callToolMcpResult(
      started.port,
      sessionB,
      'get_card_usage_events',
      { correlation_id: CORRELATION },
      11,
      headersB,
    );
    expect(readB.isError).toBe(false);
    const payloadB = readB.data as {
      events: Array<{ cardId: string; deckId: string }>;
    };
    expect(payloadB.events.map((event) => event.cardId)).toEqual([playbookB.id]);
    for (const event of payloadB.events) {
      expect(event.deckId).toBe(deckB.id);
    }
  });

  it('rejects an invalid correlation id without reading anything', async () => {
    const { backendUrl, deckA } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const headers = headersFor(deckA.id, CORRELATION);
    const sessionId = await openSession(started.port, 1, headers);

    const read = await callToolMcpResult(
      started.port,
      sessionId,
      'get_card_usage_events',
      { correlation_id: 'not-so-fat/agent_deck' },
      2,
      headers,
    );
    expect(read.isError).toBe(true);
  });

  it('keeps the first adopted correlation id when later headers change', async () => {
    const { backendUrl, db, deckA, playbookA } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const headers = headersFor(deckA.id, CORRELATION);
    const sessionId = await openSession(started.port, 1, headers);

    // A later request carrying a different id must not move attribution.
    const moved = headersFor(deckA.id, OTHER);
    const fetched = await callToolMcpResult(
      started.port,
      sessionId,
      'get_playbook',
      { playbook_id: playbookA.id },
      2,
      moved,
    );
    expect(fetched.isError).toBe(false);

    const { events } = await db.listCardUsageEvents({ ...WIDE, limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0].correlationId).toBe(CORRELATION);
  });

  it('leaves legacy sessions without the header at correlationId null', async () => {
    const { backendUrl, db, deckA, playbookA } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const headers = headersFor(deckA.id);
    const sessionId = await openSession(started.port, 1, headers);
    const fetched = await callToolMcpResult(
      started.port,
      sessionId,
      'get_playbook',
      { playbook_id: playbookA.id },
      2,
      headers,
    );
    expect(fetched.isError).toBe(false);

    const { events } = await db.listCardUsageEvents({ ...WIDE, limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0].correlationId).toBeNull();

    const read = await callToolMcpResult(
      started.port,
      sessionId,
      'get_card_usage_events',
      { correlation_id: CORRELATION },
      3,
      headers,
    );
    expect(read.isError).toBe(false);
    expect((read.data as { events: unknown[] }).events).toEqual([]);
  });
});
