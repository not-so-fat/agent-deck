/**
 * NOT-539: start_run / get_run / cancel_run from a Dealer-style bound MCP
 * session, through the real MCP server, HTTP policy layer, trusted-session
 * routes, and the one backend Agent Run service (fixture adapter — no model).
 *
 * Evidence for: tool registration and strict schemas (no deckId / cwd),
 * session-deck + launch-workspace resolution (session-only switch included,
 * no `.agent-deck/use.json` read or written), exact service mapping (fresh,
 * resume, edit + finalization, pinned version), cursor paging to a truthful
 * terminal state, idempotent cancel, deck/workspace scope refusal, reconnect
 * access, and WORKSPACE_REQUIRED with zero adapter launches.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_DECK_DECK_ID_HEADER,
  AGENT_DECK_SESSION_HEADER,
  AGENT_DECK_WORKSPACE_HEADER,
  generateId,
} from '@agent-deck/shared';

import type { AdapterStartArgs, ClientAdapter, NormalizedEvent, RunClient } from '../agent-run';
import { createBackendAgentRunService } from '../agent-run-api/host';
import { AuditStore } from '../audit/store';
import type { AgentDeckMCPServer } from '../mcp-server';
import { DatabaseManager } from '../models/database';
import { LiveDisplayRegistry } from '../scope/live-display-registry';
import { registerAgentRunRoutes } from '../routes/agent-runs';
import { registerCredentialRoutes } from '../routes/credentials';
import { registerDeckRoutes } from '../routes/decks';
import { registerPlaybookRoutes } from '../routes/playbooks';
import { registerScopeRoutes } from '../routes/scope';
import { registerServiceRoutes } from '../routes/services';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import type { ServiceManager } from '../services/service-manager';
import { dashboardAuthHeaders } from '../test/auth-fixtures';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import { MCP_ACCEPT, callToolMcpResult, listTools, openSession, startMcpServer } from './test-harness';

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

/** Dealer-style role worktree: a host folder with no `.agent-deck/use.json`. */
function worktree(): string {
  const dir = makeDir('ad-mcp-run-wt-');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  return dir;
}

function gitWorktree(): string {
  const dir = worktree();
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
  };
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'add', 'README.md');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'init');
  return dir;
}

/** Recursive listing with contents, so any write under the worktree shows up. */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out[`${path.relative(root, full)}/`] = '';
        walk(full);
      } else {
        out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
      }
    }
  };
  walk(root);
  return out;
}

