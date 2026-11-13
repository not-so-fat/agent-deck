/**
 * NOT-597: human-approved deck assignment from an unassigned session.
 * Headerless MCP client + existing folder; no CLI step.
 */
import Fastify from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_DECK_WORKSPACE_HEADER,
  generateId,
  writeDefaultDeck,
} from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import type { AgentDeckMCPServer } from '../mcp-server';
import { UNASSIGNED_DECK_MESSAGE } from '../mcp-unassigned';
import { registerCredentialRoutes } from '../routes/credentials';
import { registerDeckRoutes } from '../routes/decks';
import { registerPlaybookRoutes } from '../routes/playbooks';
import { registerScopeRoutes } from '../routes/scope';
import { registerServiceRoutes } from '../routes/services';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import { dashboardAuthHeaders } from '../test/auth-fixtures';
import type { ServiceManager } from '../services/service-manager';
import {
  MCP_ACCEPT,
  callToolMcpResult,
  listTools,
  openSession,
  postInitialize,
  startMcpServer,
} from './test-harness';

describe('MCP human-approved deck assignment (NOT-597)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];
  const tmpDirs: string[] = [];
  let mcpServer: AgentDeckMCPServer | undefined;
  let previousSkipDeckHeader: string | undefined;
  let previousSkipAdmin: string | undefined;
  let previousStubSync: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousSkipDeckHeader = process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER;
    previousSkipAdmin = process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;
    previousStubSync = process.env.AGENT_DECK_STUB_SYNC;
    previousHome = process.env.AGENT_DECK_HOME;
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
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()!;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
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
    if (previousHome === undefined) {
      delete process.env.AGENT_DECK_HOME;
    } else {
      process.env.AGENT_DECK_HOME = previousHome;
    }
  });

  function makeWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-assign-'));
    tmpDirs.push(dir);
    return dir;
  }

  function useIsolatedHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-not600-home-'));
    tmpDirs.push(dir);
    process.env.AGENT_DECK_HOME = dir;
    return dir;
  }

  async function buildListeningBackend() {
    const db = new DatabaseManager(':memory:');
    const deckA = await db.createDeck({ name: 'alpha' });
    const deckB = await db.createDeck({ name: 'beta' });

    const store = new TrustedSessionStore(db.getSqliteDatabase());

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
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
      deckA,
      deckB,
      store,
    };
  }

  async function openUnassignedSession(port: number): Promise<string> {
    const init = await postInitialize(port, 1);
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    return sessionId!;
  }

  async function fetchToolSchema(port: number, sessionId: string, toolName: string) {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
    });
    const body = (await response.json()) as {
      result?: { tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }> };
    };
    return body.result?.tools?.find((tool) => tool.name === toolName)?.inputSchema;
  }

  it('unassigned session lists request_deck_assignment with no deck-selecting argument', async () => {
    const { backendUrl } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const sessionId = await openUnassignedSession(started.port);
    const tools = await listTools(started.port, sessionId, 2);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('get_session_context');
    expect(names).toContain('request_deck_assignment');

    const schema = (await fetchToolSchema(started.port, sessionId, 'request_deck_assignment')) as {
      properties?: Record<string, unknown>;
    };
    expect(schema?.properties).toBeTruthy();
    const keys = Object.keys(schema.properties ?? {});
    // No argument selects a deck — the human picks it at approval time.
    for (const forbidden of ['deck', 'deckId', 'deck_id', 'target', 'deckName', 'deck_name']) {
      expect(keys, `schema must not accept ${forbidden}`).not.toContain(forbidden);
    }
    expect(keys).toContain('workspace');

    // The unassigned message names the tool first and keeps the CLI fallback.
    expect(UNASSIGNED_DECK_MESSAGE).toContain('request_deck_assignment');
    expect(UNASSIGNED_DECK_MESSAGE).toContain('agent-deck use <deck>');
    const context = await callToolMcpResult(started.port, sessionId, 'get_session_context', {}, 3);
    expect(context.isError).toBe(true);
    expect(String(context.data.message ?? '')).toContain('request_deck_assignment');
    expect(String(context.data.message ?? '')).toContain('agent-deck use <deck>');
  });

  it('workspace-scope approval binds the same session and writes use.json', async () => {
    const { backendUrl, deckB, store } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const workspace = makeWorkspace();
    const sessionId = await openUnassignedSession(started.port);

    const requested = await callToolMcpResult(
      started.port,
      sessionId,
      'request_deck_assignment',
      { workspace },
      2,
    );
    expect(requested.isError).toBe(false);
    expect(requested.data.status).toBe('pending');
    expect(typeof requested.data.requestId).toBe('string');

    // Simulated user approval: deck B with workspace scope.
    const resolve = await fetch(
      `${backendUrl}/api/trusted-session/deck-assignment/${requested.data.requestId}/resolve`,
      {
        method: 'POST',
        headers: {
          ...dashboardAuthHeaders(store),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deckId: deckB.id, decision: 'workspace-default' }),
      },
    );
    expect(resolve.status).toBe(200);

    // Same MCP session — no reload — now returns the deck.
    const context = await callToolMcpResult(started.port, sessionId, 'get_session_context', {}, 3);
    expect(context.isError).toBe(false);
    expect(context.data.effective_deck_id).toBe(deckB.id);
    expect(context.data.effective_deck_name).toBe('beta');

    // Workspace scope persists the folder assignment for later sessions.
    const useJsonPath = path.join(workspace, '.agent-deck', 'use.json');
    expect(fs.existsSync(useJsonPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(useJsonPath, 'utf8')) as { deckId?: string };
    expect(manifest.deckId).toBe(deckB.id);

    // The full tool list is now available without a reconnect.
    const tools = await listTools(started.port, sessionId, 4);
    expect(tools.map((tool) => tool.name)).toContain('get_bound_deck');
  });

  it('rejection leaves the session unassigned with no file written', async () => {
    const { backendUrl, store } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const workspace = makeWorkspace();
    const sessionId = await openUnassignedSession(started.port);

    const requested = await callToolMcpResult(
      started.port,
      sessionId,
      'request_deck_assignment',
      { workspace },
      2,
    );
    expect(requested.isError).toBe(false);

    // Pending before the decision: still unassigned, nothing on disk.
    const pending = await callToolMcpResult(started.port, sessionId, 'get_session_context', {}, 3);
    expect(pending.isError).toBe(true);
    expect(pending.data.error_code).toBe('GRANT_REQUIRED');
    expect(fs.existsSync(path.join(workspace, '.agent-deck'))).toBe(false);

    const resolve = await fetch(
      `${backendUrl}/api/trusted-session/deck-assignment/${requested.data.requestId}/resolve`,
      {
        method: 'POST',
        headers: {
          ...dashboardAuthHeaders(store),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ decision: 'decline' }),
      },
    );
    expect(resolve.status).toBe(200);

    const after = await callToolMcpResult(started.port, sessionId, 'get_session_context', {}, 4);
    expect(after.isError).toBe(true);
    expect(after.data).toMatchObject({ deck: null, error_code: 'GRANT_REQUIRED' });
    expect(fs.existsSync(path.join(workspace, '.agent-deck'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, '.cursor', 'mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, '.codex', 'config.toml'))).toBe(false);
  });

  it('relative, missing, or dot-dot paths are refused with no approval and no write', async () => {
    const { backendUrl, store } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const workspace = makeWorkspace();
    const sessionId = await openUnassignedSession(started.port);

    const cases = [
      { name: 'relative path', args: { workspace: 'relative/path' } },
      { name: 'missing directory', args: { workspace: path.join(workspace, 'does-not-exist') } },
      { name: 'dot-dot path', args: { workspace: `${workspace}${path.sep}..${path.sep}evil` } },
      { name: 'missing path', args: {} },
    ];
    let rpcId = 10;
    for (const testCase of cases) {
      const refused = await callToolMcpResult(
        started.port,
        sessionId,
        'request_deck_assignment',
        testCase.args,
        rpcId++,
      );
      expect(refused.isError, testCase.name).toBe(true);
    }

    // No approval opened for any refused path.
    expect(store.listPendingDeckAssignmentRequests()).toHaveLength(0);

    // No write inside the folder (or via traversal outside it).
    expect(fs.existsSync(path.join(workspace, '.agent-deck'))).toBe(false);
    const parentEvil = path.join(path.dirname(workspace), 'evil');
    expect(fs.existsSync(parentEvil)).toBe(false);

    // The session stays unassigned.
    const context = await callToolMcpResult(started.port, sessionId, 'get_session_context', {}, rpcId++);
    expect(context.isError).toBe(true);
    expect(context.data.error_code).toBe('GRANT_REQUIRED');
  });

  it('session scope binds the session and leaves the folder unchanged', async () => {
    const { backendUrl, deckA, store } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const workspace = makeWorkspace();
    const markerPath = path.join(workspace, 'keep.txt');
    fs.writeFileSync(markerPath, 'keep\n', 'utf8');

    const sessionId = await openUnassignedSession(started.port);
    const requested = await callToolMcpResult(
      started.port,
      sessionId,
      'request_deck_assignment',
      { workspace, reason: 'session-only check' },
      2,
    );
    expect(requested.isError).toBe(false);

    const resolve = await fetch(
      `${backendUrl}/api/trusted-session/deck-assignment/${requested.data.requestId}/resolve`,
      {
        method: 'POST',
        headers: {
          ...dashboardAuthHeaders(store),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deckId: deckA.id, decision: 'session' }),
      },
    );
    expect(resolve.status).toBe(200);

    const context = await callToolMcpResult(started.port, sessionId, 'get_session_context', {}, 3);
    expect(context.isError).toBe(false);
    expect(context.data.effective_deck_id).toBe(deckA.id);

    // Session scope writes nothing to disk.
    expect(fs.existsSync(path.join(workspace, '.agent-deck'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, '.cursor', 'mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, '.codex', 'config.toml'))).toBe(false);
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('keep\n');

    // A fresh headerless session is still unassigned (nothing persisted).
    const freshId = await openSession(started.port, 20);
    const fresh = await callToolMcpResult(started.port, freshId, 'get_session_context', {}, 21);
    expect(fresh.isError).toBe(true);
    expect(fresh.data.error_code).toBe('GRANT_REQUIRED');
  });

  it('NOT-600: folder assignment wins over the user default deck', async () => {
    const { backendUrl, deckA, deckB } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    useIsolatedHome();
    writeDefaultDeck({ deckId: deckA.id, deckName: deckA.name });

    const workspace = makeWorkspace();
    fs.mkdirSync(path.join(workspace, '.agent-deck'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.agent-deck', 'use.json'),
      JSON.stringify({ version: 3, deckId: deckB.id, deckName: deckB.name }),
    );
    const headers = { [AGENT_DECK_WORKSPACE_HEADER]: workspace };

    const sessionId = await openSession(started.port, 1, headers);
    const context = await callToolMcpResult(
      started.port,
      sessionId,
      'get_session_context',
      {},
      2,
      headers,
    );
    expect(context.isError).toBe(false);
    expect(context.data.effective_deck_id).toBe(deckB.id);
    expect(context.data.active_source).not.toBe('default-deck');

    const binding = await callToolMcpResult(
      started.port,
      sessionId,
      'get_session_binding',
      {},
      3,
      headers,
    );
    expect(binding.isError).toBe(false);
    expect(binding.data.active_deck_id).toBe(deckB.id);
    expect(binding.data.active_source).toBe('workspace');
  });
});
