/**
 * NOT-669: worker profiles — shared definition, run-token identity,
 * server-side MCP enforcement, and the denial record.
 *
 * Through the real MCP server, HTTP policy layer, trusted-session routes,
 * and the one backend Agent Run service (fixture adapter — no model):
 * a worker MCP session carrying a run token is denied immediately with
 * `PROFILE_DENIED` for tools outside its effective profile, each denial is
 * recorded on the run and visible through `get_run`, and leader sessions
 * keep the existing approval flow. Invalid or expired worker credentials
 * are rejected, and the token never appears in plain text.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_DECK_DECK_ID_HEADER,
  AGENT_DECK_RUN_TOKEN_HEADER,
  AGENT_DECK_WORKSPACE_HEADER,
} from '@agent-deck/shared';

import type { AdapterStartArgs, ClientAdapter, NormalizedEvent, RunClient } from './agent-run';
import { createBackendAgentRunService } from './agent-run-api/host';
import { AuditStore } from './audit/store';
import type { AgentDeckMCPServer } from './mcp-server';
import { DatabaseManager } from './models/database';
import { LiveDisplayRegistry } from './scope/live-display-registry';
import { registerAgentRunRoutes } from './routes/agent-runs';
import { registerCredentialRoutes } from './routes/credentials';
import { registerDeckRoutes } from './routes/decks';
import { registerPlaybookPatchRoutes } from './routes/playbook-patches';
import { registerPlaybookRoutes } from './routes/playbooks';
import { registerScopeRoutes } from './routes/scope';
import { registerServiceRoutes } from './routes/services';
import { registerTrustedSessionRoutes } from './routes/trusted-session';
import type { ServiceManager } from './services/service-manager';
import { dashboardAuthHeaders } from './test/auth-fixtures';
import { registerHttpPolicyHook } from './trusted-session/policy-hook';
import { TrustedSessionStore } from './trusted-session/store';
import {
  callToolMcpResult,
  MCP_ACCEPT,
  openSession,
  postInitialize,
  startMcpServer,
} from './mcp-tools/test-harness';

type Step = { event: NormalizedEvent; gate?: Promise<void> };

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function successSteps(): Step[] {
  return [
    { event: { kind: 'text', text: 'working', sessionId: 'ses_1' } },
    { event: { kind: 'tool', name: 'Read', sessionId: 'ses_1' } },
    { event: { kind: 'notice', message: 'heads up', sessionId: 'ses_1' } },
    { event: { kind: 'result', subtype: 'success', result: 'done', sessionId: 'ses_1' } },
  ];
}

const tmpDirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

function worktree(): string {
  const dir = makeDir('ad-mcp-worker-wt-');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  return dir;
}

describe('MCP worker profiles (NOT-669)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];
  let mcpServer: AgentDeckMCPServer | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ['AGENT_DECK_MCP_SKIP_DECK_HEADER', 'AGENT_DECK_MCP_SKIP_ADMIN_CHECK', 'AGENT_DECK_STUB_SYNC', 'AGENT_DECK_WORKSPACE'];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }
    process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER = '0';
    process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK = '0';
    process.env.AGENT_DECK_STUB_SYNC = 'off';
    delete process.env.AGENT_DECK_WORKSPACE;
  });

  afterEach(async () => {
    if (mcpServer) {
      await mcpServer.stop();
      mcpServer = undefined;
    }
    while (servers.length) {
      await servers.pop()?.close();
    }
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function setup(options: { steps?: () => Step[] } = {}) {
    const db = new DatabaseManager(':memory:');
    const deckA = await db.createDeck({ name: 'alpha' });
    const deckB = await db.createDeck({ name: 'beta' });
    const serviceRow = await db.createService({ name: 'svc', type: 'mcp', url: 'http://svc.test/mcp' });
    await db.addServiceToDeck({ deckId: deckA.id, serviceId: serviceRow.id });
    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const home = makeDir('ad-mcp-worker-home-');

    const starts: AdapterStartArgs[] = [];
    const steps = options.steps ?? successSteps;
    const adapter: ClientAdapter = {
      id: 'claude',
      async preflight() {
        return { ok: true };
      },
      planStart() {
        return { ok: true, trustOverride: false };
      },
      profileEnforcement() {
        return { ok: true };
      },
      async *start(args) {
        starts.push(args);
        for (const step of steps()) {
          if (step.gate) {
            await step.gate;
          }
          yield step.event;
        }
      },
    };
    const createAdapter = vi.fn((_client: RunClient): ClientAdapter => adapter);
    const service = createBackendAgentRunService(db, home, {
      createAdapter,
      claudeProbe: async () => ({ ok: true }),
    });
    const launch = vi.spyOn(service, 'launch');

    const serviceTools = [
      { name: 'list_widgets', description: 'list', inputSchema: {}, annotations: { readOnlyHint: true } },
      { name: 'write_widget', description: 'write', inputSchema: {} },
    ];
    const serviceCalls: Array<{ toolName: string }> = [];
    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('auditStore', new AuditStore(db.getSqliteDatabase()));
    fastify.decorate('serviceManager', {
      getAllServices: async () => [],
      getService: async () => null,
      discoverServiceTools: async () => serviceTools,
      callServiceTool: async ({ toolName }: { toolName: string }) => {
        serviceCalls.push({ toolName });
        return { success: true, result: { ok: true } };
      },
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
    });
    fastify.decorate('patchManager', {
      listOpenPatchSummaries: async () => [],
      snapshotVersion: async () => {},
      propose: async (body: { kind: string; rationale: string }) => ({
        kind: body.kind,
        patch: {
          id: 'pp_1',
          kind: body.kind,
          playbookId: null,
          opsJson: '[]',
          rationale: body.rationale,
          source: 'ide',
          sourceRef: null,
          evidenceJson: null,
          conflictsJson: null,
          status: 'proposed',
        },
        signal: null,
        superseded: [],
      }),
    });
    fastify.decorate('broadcastServiceUpdate', () => {});
    fastify.decorate('storeWriter', { writeDeck: async () => {} });
    fastify.decorate('liveDisplayRegistry', new LiveDisplayRegistry());

    registerHttpPolicyHook(fastify);
    await fastify.register(registerServiceRoutes, { prefix: '/api/services' });
    await fastify.register(registerPlaybookRoutes, { prefix: '/api/playbooks' });
    await fastify.register(registerPlaybookPatchRoutes, { prefix: '/api/playbook-patches' });
    await fastify.register(registerCredentialRoutes, { prefix: '/api/credentials' });
    await fastify.register(registerDeckRoutes, { prefix: '/api/decks', storeWriter: { writeDeck: async () => {} } });
    await fastify.register(registerTrustedSessionRoutes, { prefix: '/api/trusted-session' });
    await fastify.register(registerScopeRoutes, { prefix: '/api/scope' });
    await fastify.register(registerAgentRunRoutes, { prefix: '/api', service });
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    servers.push(fastify);
    const address = fastify.server.address();
    const backendPort = typeof address === 'object' && address && 'port' in address ? address.port : 0;
    const backendUrl = `http://127.0.0.1:${backendPort}`;

    const started = await startMcpServer(backendUrl, 'standard', { homeDir: home });
    mcpServer = started.server;

    return { db, deckA, deckB, serviceRow, store, home, starts, createAdapter, launch, service, serviceCalls, backendUrl, port: started.port };
  }

  type Ctx = Awaited<ReturnType<typeof setup>>;
  type Session = { id: string; headers: Record<string, string> };

  function dealerHeaders(deckId: string, workspace?: string, extra?: Record<string, string>): Record<string, string> {
    return {
      [AGENT_DECK_DECK_ID_HEADER]: deckId,
      ...(workspace ? { [AGENT_DECK_WORKSPACE_HEADER]: workspace } : {}),
      ...extra,
    };
  }

  let rpcId = 100;
  async function call(ctx: Ctx, session: Session, name: string, args: unknown, headers?: Record<string, string>) {
    rpcId += 1;
    return callToolMcpResult(ctx.port, session.id, name, args, rpcId, headers ?? session.headers);
  }

  async function open(ctx: Ctx, headers: Record<string, string>) {
    rpcId += 1;
    return { id: await openSession(ctx.port, rpcId, headers), headers };
  }

  async function startRun(ctx: Ctx, session: Session, args: Record<string, unknown> = {}) {
    const before = ctx.starts.length;
    const result = await call(ctx, session, 'start_run', { client: 'codex', prompt: 'do the thing', ...args });
    expect(result.isError, JSON.stringify(result.data)).toBe(false);
    expect(ctx.starts.length).toBe(before + 1);
    return { runId: result.data.runId as string, token: ctx.starts[before].runToken as string };
  }

  async function untilTerminal(ctx: Ctx, session: Session, runId: string) {
    for (let i = 0; i < 400; i += 1) {
      const read = await call(ctx, session, 'get_run', { runId, limit: 1000 });
      expect(read.isError, JSON.stringify(read.data)).toBe(false);
      if (['ended', 'error', 'died', 'canceled'].includes(String(read.data.state))) {
        return read.data;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('run did not reach a terminal state');
  }

  it('edit worker: switch_deck, start_run, request_admin_elevation denied immediately with no pending approval; writes succeed', async () => {
    const hold = deferred();
    const release = hold.release;
    const ctx = await setup({
      steps: () => [{ event: { kind: 'text', text: 'working', sessionId: 'ses_1' }, gate: hold.promise }, ...successSteps().slice(1)],
    });
    const wt = worktree();
    const leader = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    const { runId, token } = await startRun(ctx, leader, { tools: 'edit' });
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const worker = await open(ctx, dealerHeaders(ctx.deckA.id, wt, { [AGENT_DECK_RUN_TOKEN_HEADER]: token }));
    const launchesBefore = ctx.launch.mock.calls.length;
    const deniedCalls: Array<[string, unknown]> = [
      ['switch_deck', { target: ctx.deckB.name }],
      ['start_run', { client: 'codex', prompt: 're-delegate' }],
      ['request_admin_elevation', {}],
    ];
    for (const [name, args] of deniedCalls) {
      const startedAt = Date.now();
      const denied = await call(ctx, worker, name, args);
      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(denied.isError).toBe(true);
      expect(denied.data.code).toBe('PROFILE_DENIED');
      expect(denied.data.profile).toBe('edit');
      expect(denied.data.tool).toBe(name);
      expect(typeof denied.data.reason).toBe('string');
    }
    // Nothing was opened for a human: no pending switch, no pending elevation, no launched run.
    expect(ctx.store.listPendingDeckSwitchRequests()).toEqual([]);
    expect(ctx.store.listPendingAdminChallenges()).toEqual([]);
    expect(ctx.launch.mock.calls.length).toBe(launchesBefore);

    // The edit profile allows service writes and playbook proposals.
    const called = await call(ctx, worker, 'call_service_tool', {
      serviceId: ctx.serviceRow.id,
      toolName: 'write_widget',
      arguments: {},
    });
    expect(called.isError, JSON.stringify(called.data)).toBe(false);
    expect(ctx.serviceCalls.at(-1)).toEqual({ toolName: 'write_widget' });
    const proposed = await call(ctx, worker, 'propose_playbook_patch', {
      kind: 'create',
      new_playbook: { title: 'lesson', triggers: ['when x'] },
      rationale: 'learned from work',
    });
    expect(proposed.isError, JSON.stringify(proposed.data)).toBe(false);
    expect(proposed.data.id).toBe('pp_1');

    release();
    const finished = await untilTerminal(ctx, leader, runId);
    expect(finished.effectiveProfile).toBe('edit');
    const denials = finished.denials as Array<Record<string, unknown>>;
    expect(denials).toHaveLength(3);
    for (const [index, [name]] of deniedCalls.entries()) {
      expect(denials[index]).toMatchObject({
        source: 'agent-deck',
        kind: 'mcp_tool',
        target: name,
        profile: 'edit',
        client: 'codex',
      });
      expect(typeof denials[index].at).toBe('string');
      expect(typeof denials[index].reason).toBe('string');
    }
  });

  it('readonly worker: propose_playbook_patch and non-readOnlyHint call_service_tool denied; readOnlyHint call allowed', async () => {
    const hold = deferred();
    const release = hold.release;
    const ctx = await setup({
      steps: () => [{ event: { kind: 'text', text: 'working', sessionId: 'ses_1' }, gate: hold.promise }, ...successSteps().slice(1)],
    });
    const wt = worktree();
    const leader = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    const { runId, token } = await startRun(ctx, leader, { tools: 'readonly' });
    const worker = await open(ctx, dealerHeaders(ctx.deckA.id, wt, { [AGENT_DECK_RUN_TOKEN_HEADER]: token }));

    const proposed = await call(ctx, worker, 'propose_playbook_patch', {
      kind: 'create',
      new_playbook: { title: 'lesson', triggers: ['when x'] },
      rationale: 'learned from work',
    });
    expect(proposed.isError).toBe(true);
    expect(proposed.data).toMatchObject({ code: 'PROFILE_DENIED', profile: 'readonly', tool: 'propose_playbook_patch' });

    const write = await call(ctx, worker, 'call_service_tool', {
      serviceId: ctx.serviceRow.id,
      toolName: 'write_widget',
      arguments: {},
    });
    expect(write.isError).toBe(true);
    expect(write.data).toMatchObject({ code: 'PROFILE_DENIED', profile: 'readonly', tool: 'call_service_tool' });
    expect(ctx.serviceCalls).toEqual([]);

    const unknown = await call(ctx, worker, 'call_service_tool', {
      serviceId: ctx.serviceRow.id,
      toolName: 'no_such_tool',
      arguments: {},
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.data.code).toBe('PROFILE_DENIED');

    const read = await call(ctx, worker, 'call_service_tool', {
      serviceId: ctx.serviceRow.id,
      toolName: 'list_widgets',
      arguments: {},
    });
    expect(read.isError, JSON.stringify(read.data)).toBe(false);
    expect(ctx.serviceCalls).toEqual([{ toolName: 'list_widgets' }]);

    release();
    const finished = await untilTerminal(ctx, leader, runId);
    expect(finished.effectiveProfile).toBe('readonly');
    const denials = finished.denials as Array<Record<string, unknown>>;
    expect(denials.map((denial) => denial.target)).toEqual([
      'propose_playbook_patch',
      'call_service_tool',
      'call_service_tool',
    ]);
    for (const denial of denials) {
      expect(denial).toMatchObject({ source: 'agent-deck', kind: 'mcp_tool', profile: 'readonly' });
    }
  });

  it('leader sessions keep the existing approval flow', async () => {
    const ctx = await setup();
    const wt = worktree();
    const leader = await open(ctx, dealerHeaders(ctx.deckA.id, wt));

    const requested = await call(ctx, leader, 'switch_deck', { target: ctx.deckB.name });
    expect(requested.isError, JSON.stringify(requested.data)).toBe(false);
    expect(requested.data.status).toBe('pending');
    expect(ctx.store.listPendingDeckSwitchRequests()).toHaveLength(1);

    const elevation = await call(ctx, leader, 'request_admin_elevation', {});
    expect(elevation.data.code).not.toBe('PROFILE_DENIED');
  });

  it('invalid and expired worker credentials are rejected', async () => {
    const ctx = await setup();
    const wt = worktree();
    const leader = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    const { runId, token } = await startRun(ctx, leader, { tools: 'edit' });
    await untilTerminal(ctx, leader, runId);

    // Malformed and unknown tokens: invalid.
    for (const bad of ['not-a-token', '0'.repeat(64)]) {
      rpcId += 1;
      const init = await postInitialize(ctx.port, rpcId, 'vitest', dealerHeaders(ctx.deckA.id, wt, { [AGENT_DECK_RUN_TOKEN_HEADER]: bad }));
      expect(init.status).toBe(401);
      expect(init.headers.get('mcp-session-id')).toBeNull();
      const body = (await init.json()) as { error?: { message?: string } };
      expect(body.error?.message).toContain('RUN_TOKEN_INVALID');
    }

    // The finished run's token: expired.
    rpcId += 1;
    const expired = await postInitialize(ctx.port, rpcId, 'vitest', dealerHeaders(ctx.deckA.id, wt, { [AGENT_DECK_RUN_TOKEN_HEADER]: token }));
    expect(expired.status).toBe(401);
    const expiredBody = (await expired.json()) as { error?: { message?: string } };
    expect(expiredBody.error?.message).toContain('RUN_TOKEN_EXPIRED');
  });

  it('worker identity is bound to the transport: it cannot be dropped or replaced', async () => {
    const holdA = deferred();
    const holdB = deferred();
    let gate = holdA.promise;
    const ctx = await setup({
      steps: () => [{ event: { kind: 'text', text: 'working', sessionId: 'ses_1' }, gate }, ...successSteps().slice(1)],
    });
    const wt = worktree();
    const leader = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    const first = await startRun(ctx, leader, { tools: 'edit' });
    gate = holdB.promise;
    const second = await startRun(ctx, leader, { tools: 'readonly' });

    const worker = await open(ctx, dealerHeaders(ctx.deckA.id, wt, { [AGENT_DECK_RUN_TOKEN_HEADER]: first.token }));

    // Omitting the header cannot drop the identity.
    const noHeader = await call(ctx, worker, 'switch_deck', { target: ctx.deckB.name }, dealerHeaders(ctx.deckA.id, wt));
    expect(noHeader.isError).toBe(true);
    expect(noHeader.data).toMatchObject({ code: 'PROFILE_DENIED', profile: 'edit' });

    // Presenting another run's token cannot replace it.
    const swapped = await call(
      ctx,
      worker,
      'start_run',
      { client: 'codex', prompt: 'x' },
      dealerHeaders(ctx.deckA.id, wt, { [AGENT_DECK_RUN_TOKEN_HEADER]: second.token }),
    );
    expect(swapped.isError).toBe(true);
    expect(swapped.data).toMatchObject({ code: 'PROFILE_DENIED', profile: 'edit' });

    // Both denials landed on the first run; the second run is untouched.
    holdA.release();
    holdB.release();
    const firstFinished = await untilTerminal(ctx, leader, first.runId);
    expect((firstFinished.denials as unknown[])).toHaveLength(2);
    const secondFinished = await untilTerminal(ctx, leader, second.runId);
    expect(secondFinished.effectiveProfile).toBe('readonly');
    expect(secondFinished.denials).toEqual([]);
  });

  it('a worker session bound through the folder fallback is still enforced', async () => {
    const hold = deferred();
    const release = hold.release;
    const ctx = await setup({
      steps: () => [{ event: { kind: 'text', text: 'working', sessionId: 'ses_1' }, gate: hold.promise }, ...successSteps().slice(1)],
    });
    const wt = worktree();
    fs.mkdirSync(path.join(wt, '.agent-deck'), { recursive: true });
    fs.writeFileSync(
      path.join(wt, '.agent-deck', 'use.json'),
      JSON.stringify({ version: 3, deckId: ctx.deckA.id, deckName: ctx.deckA.name }),
    );
    const leader = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    const { runId, token } = await startRun(ctx, leader, { tools: 'edit' });

    // No deck header: the session binds from the folder assignment, but the
    // worker identity still applies.
    const worker = await open(ctx, {
      [AGENT_DECK_WORKSPACE_HEADER]: wt,
      [AGENT_DECK_RUN_TOKEN_HEADER]: token,
    });
    const denied = await call(ctx, worker, 'switch_deck', { target: ctx.deckB.name });
    expect(denied.isError).toBe(true);
    expect(denied.data).toMatchObject({ code: 'PROFILE_DENIED', profile: 'edit', tool: 'switch_deck' });
    expect(ctx.store.listPendingDeckSwitchRequests()).toEqual([]);

    release();
    const finished = await untilTerminal(ctx, leader, runId);
    expect(finished.denials).toHaveLength(1);
  });

  it('a yielded denial event from the adapter is recorded with source client', async () => {
    const ctx = await setup({
      steps: () => [
        { event: { kind: 'text', text: 'working', sessionId: 'ses_1' } },
        { event: { kind: 'denial', target: 'gh pr create', reason: 'client refused the mutation', denialKind: 'client_tool', sessionId: 'ses_1' } },
        { event: { kind: 'result', subtype: 'success', result: 'done', sessionId: 'ses_1' } },
      ],
    });
    const wt = worktree();
    const leader = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    const { runId } = await startRun(ctx, leader, { tools: 'readonly' });
    const finished = await untilTerminal(ctx, leader, runId);
    expect(finished.effectiveProfile).toBe('readonly');
    expect(finished.denials).toHaveLength(1);
    expect(finished.denials[0]).toMatchObject({
      source: 'client',
      kind: 'client_tool',
      target: 'gh pr create',
      profile: 'readonly',
      client: 'codex',
    });
  });

  it('the run token never appears in plain text in run records, logs, or get_run', async () => {
    const ctx = await setup();
    const wt = worktree();
    const leader = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    const { runId, token } = await startRun(ctx, leader, { tools: 'edit' });
    const finished = await untilTerminal(ctx, leader, runId);

    expect(JSON.stringify(finished)).not.toContain(token);
    const dir = path.join(ctx.home, 'runs', runId);
    for (const file of fs.readdirSync(dir)) {
      expect(fs.readFileSync(path.join(dir, file), 'utf8')).not.toContain(token);
    }
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as { runTokenHash?: string };
    expect(meta.runTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.runTokenHash).not.toBe(token);
  });

  it('readonly worker: cancel_run and bind_workspace denied with no side effects', async () => {
    const hold = deferred();
    const release = hold.release;
    const ctx = await setup({
      steps: () => [{ event: { kind: 'text', text: 'working', sessionId: 'ses_1' }, gate: hold.promise }, ...successSteps().slice(1)],
    });
    const wt = worktree();
    const leader = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    const { runId, token } = await startRun(ctx, leader, { tools: 'readonly' });
    const worker = await open(ctx, dealerHeaders(ctx.deckA.id, wt, { [AGENT_DECK_RUN_TOKEN_HEADER]: token }));

    const canceled = await call(ctx, worker, 'cancel_run', { runId });
    expect(canceled.isError).toBe(true);
    expect(canceled.data).toMatchObject({ code: 'PROFILE_DENIED', profile: 'readonly', tool: 'cancel_run' });

    const bound = await call(ctx, worker, 'bind_workspace', { workspaceRoot: wt, deckId: ctx.deckA.id });
    expect(bound.isError).toBe(true);
    expect(bound.data).toMatchObject({ code: 'PROFILE_DENIED', profile: 'readonly', tool: 'bind_workspace' });

    // The denied cancel changed nothing: the run still ends on its own.
    release();
    const finished = await untilTerminal(ctx, leader, runId);
    expect(finished.state).toBe('ended');
    expect((finished.denials as Array<Record<string, unknown>>).map((denial) => denial.target)).toEqual([
      'cancel_run',
      'bind_workspace',
    ]);
  });

  it('edit worker on an unassigned session: request_deck_assignment denied, bootstrap reads untouched', async () => {
    const hold = deferred();
    const release = hold.release;
    const ctx = await setup({
      steps: () => [{ event: { kind: 'text', text: 'working', sessionId: 'ses_1' }, gate: hold.promise }, ...successSteps().slice(1)],
    });
    const wt = worktree();
    const leader = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    const { runId, token } = await startRun(ctx, leader, { tools: 'edit' });

    // No deck or workspace header: the session lands unassigned, but the
    // worker identity still applies. Initialize directly without the
    // trusted-session wait: unassigned sessions register no get_bound_deck
    // (only the bootstrap reads), so the wait's poll would fail — the same
    // reason the core suite opens unassigned sessions via postInitialize.
    // Worker identity adopts synchronously at initialize, so no wait is
    // needed before the first tool call.
    rpcId += 1;
    const workerInit = await postInitialize(ctx.port, rpcId, 'vitest', { [AGENT_DECK_RUN_TOKEN_HEADER]: token });
    expect(workerInit.status).toBe(200);
    const workerId = workerInit.headers.get('mcp-session-id');
    expect(workerId).toBeTruthy();
    await workerInit.arrayBuffer();
    const worker = { id: workerId as string, headers: { [AGENT_DECK_RUN_TOKEN_HEADER]: token } };
    const requested = await call(ctx, worker, 'request_deck_assignment', { workspace: wt });
    expect(requested.isError).toBe(true);
    expect(requested.data).toMatchObject({ code: 'PROFILE_DENIED', profile: 'edit', tool: 'request_deck_assignment' });

    const context = await call(ctx, worker, 'get_session_context', {});
    expect(context.data.code).not.toBe('PROFILE_DENIED');

    release();
    const finished = await untilTerminal(ctx, leader, runId);
    expect((finished.denials as Array<Record<string, unknown>>).map((denial) => denial.target)).toEqual([
      'request_deck_assignment',
    ]);
  });

  it('leaders still bind into a live-run workspace (no hold); workers learn no runtime session id', async () => {
    const hold = deferred();
    const release = hold.release;
    const ctx = await setup({
      steps: () => [{ event: { kind: 'text', text: 'working', sessionId: 'ses_1' }, gate: hold.promise }, ...successSteps().slice(1)],
    });
    const wt = worktree();
    const leader = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    const { runId, token } = await startRun(ctx, leader, { tools: 'edit' });

    // Leader/owner sessions are unchanged: a tokenless session may bind into a live-run workspace.
    const outsider = await open(ctx, dealerHeaders(ctx.deckA.id, worktree()));
    const moved = await call(ctx, outsider, 'bind_workspace', { workspaceRoot: wt, deckId: ctx.deckA.id });
    expect(moved.isError, JSON.stringify(moved.data)).toBe(false);
    expect(typeof moved.data.runtime_session_id).toBe('string');
    const fresh = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    const freshBinding = await call(ctx, fresh, 'get_session_binding', {});
    expect(freshBinding.isError, JSON.stringify(freshBinding.data)).toBe(false);

    // The leader session bound before the run re-binds the same workspace and deck.
    const rebind = await call(ctx, leader, 'bind_workspace', { workspaceRoot: wt, deckId: ctx.deckA.id });
    expect(rebind.isError, JSON.stringify(rebind.data)).toBe(false);
    expect(typeof rebind.data.runtime_session_id).toBe('string');

    // The edit worker may bind, but learns no backend session credential.
    const worker = await open(ctx, dealerHeaders(ctx.deckA.id, wt, { [AGENT_DECK_RUN_TOKEN_HEADER]: token }));
    const workerBind = await call(ctx, worker, 'bind_workspace', { workspaceRoot: wt, deckId: ctx.deckA.id });
    expect(workerBind.isError, JSON.stringify(workerBind.data)).toBe(false);
    expect(workerBind.data).not.toHaveProperty('runtime_session_id');

    release();
    await untilTerminal(ctx, leader, runId);
  });

  it('switch_deck from a worker creates no approval the dashboard could act on', async () => {
    const hold = deferred();
    const release = hold.release;
    const ctx = await setup({
      steps: () => [{ event: { kind: 'text', text: 'working', sessionId: 'ses_1' }, gate: hold.promise }, ...successSteps().slice(1)],
    });
    const wt = worktree();
    const leader = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    const { token } = await startRun(ctx, leader, { tools: 'edit' });
    const worker = await open(ctx, dealerHeaders(ctx.deckA.id, wt, { [AGENT_DECK_RUN_TOKEN_HEADER]: token }));
    await call(ctx, worker, 'switch_deck', { target: ctx.deckB.name });

    // The dashboard resolve endpoint has nothing to resolve for this session.
    const runtimeSessionId = ctx.store.findActiveRuntimeSessionByMcpSessionId(worker.id)?.sessionId;
    const resolve = await fetch(`${ctx.backendUrl}/api/trusted-session/deck-switch/no-such-request/resolve`, {
      method: 'POST',
      headers: { ...dashboardAuthHeaders(ctx.store), 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtimeSessionId, decision: 'session' }),
    });
    expect(resolve.status).toBe(404);
    expect(ctx.store.listPendingDeckSwitchRequests()).toEqual([]);
    release();
  });
});
