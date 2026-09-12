/**
 * NOT-84: authenticated MCP session isolation + idempotent same-deck bind.
 * Runs with SKIP_GRANT_AUTH and SKIP_ADMIN_CHECK disabled against the real HTTP policy layer.
 */
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_DECK_SESSION_HEADER,
  canonicalizeWorkspacePath,
  digestCanonicalWorkspacePath,
  generateId,
} from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import type { AgentDeckMCPServer } from '../mcp-server';
import { registerCredentialRoutes } from '../routes/credentials';
import { registerDeckRoutes } from '../routes/decks';
import { registerPlaybookRoutes } from '../routes/playbooks';
import { registerScopeRoutes } from '../routes/scope';
import { registerServiceRoutes } from '../routes/services';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import { LiveDisplayRegistry } from '../scope/live-display-registry';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore, generateGrantSecret } from '../trusted-session/store';
import type { ServiceManager } from '../services/service-manager';
import {
  callToolMcpResult,
  openSession,
  startMcpServer,
} from './test-harness';

type ScopeHit = { endpoint: string; runtimeSessionId: string | undefined };

describe('MCP session-local context (NOT-84)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];
  let mcpServer: AgentDeckMCPServer | undefined;
  let previousSkipGrant: string | undefined;
  let previousSkipAdmin: string | undefined;
  let previousStubSync: string | undefined;

  beforeEach(() => {
    previousSkipGrant = process.env.AGENT_DECK_MCP_SKIP_GRANT_AUTH;
    previousSkipAdmin = process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;
    previousStubSync = process.env.AGENT_DECK_STUB_SYNC;
    process.env.AGENT_DECK_MCP_SKIP_GRANT_AUTH = '0';
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
    if (previousSkipGrant === undefined) {
      delete process.env.AGENT_DECK_MCP_SKIP_GRANT_AUTH;
    } else {
      process.env.AGENT_DECK_MCP_SKIP_GRANT_AUTH = previousSkipGrant;
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

  async function buildListeningBackend(opts?: {
    delayScopeDeckMs?: number;
    onScopeHit?: (hit: ScopeHit) => void;
  }) {
    const db = new DatabaseManager(`:memory:${Math.random()}`);
    const deckAlpha = await db.createDeck({ name: 'alpha' });
    const deckBeta = await db.createDeck({ name: 'beta' });

    const workspaceRootA = '/tmp/agent-deck-not84-a';
    const workspaceRootB = '/tmp/agent-deck-not84-b';
    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const liveDisplayRegistry = new LiveDisplayRegistry();

    const digestA = digestCanonicalWorkspacePath(canonicalizeWorkspacePath(workspaceRootA));
    const digestB = digestCanonicalWorkspacePath(canonicalizeWorkspacePath(workspaceRootB));
    const workspaceA = store.getOrCreateWorkspaceKey(digestA);
    const workspaceB = store.getOrCreateWorkspaceKey(digestB);

    const secretA = generateGrantSecret();
    const secretB = generateGrantSecret();
    store.activateGrant(store.createPendingGrant(workspaceA.id, deckAlpha.id, secretA).id);
    store.activateGrant(store.createPendingGrant(workspaceB.id, deckBeta.id, secretB).id);

    const fastify = Fastify();
    if (opts?.delayScopeDeckMs || opts?.onScopeHit) {
      fastify.addHook('onRequest', async (request) => {
        const pathname = request.url.split('?')[0];
        if (pathname === '/api/scope/deck' || pathname.startsWith('/api/decks/')) {
          const runtimeSessionId = request.headers[AGENT_DECK_SESSION_HEADER];
          opts.onScopeHit?.({
            endpoint: `${request.method} ${pathname}`,
            runtimeSessionId: typeof runtimeSessionId === 'string' ? runtimeSessionId : undefined,
          });
        }
        if (opts.delayScopeDeckMs && pathname === '/api/scope/deck') {
          await new Promise((resolve) => setTimeout(resolve, opts.delayScopeDeckMs));
        }
      });
    }

    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('liveDisplayRegistry', liveDisplayRegistry);
    fastify.decorate('serviceManager', {
      discoverServiceTools: async () => [{ name: 'ping', description: 'Ping' }],
      callServiceTool: async () => ({ success: true, result: { ok: true } }),
      getAllServices: async () => [],
      getService: async () => null,
      updateToolSettings: async () => null,
    } as unknown as ServiceManager);
    fastify.decorate('credentialManager', {
      get: async (id: string) => ({ id, name: 'key', type: 'api_key' }),
      listForDeck: async () => [],
      isCredentialOnDeck: async () => false,
      applySecretStatus: async (credentials: unknown[]) => credentials,
    });
    fastify.decorate('playbookManager', {
      getWithDependencies: async () => null,
      listSummariesForDeck: async () => [],
      listForDeck: async () => [],
      isPlaybookOnDeck: async () => false,
      createWithDependencies: async () => ({
        id: generateId(),
        title: 'pb',
        body: 'body',
        triggers: ['t'],
      }),
      updateWithDependencies: async () => null,
      delete: async () => true,
    });
    fastify.decorate('patchManager', {
      listOpenPatchSummaries: async () => [],
      snapshotVersion: async () => {},
    });
    fastify.decorate('broadcastServiceUpdate', () => {});
    fastify.decorate('storeWriter', { writeDeck: async () => {} });

    registerHttpPolicyHook(fastify);
    await fastify.register(registerServiceRoutes, { prefix: '/api/services' });
    await fastify.register(registerPlaybookRoutes, { prefix: '/api/playbooks' });
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
      workspaceRootA,
      workspaceRootB,
      deckAlpha,
      deckBeta,
      secretA,
      secretB,
      liveDisplayRegistry,
      store,
    };
  }

  it('same-deck bind_workspace succeeds without admin elevation', async () => {
    const { backendUrl, workspaceRootA, deckAlpha, secretA } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const sessionId = await openSession(started.port, 1, secretA);
    const bound = await callToolMcpResult(
      started.port,
      sessionId,
      'bind_workspace',
      { workspaceRoot: workspaceRootA, deckId: deckAlpha.id },
      2,
      secretA,
    );

    expect(bound.isError).toBe(false);
    expect(bound.data.error_code).toBeUndefined();
    expect(bound.data.deck_id).toBe(deckAlpha.id);
    expect(bound.data.deck_name).toBe('alpha');
    expect(bound.data.mode).toBe('normal');
  });

  it('different-deck bind returns ADMIN_REQUIRED without elevation', async () => {
    const { backendUrl, workspaceRootA, deckBeta, secretA } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const sessionId = await openSession(started.port, 1, secretA);
    const denied = await callToolMcpResult(
      started.port,
      sessionId,
      'bind_workspace',
      { workspaceRoot: workspaceRootA, deckId: deckBeta.id },
      2,
      secretA,
    );

    expect(denied.isError).toBe(true);
    expect(denied.data.error_code).toBe('ADMIN_REQUIRED');
  });

  it('overlapping tool calls keep each session scoped to its origin', async () => {
    const hits: ScopeHit[] = [];
    const { backendUrl, secretA, secretB, deckAlpha, deckBeta, store } =
      await buildListeningBackend({
        delayScopeDeckMs: 80,
        onScopeHit: (hit) => hits.push(hit),
      });
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const sessionA = await openSession(started.port, 1, secretA);
    const sessionB = await openSession(started.port, 10, secretB);

    const runtimeA = store.findActiveRuntimeSessionByMcpSessionId(sessionA)?.sessionId;
    const runtimeB = store.findActiveRuntimeSessionByMcpSessionId(sessionB)?.sessionId;
    expect(runtimeA).toBeTruthy();
    expect(runtimeB).toBeTruthy();
    expect(runtimeA).not.toBe(runtimeB);

    hits.length = 0;
    const [boundA, boundB] = await Promise.all([
      callToolMcpResult(started.port, sessionA, 'get_bound_deck', {}, 20, secretA),
      callToolMcpResult(started.port, sessionB, 'get_bound_deck', {}, 21, secretB),
    ]);

    expect(boundA.isError).toBe(false);
    expect(boundB.isError).toBe(false);
    expect(boundA.data.id).toBe(deckAlpha.id);
    expect(boundA.data.name).toBe('alpha');
    expect(boundB.data.id).toBe(deckBeta.id);
    expect(boundB.data.name).toBe('beta');

    const scopeDeckHits = hits.filter((hit) => hit.endpoint === 'GET /api/scope/deck');
    expect(scopeDeckHits.length).toBeGreaterThanOrEqual(2);
    const runtimeIds = new Set(scopeDeckHits.map((hit) => hit.runtimeSessionId));
    expect(runtimeIds.has(runtimeA!)).toBe(true);
    expect(runtimeIds.has(runtimeB!)).toBe(true);
    // No hit should omit the originating runtime session.
    expect(scopeDeckHits.every((hit) => Boolean(hit.runtimeSessionId))).toBe(true);
  });

  it('closing one session does not remove the other session live display', async () => {
    const { backendUrl, secretA, secretB, liveDisplayRegistry, workspaceRootA, workspaceRootB, deckAlpha, deckBeta } =
      await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const sessionA = await openSession(started.port, 1, secretA);
    const sessionB = await openSession(started.port, 10, secretB);

    const bindA = await callToolMcpResult(
      started.port,
      sessionA,
      'bind_workspace',
      { workspaceRoot: workspaceRootA, deckId: deckAlpha.id },
      2,
      secretA,
    );
    const bindB = await callToolMcpResult(
      started.port,
      sessionB,
      'bind_workspace',
      { workspaceRoot: workspaceRootB, deckId: deckBeta.id },
      12,
      secretB,
    );
    expect(bindA.isError).toBe(false);
    expect(bindB.isError).toBe(false);

    expect(liveDisplayRegistry.list().some((e) => e.mcpSessionId === sessionA && e.deckName === 'alpha')).toBe(
      true,
    );
    expect(liveDisplayRegistry.list().some((e) => e.mcpSessionId === sessionB && e.deckName === 'beta')).toBe(
      true,
    );

    const close = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionA,
        Authorization: `Bearer ${secretA}`,
      },
    });
    expect(close.ok).toBe(true);

    // Allow onclose cleanup to finish.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(liveDisplayRegistry.list().some((e) => e.mcpSessionId === sessionA)).toBe(false);
    expect(liveDisplayRegistry.list().some((e) => e.mcpSessionId === sessionB && e.deckName === 'beta')).toBe(
      true,
    );

    const stillBound = await callToolMcpResult(
      started.port,
      sessionB,
      'get_session_binding',
      {},
      30,
      secretB,
    );
    expect(stillBound.isError, JSON.stringify(stillBound.data)).toBe(false);
    expect(stillBound.data.effective_deck_id).toBe(deckBeta.id);
    expect(stillBound.data.effective_deck_name).toBe('beta');
    expect(liveDisplayRegistry.list().some((e) => e.mcpSessionId === sessionB)).toBe(true);
  });
});
