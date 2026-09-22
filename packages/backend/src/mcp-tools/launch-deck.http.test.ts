/**
 * NOT-105: launch-selected deck MCP auth (deck header only).
 */
import Fastify from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AGENT_DECK_DECK_ID_HEADER } from '@agent-deck/shared';

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
import { LiveDisplayRegistry } from '../scope/live-display-registry';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import type { ServiceManager } from '../services/service-manager';
import {
  MCP_ACCEPT,
  callToolMcpResult,
  listTools,
  openSession,
  postInitialize,
  startMcpServer,
} from './test-harness';
import { UNASSIGNED_DECK_MESSAGE } from '../mcp-unassigned';

describe('MCP launch-selected deck (NOT-105)', () => {
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
    // Stub sync enabled — launch bind must still leave worktree empty.
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
    const deckAlpha = await db.createDeck({ name: 'alpha' });
    const deckBeta = await db.createDeck({ name: 'beta' });
    const playbook = await db.createPlaybook({
      id: 'pb_launch_http_test',
      title: 'launch-pb',
      body: '## Gotchas\n- Keep it short.\n',
      triggers: ['launch'],
    });
    await db.addPlaybookToDeck({ deckId: deckAlpha.id, playbookId: playbook.id, position: 0 });

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
      deckAlpha,
      deckBeta,
      playbook,
      store,
    };
  }

  it('init with only deck header binds get_bound_deck to that deck', async () => {
    const { backendUrl, deckAlpha } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const deckHeaders = { [AGENT_DECK_DECK_ID_HEADER]: deckAlpha.id };
    const sessionId = await openSession(started.port, 1, deckHeaders);
    const bound = await callToolMcpResult(
      started.port,
      sessionId,
      'get_bound_deck',
      {},
      2,
      deckHeaders,
    );

    expect(bound.isError).toBe(false);
    expect(bound.data.id).toBe(deckAlpha.id);
    expect(bound.data.name).toBe('alpha');
  });

  it('same-deck bind_workspace leaves fresh tmp dir empty with stub sync on', async () => {
    const { backendUrl, deckAlpha } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-launch-'));
    const deckHeaders = { [AGENT_DECK_DECK_ID_HEADER]: deckAlpha.id };
    const sessionId = await openSession(started.port, 1, deckHeaders);

    const bound = await callToolMcpResult(
      started.port,
      sessionId,
      'bind_workspace',
      { workspaceRoot: tmpRoot, deckId: deckAlpha.id },
      2,
      deckHeaders,
    );

    expect(bound.isError).toBe(false);
    expect(bound.data.stubs).toBeUndefined();
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('bind_workspace other deck → SWITCH_APPROVAL_REQUIRED (NOT-214)', async () => {
    const { backendUrl, deckAlpha, deckBeta } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const deckHeaders = { [AGENT_DECK_DECK_ID_HEADER]: deckAlpha.id };
    const sessionId = await openSession(started.port, 1, deckHeaders);
    const denied = await callToolMcpResult(
      started.port,
      sessionId,
      'bind_workspace',
      { workspaceRoot: '/tmp/agent-deck-launch-other', deckId: deckBeta.id },
      2,
      deckHeaders,
    );

    expect(denied.isError).toBe(true);
    expect(denied.data.error_code).toBe('SWITCH_APPROVAL_REQUIRED');
    expect(JSON.stringify(denied.data)).toContain('switch_deck');
  });

  it('propose_playbook_patch signal_only succeeds', async () => {
    const { backendUrl, deckAlpha, playbook } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const deckHeaders = { [AGENT_DECK_DECK_ID_HEADER]: deckAlpha.id };
    const sessionId = await openSession(started.port, 1, deckHeaders);
    const result = await callToolMcpResult(
      started.port,
      sessionId,
      'propose_playbook_patch',
      {
        kind: 'signal_only',
        playbook_id: playbook.id,
        rationale: 'Note for later',
        evidence: {
          failure_summary: 'One-off',
          user_feedback_excerpt: 'just note this',
        },
      },
      2,
      deckHeaders,
    );

    expect(result.isError).toBe(false);
    expect(result.data.kind).toBe('signal_only');
  });

  it('follow-up request without the deck header → 401', async () => {
    const { backendUrl, deckAlpha } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const deckHeaders = { [AGENT_DECK_DECK_ID_HEADER]: deckAlpha.id };
    const sessionId = await openSession(started.port, 1, deckHeaders);

    const response = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: { name: 'get_bound_deck', arguments: {} },
      }),
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe('GRANT_REQUIRED');
  });

  it('initialize without deck header → unassigned session (NOT-50)', async () => {
    const { backendUrl, deckAlpha, store } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const init = await postInitialize(started.port, 1);
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const initBody = (await init.json()) as {
      result?: { instructions?: string; serverInfo?: unknown };
    };
    expect(initBody.result?.instructions).toBe(UNASSIGNED_DECK_MESSAGE);

    const tools = await listTools(started.port, sessionId!, 2);
    expect(tools.map((t) => t.name)).toEqual(['get_session_binding', 'get_session_context']);

    const binding = await callToolMcpResult(
      started.port,
      sessionId!,
      'get_session_binding',
      {},
      3,
    );
    expect(binding.isError).toBe(true);
    expect(binding.data).toEqual({
      deck: null,
      error_code: 'GRANT_REQUIRED',
      message: UNASSIGNED_DECK_MESSAGE,
    });

    // Deck-scoped tools are absent — tools/call surfaces a protocol error, not deck data.
    const missingTool = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_bound_deck', arguments: {} },
      }),
    });
    expect(missingTool.status).toBe(200);
    const missingBody = (await missingTool.json()) as {
      error?: unknown;
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    const missingText = missingBody.result?.content?.[0]?.text ?? JSON.stringify(missingBody.error ?? {});
    expect(missingText).not.toContain(deckAlpha.id);
    expect(missingText).not.toContain('alpha');

    // No trusted runtime / connect-deck for an unassigned session.
    expect(store.findActiveRuntimeSessionByMcpSessionId(sessionId!)).toBeFalsy();

    // A late deck header must not expand the session into a trusted launch session.
    const withHeader = await callToolMcpResult(
      started.port,
      sessionId!,
      'get_session_binding',
      {},
      5,
      { [AGENT_DECK_DECK_ID_HEADER]: deckAlpha.id },
    );
    expect(withHeader.isError).toBe(true);
    expect(withHeader.data).toEqual({
      deck: null,
      error_code: 'GRANT_REQUIRED',
      message: UNASSIGNED_DECK_MESSAGE,
    });
    expect(store.findActiveRuntimeSessionByMcpSessionId(sessionId!)).toBeFalsy();
  });

  it('elevated launch session with use.json cannot switch decks via bind (NOT-214)', async () => {
    const { backendUrl, deckAlpha, deckBeta, store } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-assign-'));
    fs.mkdirSync(path.join(tmpRoot, '.agent-deck'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.agent-deck', 'use.json'),
      `${JSON.stringify({ version: 3, deckId: deckAlpha.id, deckName: 'alpha' }, null, 2)}\n`,
    );

    const deckHeaders = { [AGENT_DECK_DECK_ID_HEADER]: deckAlpha.id };
    const sessionId = await openSession(started.port, 1, deckHeaders);
    const runtime = store.findActiveRuntimeSessionByMcpSessionId(sessionId);
    expect(runtime).toBeTruthy();
    store.elevateSessionToAdmin(runtime!.sessionId);

    // Elevation is no longer a switching path: no rewrite, no binding change.
    const denied = await callToolMcpResult(
      started.port,
      sessionId,
      'bind_workspace',
      { workspaceRoot: tmpRoot, deckId: deckBeta.id },
      2,
      deckHeaders,
    );
    expect(denied.isError).toBe(true);
    expect(denied.data.error_code).toBe('SWITCH_APPROVAL_REQUIRED');
    expect(JSON.stringify(denied.data)).toContain('switch_deck');
    expect(denied.data.assignment_updated).toBeUndefined();

    const assigned = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, '.agent-deck', 'use.json'), 'utf8'),
    ) as { version: number; deckId: string; deckName: string };
    expect(assigned.version).toBe(3);
    expect(assigned.deckId).toBe(deckAlpha.id);
    expect(assigned.deckName).toBe('alpha');

    const bound = await callToolMcpResult(
      started.port,
      sessionId,
      'get_bound_deck',
      {},
      3,
      deckHeaders,
    );
    expect(bound.isError).toBe(false);
    expect(bound.data.id).toBe(deckAlpha.id);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('launch session with use.json but not elevated → SWITCH_APPROVAL_REQUIRED (NOT-214)', async () => {
    const { backendUrl, deckAlpha, deckBeta } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-admin-req-'));
    fs.mkdirSync(path.join(tmpRoot, '.agent-deck'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.agent-deck', 'use.json'),
      `${JSON.stringify({ version: 3, deckId: deckAlpha.id, deckName: 'alpha' }, null, 2)}\n`,
    );

    const deckHeaders = { [AGENT_DECK_DECK_ID_HEADER]: deckAlpha.id };
    const sessionId = await openSession(started.port, 1, deckHeaders);
    const denied = await callToolMcpResult(
      started.port,
      sessionId,
      'bind_workspace',
      { workspaceRoot: tmpRoot, deckId: deckBeta.id },
      2,
      deckHeaders,
    );
    expect(denied.isError).toBe(true);
    expect(denied.data.error_code).toBe('SWITCH_APPROVAL_REQUIRED');
    expect(JSON.stringify(denied.data)).toContain('switch_deck');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('launch session without use.json → SWITCH_APPROVAL_REQUIRED (NOT-214)', async () => {
    const { backendUrl, deckAlpha, deckBeta } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const deckHeaders = { [AGENT_DECK_DECK_ID_HEADER]: deckAlpha.id };
    const sessionId = await openSession(started.port, 1, deckHeaders);
    const denied = await callToolMcpResult(
      started.port,
      sessionId,
      'bind_workspace',
      { workspaceRoot: '/tmp/agent-deck-launch-no-assign', deckId: deckBeta.id },
      2,
      deckHeaders,
    );
    expect(denied.isError).toBe(true);
    expect(denied.data.error_code).toBe('SWITCH_APPROVAL_REQUIRED');
    expect(JSON.stringify(denied.data)).toContain('switch_deck');
  });

  it('same-deck bind with use.json in a git repo leaves porcelain empty', async () => {
    const { backendUrl, deckAlpha } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-git-bind-'));
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: tmpRoot, stdio: 'ignore' });
    fs.mkdirSync(path.join(tmpRoot, '.agent-deck'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.agent-deck', 'use.json'),
      `${JSON.stringify({ version: 3, deckId: deckAlpha.id, deckName: 'alpha' }, null, 2)}\n`,
    );

    const deckHeaders = { [AGENT_DECK_DECK_ID_HEADER]: deckAlpha.id };
    const sessionId = await openSession(started.port, 1, deckHeaders);
    const bound = await callToolMcpResult(
      started.port,
      sessionId,
      'bind_workspace',
      { workspaceRoot: tmpRoot, deckId: deckAlpha.id },
      2,
      deckHeaders,
    );
    expect(bound.isError).toBe(false);
    expect(bound.data.stubs).toBeDefined();

    const porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: tmpRoot,
      encoding: 'utf8',
    });
    expect(porcelain.trim()).toBe('');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});