describe('MCP agent run tools (NOT-539)', () => {
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
    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const home = makeDir('ad-mcp-run-home-');

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

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('auditStore', new AuditStore(db.getSqliteDatabase()));
    fastify.decorate('serviceManager', {
      getAllServices: async () => [],
      getService: async () => null,
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
    fastify.decorate('patchManager', { listOpenPatchSummaries: async () => [], snapshotVersion: async () => {} });
    fastify.decorate('broadcastServiceUpdate', () => {});
    fastify.decorate('storeWriter', { writeDeck: async () => {} });
    fastify.decorate('liveDisplayRegistry', new LiveDisplayRegistry());

    registerHttpPolicyHook(fastify);
    await fastify.register(registerServiceRoutes, { prefix: '/api/services' });
    await fastify.register(registerPlaybookRoutes, { prefix: '/api/playbooks' });
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

    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    return { db, deckA, deckB, store, home, starts, createAdapter, launch, backendUrl, port: started.port };
  }

  type Ctx = Awaited<ReturnType<typeof setup>>;

  /** A Dealer-launched session: launch deck header plus the role worktree. */
  function dealerHeaders(deckId: string, workspace?: string): Record<string, string> {
    return { [AGENT_DECK_DECK_ID_HEADER]: deckId, ...(workspace ? { [AGENT_DECK_WORKSPACE_HEADER]: workspace } : {}) };
  }

  let rpcId = 100;
  async function call(ctx: Ctx, session: { id: string; headers: Record<string, string> }, name: string, args: unknown) {
    rpcId += 1;
    return callToolMcpResult(ctx.port, session.id, name, args, rpcId, session.headers);
  }

  async function open(ctx: Ctx, headers: Record<string, string>) {
    rpcId += 1;
    return { id: await openSession(ctx.port, rpcId, headers), headers };
  }

  async function approveSessionSwitch(ctx: Ctx, session: { id: string; headers: Record<string, string> }, target: string) {
    const requested = await call(ctx, session, 'switch_deck', { target });
    expect(requested.data.status).toBe('pending');
    const runtimeSessionId = ctx.store.findActiveRuntimeSessionByMcpSessionId(session.id)?.sessionId;
    const resolve = await fetch(`${ctx.backendUrl}/api/trusted-session/deck-switch/${requested.data.requestId}/resolve`, {
      method: 'POST',
      headers: { ...dashboardAuthHeaders(ctx.store), 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtimeSessionId, decision: 'session' }),
    });
    expect(resolve.status).toBe(200);
  }

  async function startRun(ctx: Ctx, session: { id: string; headers: Record<string, string> }, args: Record<string, unknown> = {}) {
    const result = await call(ctx, session, 'start_run', { client: 'claude', prompt: 'do the thing', ...args });
    expect(result.isError, JSON.stringify(result.data)).toBe(false);
    return result.data.runId as string;
  }

  async function untilTerminal(ctx: Ctx, session: { id: string; headers: Record<string, string> }, runId: string) {
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

  /** Raw tools/call: SDK input-validation failures are plain text, not JSON. */
  async function rawCall(ctx: Ctx, session: { id: string; headers: Record<string, string> }, name: string, args: unknown) {
    rpcId += 1;
    const response = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: MCP_ACCEPT, 'mcp-session-id': session.id, ...session.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = (await response.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    return { isError: Boolean(body.result?.isError), text: body.result?.content?.[0]?.text ?? '' };
  }

  it('registers exactly start_run, get_run, cancel_run; start_run exposes no deckId or cwd and rejects them before launch', async () => {
    const ctx = await setup();
    const wt = worktree();
    const session = await open(ctx, dealerHeaders(ctx.deckA.id, wt));

    rpcId += 1;
    const tools = (await listTools(ctx.port, session.id, rpcId, session.headers)) as Array<{
      name: string;
      inputSchema?: { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };
    }>;
    const runTools = tools.filter((tool) => tool.name.endsWith('_run')).map((tool) => tool.name).sort();
    expect(runTools).toEqual(['cancel_run', 'get_run', 'start_run']);

    const shapes = Object.fromEntries(
      tools
        .filter((tool) => runTools.includes(tool.name))
        .map((tool) => [
          tool.name,
          {
            properties: Object.keys(tool.inputSchema?.properties ?? {}).sort(),
            required: [...(tool.inputSchema?.required ?? [])].sort(),
            additionalProperties: tool.inputSchema?.additionalProperties,
          },
        ]),
    );
    expect(shapes).toEqual({
      start_run: {
        properties: ['client', 'playbookVersion', 'prepareFinalization', 'prompt', 'resumeSessionId', 'tools'],
        required: ['client', 'prompt'],
        additionalProperties: false,
      },
      get_run: { properties: ['after', 'limit', 'runId'], required: ['runId'], additionalProperties: false },
      cancel_run: { properties: ['runId'], required: ['runId'], additionalProperties: false },
    });

    for (const extra of [{ deckId: ctx.deckB.id }, { cwd: '/tmp' }]) {
      const rejected = await rawCall(ctx, session, 'start_run', { client: 'claude', prompt: 'p', ...extra });
      expect(rejected.isError).toBe(true);
      expect(rejected.text).toContain(Object.keys(extra)[0]);
    }
    expect(ctx.launch).not.toHaveBeenCalled();
    expect(ctx.createAdapter).not.toHaveBeenCalled();
  });

  it('runs on the session-only switched deck in the launch worktree without reading or writing .agent-deck/use.json', async () => {
    const ctx = await setup();
    const wt = worktree();
    const before = snapshotTree(wt);
    const session = await open(ctx, dealerHeaders(ctx.deckA.id, wt));

    await approveSessionSwitch(ctx, session, 'beta');
    const context = await call(ctx, session, 'get_session_context', {});
    expect(context.data.effective_deck_id).toBe(ctx.deckB.id);

    const runId = await startRun(ctx, session);
    const terminal = await untilTerminal(ctx, session, runId);
    expect(terminal).toMatchObject({ runId, deckId: ctx.deckB.id, client: 'claude', tools: 'readonly', state: 'ended' });

    expect(ctx.launch).toHaveBeenCalledTimes(1);
    expect(ctx.launch.mock.calls[0][0]).toMatchObject({ deckRef: ctx.deckB.id, cwd: wt, trustedBinding: { deckId: ctx.deckB.id } });
    expect(ctx.starts).toHaveLength(1);
    expect(ctx.starts[0].cwd).toBe(wt);
    expect(fs.existsSync(path.join(wt, '.agent-deck'))).toBe(false);
    expect(snapshotTree(wt)).toEqual(before);
  });

  it('maps fresh, resume, edit + finalization, and pinned-version starts to the existing service request', async () => {
    const ctx = await setup();
    const wt = gitWorktree();
    const playbook = await ctx.db.createPlaybook({ id: 'pb_pinned', title: 't', body: 'b', triggers: ['x'] });
    await ctx.db.addPlaybookToDeck({ deckId: ctx.deckA.id, playbookId: playbook.id, position: 0 });
    const version = await ctx.db.createPlaybookVersion({
      id: generateId(),
      playbookId: playbook.id,
      title: 'old',
      body: 'old body',
      triggers: ['x'],
      patchId: null,
      actor: 'agent',
    });
    const session = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    const base = { deckRef: ctx.deckA.id, client: 'claude', cwd: wt, prompt: 'do the thing', trustedBinding: { deckId: ctx.deckA.id } };

    const fresh = await startRun(ctx, session);
    await untilTerminal(ctx, session, fresh);
    expect(ctx.launch.mock.calls[0][0]).toEqual({ ...base, tools: 'readonly' });

    const resumed = await startRun(ctx, session, { resumeSessionId: 'ses_1' });
    await untilTerminal(ctx, session, resumed);
    expect(ctx.launch.mock.calls[1][0]).toEqual({ ...base, tools: 'readonly', resumeId: 'ses_1' });

    const edit = await startRun(ctx, session, { tools: 'edit', prepareFinalization: true });
    const editRun = await untilTerminal(ctx, session, edit);
    expect(ctx.launch.mock.calls[2][0]).toEqual({ ...base, tools: 'edit' });
    expect(ctx.launch.mock.calls[2][1]).toMatchObject({ runId: edit, ownProcessGroup: true, beforeStart: expect.any(Function) });
    expect(editRun.finalization).toMatchObject({ state: 'prepared' });

    const pinned = await startRun(ctx, session, { playbookVersion: { playbookId: playbook.id, versionId: version.id } });
    await untilTerminal(ctx, session, pinned);
    expect(ctx.launch.mock.calls[3][0]).toEqual({
      ...base,
      tools: 'readonly',
      playbookPin: { playbookId: playbook.id, versionId: version.id },
    });
    expect(ctx.starts[3].playbookPin).toEqual({ playbookId: playbook.id, versionId: version.id });

    // Invalid pins and readonly finalization still fail closed before any model work.
    const unknownPin = await call(ctx, session, 'start_run', {
      client: 'claude',
      prompt: 'p',
      playbookVersion: { playbookId: playbook.id, versionId: 'no-such-version' },
    });
    expect(unknownPin.isError).toBe(true);
    expect(unknownPin.data).toMatchObject({ error_code: 'INVALID_REQUEST', message: 'Unknown playbook version: no-such-version' });
    const readonlyFinalize = await call(ctx, session, 'start_run', { client: 'claude', prompt: 'p', prepareFinalization: true });
    expect(readonlyFinalize.data).toMatchObject({ error_code: 'FINALIZATION_INVALID' });
    expect(ctx.starts).toHaveLength(4);
  });

  it('pages ordered events by cursor to the terminal event and survives an MCP reconnect', async () => {
    const ctx = await setup();
    const wt = worktree();
    const headers = dealerHeaders(ctx.deckA.id, wt);
    const session = await open(ctx, headers);
    const runId = await startRun(ctx, session);
    await untilTerminal(ctx, session, runId);

    const seen: Array<{ seq: number; type: string }> = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const read = await call(ctx, session, 'get_run', { runId, limit: 2, ...(after ? { after } : {}) });
      expect(read.isError).toBe(false);
      expect(read.data.state).toBe('ended');
      const events = read.data.events as Array<{ seq: number; type: string }>;
      expect(events.length).toBeLessThanOrEqual(2);
      if (events.length === 0) {
        expect(read.data.nextCursor).toBe(after);
        break;
      }
      seen.push(...events.map(({ seq, type }) => ({ seq, type })));
      after = String(read.data.nextCursor);
    }
    expect(seen.map((event) => event.type)).toEqual(['text', 'tool', 'notice', 'result', 'end']);
    expect(seen.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);

    // A new MCP session with the same deck/workspace launch context still reaches the run.
    const reconnected = await open(ctx, headers);
    const again = await call(ctx, reconnected, 'get_run', { runId });
    expect(again.isError).toBe(false);
    expect(again.data).toMatchObject({ runId, state: 'ended', nextCursor: '5' });
  });

  it('refuses get_run and cancel_run for a run on another deck or another workspace', async () => {
    const gate = deferred();
    const ctx = await setup({
      steps: () => [{ event: { kind: 'text', text: 'working', sessionId: 'ses_1' } }, { event: { kind: 'text', text: 'late' }, gate: gate.promise }],
    });
    const wt = worktree();
    const owner = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    const runId = await startRun(ctx, owner);

    // Same deck, different launch worktree.
    const otherWorkspace = await open(ctx, dealerHeaders(ctx.deckA.id, worktree()));
    // Same worktree, but the session moved to another deck (session-only switch).
    const switched = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    await approveSessionSwitch(ctx, switched, 'beta');

    for (const [session, fragment] of [
      [otherWorkspace, 'another workspace'],
      [switched, 'another deck'],
    ] as const) {
      for (const tool of ['get_run', 'cancel_run']) {
        const denied = await call(ctx, session, tool, { runId });
        expect(denied.isError).toBe(true);
        expect(denied.data.error_code).toBe('RESOURCE_OUT_OF_SCOPE');
        expect(String(denied.data.message)).toContain(fragment);
      }
    }
    const still = await call(ctx, owner, 'get_run', { runId });
    expect(still.data.state).not.toBe('canceled');
    gate.release();
    await untilTerminal(ctx, owner, runId);
  });

  it('cancels a live run idempotently and leaves a finished run unchanged', async () => {
    const gate = deferred();
    let held = true;
    const ctx = await setup({
      steps: () =>
        held
          ? [{ event: { kind: 'text', text: 'working', sessionId: 'ses_live' } }, { event: { kind: 'text', text: 'never' }, gate: gate.promise }]
          : successSteps(),
    });
    const wt = worktree();
    const session = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    const live = await startRun(ctx, session);
    for (let i = 0; i < 200; i += 1) {
      const read = await call(ctx, session, 'get_run', { runId: live });
      if (read.data.state === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const first = await call(ctx, session, 'cancel_run', { runId: live });
    expect(first.isError).toBe(false);
    expect(first.data).toMatchObject({ runId: live, state: 'canceled' });
    const repeat = await call(ctx, session, 'cancel_run', { runId: live });
    expect(repeat.data).toMatchObject({ runId: live, state: 'canceled' });
    gate.release();
    const read = await call(ctx, session, 'get_run', { runId: live });
    const events = read.data.events as Array<{ type: string }>;
    expect(events.at(-1)?.type).toBe('canceled');
    expect(events.filter((event) => event.type === 'canceled')).toHaveLength(1);

    held = false;
    const finished = await startRun(ctx, session);
    await untilTerminal(ctx, session, finished);
    const late = await call(ctx, session, 'cancel_run', { runId: finished });
    expect(late.isError).toBe(false);
    expect(late.data).toMatchObject({ runId: finished, state: 'ended' });
  });

  it('fails WORKSPACE_REQUIRED before any adapter starts when the launch named no workspace', async () => {
    const ctx = await setup();
    const session = await open(ctx, dealerHeaders(ctx.deckA.id));
    // bind_workspace names a folder, but that is agent-chosen — never the execution workspace.
    await call(ctx, session, 'bind_workspace', { workspaceRoot: worktree(), deckId: ctx.deckA.id });

    for (const [tool, args] of [
      ['start_run', { client: 'claude', prompt: 'p' }],
      ['get_run', { runId: 'run-20260101T000000-abcdef' }],
      ['cancel_run', { runId: 'run-20260101T000000-abcdef' }],
    ] as const) {
      const result = await call(ctx, session, tool, args);
      expect(result.isError).toBe(true);
      expect(result.data.error_code).toBe('WORKSPACE_REQUIRED');
      const message = String(result.data.message);
      for (const forbidden of ['agent-deck use', 'agent-deck ', 'CLI', 'install', '1110', '1111', 'localhost', '127.0.0.1', 'http']) {
        expect(message).not.toContain(forbidden);
      }
    }

    // A follow-up request that now names a workspace cannot grant one: the
    // launch's absence was frozen at initial authentication.
    const lateHeaders = dealerHeaders(ctx.deckA.id, worktree());
    const late = await call(ctx, { id: session.id, headers: lateHeaders }, 'start_run', { client: 'claude', prompt: 'p' });
    expect(late.isError).toBe(true);
    expect(late.data.error_code).toBe('WORKSPACE_REQUIRED');
    const afterLate = await call(ctx, { id: session.id, headers: lateHeaders }, 'start_run', { client: 'claude', prompt: 'p' });
    expect(afterLate.data.error_code).toBe('WORKSPACE_REQUIRED');

    // The backend refuses the same start, whatever workspace a caller claims.
    const runtimeSessionId = ctx.store.findActiveRuntimeSessionByMcpSessionId(session.id)?.sessionId;
    for (const claimed of [{}, { 'x-agent-deck-execution-workspace': worktree() }, { [AGENT_DECK_WORKSPACE_HEADER]: worktree() }]) {
      const direct = await fetch(`${ctx.backendUrl}/api/trusted-session/agent-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [AGENT_DECK_SESSION_HEADER]: String(runtimeSessionId), ...claimed },
        body: JSON.stringify({ client: 'claude', prompt: 'p' }),
      });
      expect(direct.status).toBe(422);
      expect(((await direct.json()) as { error_code: string }).error_code).toBe('WORKSPACE_REQUIRED');
    }

    expect(ctx.launch).not.toHaveBeenCalled();
    expect(ctx.createAdapter).not.toHaveBeenCalled();
    expect(ctx.starts).toHaveLength(0);
  });

  it('derives the run workspace and scope from the runtime session, ignoring a caller-claimed workspace', async () => {
    const ctx = await setup();
    const wt = worktree();
    const other = worktree();
    const session = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    const runtimeSessionId = String(ctx.store.findActiveRuntimeSessionByMcpSessionId(session.id)?.sessionId);
    const forged = { [AGENT_DECK_SESSION_HEADER]: runtimeSessionId, 'x-agent-deck-execution-workspace': other };

    const started = await fetch(`${ctx.backendUrl}/api/trusted-session/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...forged },
      body: JSON.stringify({ client: 'claude', prompt: 'p' }),
    });
    expect(started.status).toBe(202);
    const { runId } = ((await started.json()) as { data: { runId: string } }).data;
    await untilTerminal(ctx, session, runId);
    expect(ctx.starts).toHaveLength(1);
    expect(fs.realpathSync(ctx.starts[0].cwd)).toBe(fs.realpathSync(wt));

    // A run launched in `other` stays out of scope for this session even
    // when the caller claims `other` as its workspace.
    const elsewhere = await open(ctx, dealerHeaders(ctx.deckA.id, other));
    const foreign = await startRun(ctx, elsewhere);
    for (const [method, suffix] of [['GET', ''], ['POST', '/cancel']] as const) {
      const response = await fetch(`${ctx.backendUrl}/api/trusted-session/agent-runs/${foreign}${suffix}`, {
        method,
        headers: forged,
      });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error_code: string }).error_code).toBe('RESOURCE_OUT_OF_SCOPE');
    }
    await untilTerminal(ctx, elsewhere, foreign);
  });

  it('fails WORKSPACE_INVALID when the launch worktree no longer exists', async () => {
    const ctx = await setup();
    const wt = worktree();
    const session = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    fs.rmSync(wt, { recursive: true, force: true });
    const result = await call(ctx, session, 'start_run', { client: 'claude', prompt: 'p' });
    expect(result.data).toMatchObject({ error_code: 'WORKSPACE_INVALID' });
    expect(ctx.createAdapter).not.toHaveBeenCalled();
  });

  /**
   * NOT-540: the documented `agent-deck-run` skill loop, end to end, from a
   * Dealer-style launch (deck header + role worktree, no `.agent-deck/use.json`):
   * get_session_context → session-only switch_deck → get_session_context →
   * pinned start_run → cursor-paged get_run to terminal → resume via
   * start_run(resumeSessionId) → cancel_run — with the saved workspace default
   * absent before and after.
   */
  it('NOT-540: runs the skill loop from a Dealer-style launch and leaves the saved workspace default absent', async () => {
    const gate = deferred();
    let mode: 'success' | 'held' = 'success';
    const ctx = await setup({
      steps: () =>
        mode === 'held'
          ? [{ event: { kind: 'text', text: 'working', sessionId: 'ses_1' } }, { event: { kind: 'text', text: 'never' }, gate: gate.promise }]
          : successSteps(),
    });
    const wt = gitWorktree();
    const before = snapshotTree(wt);
    const playbook = await ctx.db.createPlaybook({ id: 'pb_eval', title: 'live', body: 'live body', triggers: ['eval'] });
    await ctx.db.addPlaybookToDeck({ deckId: ctx.deckB.id, playbookId: playbook.id, position: 0 });
    const version = await ctx.db.createPlaybookVersion({
      id: generateId(),
      playbookId: playbook.id,
      title: 'baseline',
      body: 'baseline body',
      triggers: ['eval'],
      patchId: null,
      actor: 'agent',
    });

    // Launch-selected deck + workspace, exactly as Dealer starts a role session.
    const session = await open(ctx, dealerHeaders(ctx.deckA.id, wt));
    await call(ctx, session, 'bind_workspace', { workspaceRoot: wt, deckId: ctx.deckA.id });
    const opener = await call(ctx, session, 'get_session_context', {});
    expect(opener.isError).toBe(false);
    expect(opener.data.effective_deck_id).toBe(ctx.deckA.id);
    const bindingBefore = await call(ctx, session, 'get_session_binding', {});
    expect(bindingBefore.data.workspace_default_deck_id).toBeNull();

    // 1. Session-only switch, then refresh context.
    await approveSessionSwitch(ctx, session, 'beta');
    const refreshed = await call(ctx, session, 'get_session_context', {});
    expect(refreshed.data.effective_deck_id).toBe(ctx.deckB.id);

    // 2-3. Brief in memory; pinned-version start on the switched deck.
    const runId = await startRun(ctx, session, {
      tools: 'readonly',
      prompt: 'Goal: summarize README.md. Done when: one sentence. If unclear, end your turn with the question.',
      playbookVersion: { playbookId: playbook.id, versionId: version.id },
    });

    // 4. Page get_run with its event cursor until terminal and drained.
    const events: Array<{ seq: number; type: string }> = [];
    let after: string | undefined;
    let status: Record<string, unknown> = {};
    for (let i = 0; i < 400; i += 1) {
      const read = await call(ctx, session, 'get_run', { runId, limit: 2, ...(after ? { after } : {}) });
      expect(read.isError, JSON.stringify(read.data)).toBe(false);
      status = read.data;
      const page = read.data.events as Array<{ seq: number; type: string }>;
      events.push(...page.map(({ seq, type }) => ({ seq, type })));
      after = String(read.data.nextCursor ?? after ?? '');
      const terminal = ['ended', 'error', 'died', 'canceled'].includes(String(read.data.state));
      if (terminal && page.length === 0) break;
      if (!terminal) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(status).toMatchObject({ runId, deckId: ctx.deckB.id, client: 'claude', tools: 'readonly', state: 'ended', sessionId: 'ses_1' });
    expect(events.map((event) => event.type)).toEqual(['text', 'tool', 'notice', 'result', 'end']);
    expect(ctx.launch.mock.calls[0][0]).toMatchObject({
      deckRef: ctx.deckB.id,
      cwd: wt,
      tools: 'readonly',
      playbookPin: { playbookId: playbook.id, versionId: version.id },
    });
    expect(ctx.starts[0].cwd).toBe(wt);

    // 6a. Resume the same session through start_run (profile passed again).
    const resumed = await startRun(ctx, session, { tools: 'readonly', resumeSessionId: String(status.sessionId) });
    const resumedTerminal = await untilTerminal(ctx, session, resumed);
    expect(resumedTerminal).toMatchObject({ runId: resumed, deckId: ctx.deckB.id, state: 'ended', sessionId: 'ses_1' });
    expect(ctx.launch.mock.calls[1][0]).toMatchObject({ resumeId: 'ses_1', cwd: wt, deckRef: ctx.deckB.id });

    // 6b. Cancel a live run through cancel_run.
    mode = 'held';
    const live = await startRun(ctx, session, { tools: 'readonly', resumeSessionId: 'ses_1' });
    for (let i = 0; i < 200; i += 1) {
      const read = await call(ctx, session, 'get_run', { runId: live });
      if (read.data.state === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const canceled = await call(ctx, session, 'cancel_run', { runId: live });
    expect(canceled.data).toMatchObject({ runId: live, state: 'canceled' });
    gate.release();

    // The saved workspace default stayed absent; the worktree was not touched.
    const bindingAfter = await call(ctx, session, 'get_session_binding', {});
    expect(bindingAfter.data.workspace_default_deck_id).toBeNull();
    expect(bindingAfter.data.effective_deck_id).toBe(ctx.deckB.id);
    expect(fs.existsSync(path.join(wt, '.agent-deck', 'use.json'))).toBe(false);
    expect(snapshotTree(wt)).toEqual(before);

    // CI receipt: safe identifiers and outcomes only (no prompt text).
    console.info(
      'NOT-540 receipt',
      JSON.stringify({
        runId,
        sessionId: status.sessionId,
        tools: status.tools,
        effectiveDeck: 'beta',
        worktree: path.basename(wt),
        events: events.map((event) => `${event.seq}:${event.type}`),
        terminal: status.state,
        resumed: { runId: resumed, state: resumedTerminal.state },
        canceled: { runId: live, state: canceled.data.state },
        workspaceDefault: bindingAfter.data.workspace_default_deck_id,
        useJson: 'absent',
      }),
    );
  });
});
