/**
 * NOT-375: MCP initialize response carries the initially assigned deck's
 * operating instructions as the server `instructions` field (a bootstrap hint
 * where the SDK/host surfaces it), while unassigned sessions keep the
 * existing recovery message. Empty instructions omit the field.
 */
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AGENT_DECK_DECK_ID_HEADER } from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import type { AgentDeckMCPServer } from '../mcp-server';
import { UNASSIGNED_DECK_MESSAGE } from '../mcp-unassigned';
import { PatchManager } from '../playbooks/patch-manager';
import { PlaybookManager } from '../playbooks/playbook-manager';
import { registerCredentialRoutes } from '../routes/credentials';
import { registerDeckRoutes } from '../routes/decks';
import { registerPlaybookPatchRoutes } from '../routes/playbook-patches';
import { registerPlaybookRoutes } from '../routes/playbooks';
import { registerScopeRoutes } from '../routes/scope';
import { registerServiceRoutes } from '../routes/services';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import { LiveDisplayRegistry } from '../scope/live-display-registry';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import type { ServiceManager } from '../services/service-manager';
import { postInitialize, startMcpServer } from './test-harness';

type InitializeBody = {
  result?: {
    protocolVersion?: string;
    serverInfo?: { name?: string };
    instructions?: unknown;
  };
};

describe('MCP initialize instructions (NOT-375)', () => {
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
    process.env.AGENT_DECK_STUB_SYNC = 'off';
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
    const deckAlpha = await db.createDeck({
      name: 'alpha',
      operatingInstructions: 'INITIALIZE-MARKER-ALPHA\n',
    });
    const deckBeta = await db.createDeck({ name: 'beta' });

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
      getAllServices: async () => [],
      getService: async () => null,
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
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    servers.push(fastify);

    const address = fastify.server.address();
    const backendPort =
      typeof address === 'object' && address && 'port' in address ? address.port : 0;

    return {
      backendUrl: `http://127.0.0.1:${backendPort}`,
      db,
      deckAlpha,
      deckBeta,
    };
  }

  it('assigned deck with non-empty instructions rides the initialize response', async () => {
    const { backendUrl, deckAlpha } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const init = await postInitialize(started.port, 1, 'vitest', {
      [AGENT_DECK_DECK_ID_HEADER]: deckAlpha.id,
    });
    expect(init.status).toBe(200);
    expect(init.headers.get('mcp-session-id')).toBeTruthy();

    const body = (await init.json()) as InitializeBody;
    expect(body.result?.serverInfo?.name).toBe('agent-deck-server');
    expect(body.result?.instructions).toBe('INITIALIZE-MARKER-ALPHA\n');
  });

  it('assigned deck with empty instructions omits the field', async () => {
    const { backendUrl, deckBeta } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const init = await postInitialize(started.port, 1, 'vitest', {
      [AGENT_DECK_DECK_ID_HEADER]: deckBeta.id,
    });
    expect(init.status).toBe(200);
    expect(init.headers.get('mcp-session-id')).toBeTruthy();

    const body = (await init.json()) as InitializeBody;
    expect(body.result).toBeDefined();
    expect(body.result ?? {}).not.toHaveProperty('instructions');
  });

  it('unassigned session still receives the existing recovery instructions', async () => {
    const { backendUrl } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const init = await postInitialize(started.port, 1);
    expect(init.status).toBe(200);
    expect(init.headers.get('mcp-session-id')).toBeTruthy();

    const body = (await init.json()) as InitializeBody;
    expect(body.result?.instructions).toBe(UNASSIGNED_DECK_MESSAGE);
  });

  it('concurrent initializes stay deck-scoped', async () => {
    const { backendUrl, deckAlpha, deckBeta } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const [initA, initB] = await Promise.all([
      postInitialize(started.port, 1, 'vitest', { [AGENT_DECK_DECK_ID_HEADER]: deckAlpha.id }),
      postInitialize(started.port, 2, 'vitest', { [AGENT_DECK_DECK_ID_HEADER]: deckBeta.id }),
    ]);
    expect(initA.status).toBe(200);
    expect(initB.status).toBe(200);
    expect(initA.headers.get('mcp-session-id')).toBeTruthy();
    expect(initB.headers.get('mcp-session-id')).toBeTruthy();
    expect(initA.headers.get('mcp-session-id')).not.toBe(initB.headers.get('mcp-session-id'));

    const [bodyA, bodyB] = (await Promise.all([initA.json(), initB.json()])) as InitializeBody[];
    expect(bodyA.result?.instructions).toBe('INITIALIZE-MARKER-ALPHA\n');
    expect(bodyB.result ?? {}).not.toHaveProperty('instructions');
  });
});
