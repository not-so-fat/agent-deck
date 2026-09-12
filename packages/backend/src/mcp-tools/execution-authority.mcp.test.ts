/**
 * NOT-86: MCP session authenticated with execution authority can reach bound-deck APIs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createServer } from '../server/index';
import { ensureAdminSecret, readAdminSecretFromEnvOrFile } from '../trusted-session/admin-secret';
import type { AgentDeckMCPServer } from '../mcp-server';
import {
  callToolMcpResult,
  openSession,
  startMcpServer,
} from './test-harness';

describe('MCP execution-authority principal (NOT-86)', () => {
  let home: string;
  let previousHome: string | undefined;
  let previousSkipGrant: string | undefined;
  let previousSkipAdmin: string | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let mcpServer: AgentDeckMCPServer | undefined;
  let backendUrl: string;
  let adminBearer: string;

  beforeEach(async () => {
    previousHome = process.env.AGENT_DECK_HOME;
    previousSkipGrant = process.env.AGENT_DECK_MCP_SKIP_GRANT_AUTH;
    previousSkipAdmin = process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-ea-mcp-'));
    process.env.AGENT_DECK_HOME = home;
    process.env.AGENT_DECK_MCP_SKIP_GRANT_AUTH = '0';
    process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK = '0';
    await ensureAdminSecret();
    const secret = await readAdminSecretFromEnvOrFile();
    if (!secret) throw new Error('admin secret missing');
    adminBearer = `Bearer ${secret}`;

    server = await createServer();
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    if (!address || typeof address === 'string') throw new Error('no listen address');
    backendUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (mcpServer) {
      await mcpServer.stop();
      mcpServer = undefined;
    }
    await server?.close();
    server = undefined;
    if (previousHome === undefined) delete process.env.AGENT_DECK_HOME;
    else process.env.AGENT_DECK_HOME = previousHome;
    if (previousSkipGrant === undefined) delete process.env.AGENT_DECK_MCP_SKIP_GRANT_AUTH;
    else process.env.AGENT_DECK_MCP_SKIP_GRANT_AUTH = previousSkipGrant;
    if (previousSkipAdmin === undefined) delete process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;
    else process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK = previousSkipAdmin;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('get_bound_deck works under authority; control-plane returns INTERACTION_REQUIRED', async () => {
    const deck = await server!.db.createDeck({ name: 'ea-mcp-deck' });
    const service = await server!.db.createService({
      name: 'ea-svc',
      type: 'mcp',
      url: 'http://127.0.0.1:9/mcp',
    });
    await server!.db.addServiceToDeck({ deckId: deck.id, serviceId: service.id, position: 0 });

    const enroll = await fetch(`${backendUrl}/api/execution-authority/enrollments`, {
      method: 'POST',
      headers: { Authorization: adminBearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinatorId: 'mcp-coord', allowedDeckIds: [deck.id] }),
    });
    const enrollBody = (await enroll.json()) as {
      data: { enrollment: { enrollmentId: string }; enrollmentSecret: string };
    };
    const enrollmentBearer = `Bearer ${enrollBody.data.enrollment.enrollmentId}:${enrollBody.data.enrollmentSecret}`;

    const mint = await fetch(`${backendUrl}/api/execution-authority/authorities`, {
      method: 'POST',
      headers: { Authorization: enrollmentBearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollmentId: enrollBody.data.enrollment.enrollmentId,
        runId: 'run_mcp',
        attemptId: 'attempt_1',
        deckId: deck.id,
        audience: 'dealer-worker',
        idempotencyKey: 'run_mcp:1',
        ttlMs: 120_000,
        toolScopeHint: [{ serviceId: service.id, toolName: 'ping' }],
      }),
    });
    const mintBody = (await mint.json()) as {
      ok?: boolean;
      data?: {
        authority: { authorityId: string };
        authoritySecret: string;
      };
      message?: string;
    };
    expect(mint.ok).toBe(true);
    expect(mintBody.ok).toBe(true);
    if (!mintBody.data?.authoritySecret) {
      throw new Error(`mint failed: ${mintBody.message ?? JSON.stringify(mintBody)}`);
    }

    const authorityBearer = `${mintBody.data.authority.authorityId}:${mintBody.data.authoritySecret}`;

    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;
    const sessionId = await openSession(started.port, 1, authorityBearer);

    const bound = await callToolMcpResult(
      started.port,
      sessionId,
      'get_bound_deck',
      {},
      2,
      authorityBearer,
    );
    expect(bound.isError).toBe(false);
    expect(bound.data).toMatchObject({ id: deck.id });

    const control = await callToolMcpResult(
      started.port,
      sessionId,
      'bind_workspace',
      { workspaceRoot: '/tmp/ea-wt', deckId: deck.id },
      3,
      authorityBearer,
    );
    expect(control.isError).toBe(true);
    expect(control.data.error_code).toBe('INTERACTION_REQUIRED');

    const scope = await fetch(`${backendUrl}/api/scope/deck`, {
      headers: { Authorization: `Bearer ${authorityBearer}` },
    });
    expect(scope.ok).toBe(true);
    const scopeBody = (await scope.json()) as { data?: { id?: string }; id?: string };
    const scopeId = scopeBody.data?.id ?? scopeBody.id;
    expect(scopeId).toBe(deck.id);
  });
});
