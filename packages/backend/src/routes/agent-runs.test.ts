/**
 * NOT-480: agent run HTTP API through injected adapters.
 *
 * Evidence for: run-enabled grant authorization (every principal/deck case),
 * pre-launch validation with zero adapter starts on denial, Idempotency-Key
 * semantics (sequential and concurrent), truthful lifecycle states with
 * cursor-ordered events, redaction, and payload-free audit records.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_RUN_PROMPT_MAX_CHARS,
  AGENT_RUN_REQUEST_BODY_LIMIT_BYTES,
  AgentRunCapabilitiesResponseSchema,
  AgentRunEventsResponseSchema,
  AgentRunStatusSchema,
  CreateAgentRunResponseSchema,
} from '@agent-deck/shared';

import {
  createClaudeAdapter,
  createCodexAdapter,
  createCursorAdapter,
  defaultKillProcessGroup,
  readRunMeta,
  runPaths,
  writeRunMeta,
  type AdapterStartArgs,
  type ClientAdapter,
  type NormalizedEvent,
  type RunClient,
  type AgentRunServiceDeps,
} from '../agent-run';
import { createBackendAgentRunService } from '../agent-run-api/host';
import { AuditStore } from '../audit/store';
import { ClientGrantStore, parseGrantToken } from '../auth/client-grants';
import { HOSTED_RUN_AUTH_FAILURE_LIMIT, registerHostedModeGuard } from '../auth/hosted-mode';
import { DatabaseManager } from '../models/database';
import { dashboardAuthHeaders } from '../test/auth-fixtures';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { resolveRoutePolicy } from '../trusted-session/route-policy-registry';
import { TrustedSessionStore } from '../trusted-session/store';
import { registerAgentRunRoutes } from './agent-runs';

const PROMPT_SENTINEL = 'PROMPT_SENTINEL_do_not_store_7f3a';
const RESULT_SENTINEL = 'RESULT_SENTINEL_do_not_audit_91c2';

type Step = { event: NormalizedEvent; gate?: Promise<void> };
type Script = { steps?: Step[]; fail?: Error; finishGate?: Promise<void> };

type Fixture = ClientAdapter & { starts: AdapterStartArgs[] };

/** In-memory adapter: no process, no model. Gates hold the stream at chosen points. */
function fixtureAdapter(client: RunClient, script: () => Script): Fixture {
  const starts: AdapterStartArgs[] = [];
  return {
    id: client,
    starts,
    async preflight() {
      return { ok: true };
    },
    planStart() {
      return { ok: true, trustOverride: false };
    },
    async *start(args) {
      starts.push(args);
      const current = script();
      for (const step of current.steps ?? []) {
        if (step.gate) {
          await step.gate;
        }
        yield step.event;
      }
      if (current.finishGate) {
        await current.finishGate;
      }
      if (current.fail) {
        throw current.fail;
      }
    },
  };
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function successSteps(result: unknown = RESULT_SENTINEL, subtype = 'success'): Step[] {
  return [
    { event: { kind: 'text', text: 'working', sessionId: 'ses_1' } },
    { event: { kind: 'tool', name: 'Read', sessionId: 'ses_1' } },
    { event: { kind: 'notice', message: 'heads up', sessionId: 'ses_1' } },
    { event: { kind: 'result', subtype, result, sessionId: 'ses_1' } },
  ];
}

async function waitFor<T>(read: () => Promise<T> | T, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 400; i += 1) {
    const value = await read();
    if (done(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

const tmpDirs: string[] = [];
const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  while (apps.length) {
    await apps.pop()?.close();
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** A host folder whose `.agent-deck/use.json` assigns it to `deck`. */
function assignedCwd(deck: { id: string; name: string }): string {
  const dir = makeDir('ad-runs-cwd-');
  fs.mkdirSync(path.join(dir, '.agent-deck'));
  fs.writeFileSync(
    path.join(dir, '.agent-deck', 'use.json'),
    JSON.stringify({ version: 3, deckId: deck.id, deckName: deck.name }),
  );
  return dir;
}

type BuildOptions = {
  script?: () => Script;
  claudeOk?: boolean;
  createAdapter?: (client: RunClient) => ClientAdapter | undefined;
  hosted?: boolean;
  service?: Partial<AgentRunServiceDeps>;
  /** Restart: reuse a previous app's home, database, decks, and grant. */
  restartOf?: App;
};

async function buildApp(options: BuildOptions = {}) {
  const previous = options.restartOf;
  const home = previous?.home ?? makeDir('ad-runs-home-');
  const db = previous?.db ?? new DatabaseManager(':memory:');
  const deckA = previous?.deckA ?? (await db.createDeck({ name: 'runs-deck-a' }));
  const deckB = previous?.deckB ?? (await db.createDeck({ name: 'runs-deck-b' }));
  const sessions = new TrustedSessionStore(db.getSqliteDatabase());
  const grants = new ClientGrantStore(db.getSqliteDatabase());
  const audit = new AuditStore(db.getSqliteDatabase());
  const adapter = fixtureAdapter('codex', options.script ?? (() => ({ steps: successSteps() })));
  const createAdapter = vi.fn((client: RunClient): ClientAdapter => options.createAdapter?.(client) ?? adapter);
  const service = createBackendAgentRunService(db, home, {
    createAdapter,
    claudeProbe: async () => (options.claudeOk === false ? { ok: false, reason: 'not-signed-in' } : { ok: true }),
    ...options.service,
  });

  const fastify = Fastify();
  fastify.decorate('db', db);
  fastify.decorate('trustedSessionStore', sessions);
  fastify.decorate('grantStore', grants);
  fastify.decorate('auditStore', audit);
  if (options.hosted) {
    registerHostedModeGuard(fastify, { enabled: true, publicOrigin: 'https://deck.example.test' });
  }
  registerHttpPolicyHook(fastify);
  await fastify.register(registerAgentRunRoutes, { prefix: '/api', service });
  await fastify.ready();
  apps.push(fastify);

  const runGrant =
    previous?.runGrant ?? grants.issueGrant({ label: 'coordinator', defaultDeck: deckA.id, runsEnabled: true });
  const cwdA = previous?.cwdA ?? assignedCwd(deckA);
  return { fastify, db, home, sessions, grants, audit, adapter, createAdapter, deckA, deckB, runGrant, cwdA };
}

type App = {
  fastify: ReturnType<typeof Fastify>;
  db: DatabaseManager;
  home: string;
  sessions: TrustedSessionStore;
  grants: ClientGrantStore;
  audit: AuditStore;
  adapter: Fixture;
  createAdapter: ReturnType<typeof vi.fn>;
  deckA: { id: string; name: string };
  deckB: { id: string; name: string };
  runGrant: ReturnType<ClientGrantStore['issueGrant']>;
  cwdA: string;
};

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function startBody(app: App, extra: Record<string, unknown> = {}) {
  return { deckId: app.deckA.id, client: 'codex', cwd: app.cwdA, prompt: PROMPT_SENTINEL, tools: 'readonly', ...extra };
}

let keyCounter = 0;
function freshKey(): string {
  keyCounter += 1;
  return `key-${keyCounter}-${Date.now()}`;
}

function post(app: App, token: string, payload: unknown, key: string | null = freshKey()) {
  return app.fastify.inject({
    method: 'POST',
    url: '/api/agent-runs',
    headers: { ...bearer(token), ...(key === null ? {} : { 'idempotency-key': key }) },
    payload: payload as Record<string, unknown>,
  });
}

function getStatus(app: App, token: string, runId: string) {
  return app.fastify.inject({ method: 'GET', url: `/api/agent-runs/${runId}`, headers: bearer(token) });
}

function getEvents(app: App, token: string, runId: string, query = '') {
  return app.fastify.inject({
    method: 'GET',
    url: `/api/agent-runs/${runId}/events${query}`,
    headers: bearer(token),
  });
}

async function startRun(app: App, token = app.runGrant.token, extra: Record<string, unknown> = {}): Promise<string> {
  const response = await post(app, token, startBody(app, extra));
  expect(response.statusCode, response.body).toBe(202);
  return response.json().data.runId as string;
}

async function terminalStatus(app: App, runId: string) {
  return waitFor(
    async () => (await getStatus(app, app.runGrant.token, runId)).json().data,
    (data) => ['ended', 'error', 'died'].includes(data.state),
  );
}

describe('agent run route policy (NOT-480)', () => {
  it('registers every run route under the run-grant policy', () => {
    expect(resolveRoutePolicy('POST', '/api/agent-runs')).toBe('requireRunGrant');
    // NOT-481: the owner dashboard may also inspect and cancel any run.
    expect(resolveRoutePolicy('GET', '/api/agent-runs/capabilities')).toBe('requireRunGrantOrDashboard');
    expect(resolveRoutePolicy('GET', '/api/agent-runs/run-20261013T000000-abcdef')).toBe('requireRunGrantOrDashboard');
    expect(resolveRoutePolicy('GET', '/api/agent-runs/run-20261013T000000-abcdef/events')).toBe(
      'requireRunGrantOrDashboard',
    );
    expect(resolveRoutePolicy('POST', '/api/agent-runs/run-20261013T000000-abcdef/cancel')).toBe(
      'requireRunGrantOrDashboard',
    );
  });
});

describe('agent run authorization (NOT-480)', () => {
  it('denies missing, malformed, MCP-only, revoked, expired, dashboard, and wrong-deck principals with zero starts', async () => {
    const app = await buildApp();
    const runId = await startRun(app);
    await terminalStatus(app, runId);
    expect(app.adapter.starts).toHaveLength(1);

    const mcpOnly = app.grants.issueGrant({ label: 'mcp-only', defaultDeck: app.deckA.id });
    const revoked = app.grants.issueGrant({ label: 'revoked', defaultDeck: app.deckA.id, runsEnabled: true });
    app.grants.revokeGrant(revoked.grant.id);
    const expired = app.grants.issueGrant({
      label: 'expired',
      defaultDeck: app.deckA.id,
      runsEnabled: true,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const wrongDeck = app.grants.issueGrant({ label: 'deck-b', defaultDeck: app.deckB.id, runsEnabled: true });

    const cases: Array<{ name: string; headers: Record<string, string>; status: number; code: string }> = [
      { name: 'missing', headers: {}, status: 401, code: 'GRANT_REQUIRED' },
      { name: 'malformed', headers: bearer('not-a-grant'), status: 401, code: 'GRANT_REQUIRED' },
      { name: 'mcp-only', headers: bearer(mcpOnly.token), status: 403, code: 'RUN_CAPABILITY_REQUIRED' },
      { name: 'revoked', headers: bearer(revoked.token), status: 401, code: 'GRANT_REQUIRED' },
      { name: 'expired', headers: bearer(expired.token), status: 401, code: 'GRANT_REQUIRED' },
      { name: 'wrong-deck', headers: bearer(wrongDeck.token), status: 403, code: 'RESOURCE_OUT_OF_SCOPE' },
    ];

    for (const testCase of cases) {
      const requests = [
        { method: 'POST' as const, url: '/api/agent-runs', payload: startBody(app), headers: { 'idempotency-key': freshKey() } },
        { method: 'GET' as const, url: `/api/agent-runs/${runId}` },
        { method: 'GET' as const, url: `/api/agent-runs/${runId}/events` },
      ];
      for (const request of requests) {
        const response = await app.fastify.inject({
          ...request,
          headers: { ...(request.headers ?? {}), ...testCase.headers },
        });
        expect(response.statusCode, `${testCase.name} ${request.method} ${request.url}`).toBe(testCase.status);
        expect(response.json(), testCase.name).toMatchObject({ success: false, error_code: testCase.code });
      }
    }
    expect(app.adapter.starts).toHaveLength(1);

    // NOT-481: the owner dashboard inspects any run but never starts one.
    const owner = dashboardAuthHeaders(app.sessions);
    const ownerStart = await app.fastify.inject({
      method: 'POST',
      url: '/api/agent-runs',
      payload: startBody(app),
      headers: { ...owner, 'idempotency-key': freshKey() },
    });
    expect(ownerStart.statusCode).toBe(401);
    expect(ownerStart.json()).toMatchObject({ success: false, error_code: 'GRANT_REQUIRED' });
    expect((await app.fastify.inject({ method: 'GET', url: `/api/agent-runs/${runId}`, headers: owner })).statusCode).toBe(200);
    expect(app.adapter.starts).toHaveLength(1);

    // The same run-enabled grant on its allowed deck reads the run.
    expect((await getStatus(app, app.runGrant.token, runId)).statusCode).toBe(200);
    expect((await getEvents(app, app.runGrant.token, runId)).statusCode).toBe(200);
  });

  it('a grant allowing several decks may run on each, and the owner can enable an existing MCP-only grant', async () => {
    const app = await buildApp();
    const grant = app.grants.issueGrant({
      label: 'two-decks',
      defaultDeck: app.deckA.id,
      allowedDecks: [app.deckA.id, app.deckB.id],
    });
    expect((await post(app, grant.token, startBody(app))).statusCode).toBe(403);
    app.grants.setRunsEnabled(grant.grant.id, true);

    await startRun(app, grant.token);
    await startRun(app, grant.token, { deckId: app.deckB.id, cwd: assignedCwd(app.deckB) });
    expect(app.adapter.starts).toHaveLength(2);
  });
});

describe('agent runs in hosted mode (NOT-480)', () => {
  it('authorizes by grant bearer instead of the dashboard cookie, and exposes no HEAD bypass', async () => {
    const app = await buildApp({ hosted: true });
    const runId = await startRun(app);
    expect((await getStatus(app, app.runGrant.token, runId)).statusCode).toBe(200);

    const anonymous = await app.fastify.inject({
      method: 'POST',
      url: '/api/agent-runs',
      headers: { 'idempotency-key': freshKey() },
      payload: startBody(app),
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error_code: 'GRANT_REQUIRED' });

    const head = await app.fastify.inject({ method: 'HEAD', url: `/api/agent-runs/${runId}` });
    expect(head.statusCode).toBe(404);
    expect(app.adapter.starts).toHaveLength(1);
  });

  it('rate-limits failed bearers on reads before they append more audit rows', async () => {
    const app = await buildApp({ hosted: true });
    const runId = await startRun(app);
    const deniedRows = () => app.audit.list({ limit: 200 }).filter((row) => row.event === 'agent_run.denied');

    for (let attempt = 0; attempt < HOSTED_RUN_AUTH_FAILURE_LIMIT; attempt += 1) {
      const response = await getStatus(app, 'adg_not-a-real-grant', runId);
      expect(response.statusCode).toBe(401);
    }
    expect(deniedRows()).toHaveLength(HOSTED_RUN_AUTH_FAILURE_LIMIT);

    const limited = await getEvents(app, 'adg_not-a-real-grant', runId);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(deniedRows()).toHaveLength(HOSTED_RUN_AUTH_FAILURE_LIMIT);
  });
});

describe('POST /api/agent-runs validation (NOT-480)', () => {
  it('rejects every invalid fixture before model work with a stable error code', async () => {
    const app = await buildApp();
    const fileCwd = path.join(app.cwdA, 'file.txt');
    fs.writeFileSync(fileCwd, 'x');
    const unassigned = makeDir('ad-runs-unassigned-');
    const otherDeckCwd = assignedCwd(app.deckB);
    const ghostDeck = '00000000-0000-4000-8000-0000000000aa';
    const wide = app.grants.issueGrant({
      label: 'wide',
      defaultDeck: app.deckA.id,
      allowedDecks: [app.deckA.id, app.deckB.id, ghostDeck],
      runsEnabled: true,
    });

    const fixtures: Array<{ name: string; payload: unknown; key?: string | null; status: number; code: string }> = [
      { name: 'no key', payload: startBody(app), key: null, status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' },
      { name: 'bad key', payload: startBody(app), key: 'has space', status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' },
      { name: 'unknown client', payload: startBody(app, { client: 'gemini' }), status: 400, code: 'INVALID_REQUEST' },
      { name: 'relative cwd', payload: startBody(app, { cwd: 'repo' }), status: 400, code: 'INVALID_REQUEST' },
      { name: 'empty prompt', payload: startBody(app, { prompt: '   ' }), status: 400, code: 'INVALID_REQUEST' },
      {
        name: 'prompt too long',
        payload: startBody(app, { prompt: 'x'.repeat(AGENT_RUN_PROMPT_MAX_CHARS + 1) }),
        status: 400,
        code: 'INVALID_REQUEST',
      },
      { name: 'unknown tools', payload: startBody(app, { tools: 'all' }), status: 400, code: 'INVALID_REQUEST' },
      { name: 'extra field', payload: startBody(app, { pid: 1 }), status: 400, code: 'INVALID_REQUEST' },
      { name: 'empty resume', payload: startBody(app, { resumeSessionId: '' }), status: 400, code: 'INVALID_REQUEST' },
      {
        name: 'missing cwd',
        payload: startBody(app, { cwd: path.join(app.cwdA, 'missing') }),
        status: 422,
        code: 'WORKSPACE_INVALID',
      },
      { name: 'file cwd', payload: startBody(app, { cwd: fileCwd }), status: 422, code: 'WORKSPACE_INVALID' },
      { name: 'unassigned cwd', payload: startBody(app, { cwd: unassigned }), status: 422, code: 'WORKSPACE_MISMATCH' },
      {
        name: 'mismatched cwd',
        payload: startBody(app, { cwd: otherDeckCwd }),
        status: 422,
        code: 'WORKSPACE_MISMATCH',
      },
      { name: 'unknown deck', payload: startBody(app, { deckId: ghostDeck }), status: 404, code: 'DECK_NOT_FOUND' },
    ];

    for (const fixture of fixtures) {
      const response = await post(app, wide.token, fixture.payload, fixture.key === undefined ? freshKey() : fixture.key);
      expect(response.statusCode, `${fixture.name}: ${response.body}`).toBe(fixture.status);
      expect(response.json(), fixture.name).toMatchObject({ success: false, error_code: fixture.code });
      // Errors never echo the prompt or the host's CLI-worded remedies.
      expect(response.body, fixture.name).not.toContain(PROMPT_SENTINEL);
      expect(response.body, fixture.name).not.toContain('agent-deck use');
    }

    const oversized = await app.fastify.inject({
      method: 'POST',
      url: '/api/agent-runs',
      headers: { ...bearer(wide.token), 'idempotency-key': freshKey(), 'content-type': 'application/json' },
      payload: JSON.stringify(startBody(app, { prompt: 'x'.repeat(AGENT_RUN_REQUEST_BODY_LIMIT_BYTES) })),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ success: false, error_code: 'REQUEST_TOO_LARGE' });

    expect(app.createAdapter).not.toHaveBeenCalled();
    expect(app.adapter.starts).toEqual([]);
    expect(fs.existsSync(path.join(app.home, 'runs'))).toBe(false);
  });

  it('fails closed for an unavailable client and a resume the client cannot verify', async () => {
    const spawn = vi.fn();
    const codex = createCodexAdapter({
      probe: () => ({ code: 0, stdout: 'Logged in using ChatGPT', stderr: '' }),
      spawn,
      isGitRepo: () => true,
    });
    const app = await buildApp({ claudeOk: false, createAdapter: () => codex });

    const claude = await post(app, app.runGrant.token, startBody(app, { client: 'claude' }));
    expect(claude.statusCode).toBe(503);
    expect(claude.json()).toMatchObject({ error_code: 'CLIENT_UNAVAILABLE' });

    // Codex resume keeps the thread's original sandbox, so a session no
    // Agent Deck run on this host started fails closed (NOT-484 provenance).
    const resumedEdit = await post(
      app,
      app.runGrant.token,
      startBody(app, { tools: 'edit', resumeSessionId: 'thread-opaque-1' }),
    );
    expect(resumedEdit.statusCode).toBe(422);
    expect(resumedEdit.json()).toMatchObject({ error_code: 'RESUME_UNVERIFIED' });
    expect(resumedEdit.body).not.toContain('--tools');
    expect(resumedEdit.body).not.toContain('agent-deck run');

    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(app.home, 'runs'))).toBe(false);
  });

  it('starts and resumes through the shared service and returns 202 with an opaque run id', async () => {
    const app = await buildApp();
    const start = await post(app, app.runGrant.token, { ...startBody(app), tools: undefined });
    expect(start.statusCode).toBe(202);
    const created = CreateAgentRunResponseSchema.parse(start.json().data);
    expect(created.runId).toMatch(/^run-/);
    expect(app.adapter.starts[0]).toEqual({
      cwd: app.cwdA,
      prompt: PROMPT_SENTINEL,
      tools: 'readonly',
      control: expect.objectContaining({ signal: expect.any(AbortSignal) }),
    });

    const first = await terminalStatus(app, created.runId);
    expect(first.sessionId).toBe('ses_1');

    const resume = await post(app, app.runGrant.token, startBody(app, { resumeSessionId: first.sessionId }));
    expect(resume.statusCode).toBe(202);
    const resumedId = resume.json().data.runId;
    expect(resumedId).not.toBe(created.runId);
    expect(app.adapter.starts[1]).toEqual({
      cwd: app.cwdA,
      prompt: PROMPT_SENTINEL,
      tools: 'readonly',
      resumeId: 'ses_1',
      resumedFrom: { runId: created.runId, sessionId: 'ses_1', tools: 'readonly' },
      control: expect.objectContaining({ signal: expect.any(AbortSignal) }),
    });
  });
});

describe('Idempotency-Key (NOT-480)', () => {
  it('returns the original run for the same normalized body and 409 for another body', async () => {
    const app = await buildApp();
    const key = freshKey();
    const first = await post(app, app.runGrant.token, startBody(app), key);
    expect(first.statusCode).toBe(202);
    const runId = first.json().data.runId;
    await terminalStatus(app, runId);

    // Same request with reordered keys and the defaulted profile omitted.
    const { tools: _tools, ...withoutTools } = startBody(app);
    const reordered = Object.fromEntries(Object.entries(withoutTools).reverse());
    const repeat = await post(app, app.runGrant.token, reordered, key);
    expect(repeat.statusCode).toBe(202);
    expect(repeat.json().data).toEqual({ runId, state: 'ended' });

    const conflict = await post(app, app.runGrant.token, startBody(app, { prompt: 'another brief' }), key);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ success: false, error_code: 'IDEMPOTENCY_CONFLICT' });
    expect(conflict.body).not.toContain(runId);

    // Keys are scoped per grant: another grant's identical key is its own run.
    const other = app.grants.issueGrant({ label: 'other', defaultDeck: app.deckA.id, runsEnabled: true });
    const otherRun = await post(app, other.token, startBody(app), key);
    expect(otherRun.statusCode).toBe(202);
    expect(otherRun.json().data.runId).not.toBe(runId);

    expect(app.adapter.starts).toHaveLength(2);
  });

  it('concurrent requests with one key start exactly one run', async () => {
    const hold = deferred();
    const app = await buildApp({ script: () => ({ steps: successSteps(), finishGate: hold.promise }) });
    const key = freshKey();

    const responses = await Promise.all([
      ...Array.from({ length: 5 }, () => post(app, app.runGrant.token, startBody(app), key)),
      post(app, app.runGrant.token, startBody(app, { tools: 'edit' }), key),
    ]);
    const accepted = responses.filter((response) => response.statusCode === 202);
    const conflicts = responses.filter((response) => response.statusCode === 409);
    expect(accepted).toHaveLength(5);
    expect(conflicts).toHaveLength(1);
    expect(new Set(accepted.map((response) => response.json().data.runId)).size).toBe(1);
    expect(app.adapter.starts).toHaveLength(1);

    hold.release();
    await terminalStatus(app, accepted[0].json().data.runId);
    expect(app.adapter.starts).toHaveLength(1);
  });

  it('a request that failed closed frees its key for a corrected retry', async () => {
    const app = await buildApp();
    const key = freshKey();
    const bad = await post(app, app.runGrant.token, startBody(app, { cwd: makeDir('ad-runs-unassigned-') }), key);
    expect(bad.statusCode).toBe(422);
    const good = await post(app, app.runGrant.token, startBody(app), key);
    expect(good.statusCode).toBe(202);
    expect(app.adapter.starts).toHaveLength(1);
  });
});

describe('status and ordered events (NOT-480)', () => {
  it('moves starting → running → ended and pages events in order by cursor', async () => {
    const firstEvent = deferred();
    const finish = deferred();
    const steps = successSteps();
    steps[0] = { ...steps[0], gate: firstEvent.promise };
    const app = await buildApp({ script: () => ({ steps, finishGate: finish.promise }) });
    const token = app.runGrant.token;

    const created = await post(app, token, startBody(app));
    expect(created.json().data.state).toBe('starting');
    const runId = created.json().data.runId;

    const starting = AgentRunStatusSchema.parse((await getStatus(app, token, runId)).json().data);
    expect(starting).toMatchObject({
      runId,
      deckId: app.deckA.id,
      client: 'codex',
      tools: 'readonly',
      state: 'starting',
      sessionId: null,
      lastEventAt: null,
    });
    const empty = (await getEvents(app, token, runId)).json().data;
    expect(empty).toEqual({ runId, state: 'starting', events: [], nextCursor: '0' });

    firstEvent.release();
    const running = await waitFor(
      async () => (await getStatus(app, token, runId)).json().data,
      (data) => data.state === 'running' && data.sessionId === 'ses_1',
    );
    expect(running.lastEventAt).not.toBeNull();
    // Still running after the result event: a result is not the terminal state.
    await waitFor(
      async () => (await getEvents(app, token, runId)).json().data.events.length,
      (count) => count === 4,
    );
    expect((await getStatus(app, token, runId)).json().data.state).toBe('running');

    finish.release();
    expect((await terminalStatus(app, runId)).state).toBe('ended');

    const page1 = AgentRunEventsResponseSchema.parse((await getEvents(app, token, runId, '?limit=2')).json().data);
    expect(page1.state).toBe('ended');
    expect(page1.events.map((event) => [event.seq, event.type])).toEqual([[1, 'text'], [2, 'tool']]);
    expect(page1.nextCursor).toBe('2');
    const page2 = AgentRunEventsResponseSchema.parse(
      (await getEvents(app, token, runId, `?after=${page1.nextCursor}`)).json().data,
    );
    expect(page2.events.map((event) => [event.seq, event.type])).toEqual([
      [3, 'notice'],
      [4, 'result'],
      [5, 'end'],
    ]);
    expect(page2.events[1]).toMatchObject({ type: 'result', subtype: 'success', result: RESULT_SENTINEL, sessionId: 'ses_1' });
    const drained = (await getEvents(app, token, runId, `?after=${page2.nextCursor}`)).json().data;
    expect(drained.events).toEqual([]);
    expect(drained.nextCursor).toBe(page2.nextCursor);

    const badCursor = await getEvents(app, token, runId, '?after=abc');
    expect(badCursor.statusCode).toBe(400);
    expect((await getStatus(app, token, 'run-20991231T000000-000000')).statusCode).toBe(404);
    expect((await getStatus(app, token, '..%2Fetc')).statusCode).toBe(404);
  });

  it('derives ended/error from the result subtype and stream outcome, never from result prose', async () => {
    let script: Script = { steps: successSteps('the build FAILED badly', 'success') };
    const app = await buildApp({ script: () => script });
    const token = app.runGrant.token;

    const proseFailure = await startRun(app);
    expect((await terminalStatus(app, proseFailure)).state).toBe('ended');

    script = { steps: successSteps('success! all good', 'error_max_turns') };
    const subtypeError = await startRun(app);
    expect((await terminalStatus(app, subtypeError)).state).toBe('error');
    const subtypeEvents = (await getEvents(app, token, subtypeError)).json().data.events;
    expect(subtypeEvents.map((event: { type: string }) => event.type)).toEqual(['text', 'tool', 'notice', 'result', 'end']);

    script = { steps: successSteps().slice(0, 1), fail: new Error('client exited 1') };
    const crashed = await startRun(app);
    expect((await terminalStatus(app, crashed)).state).toBe('error');
    const crashedEvents = (await getEvents(app, token, crashed)).json().data;
    expect(crashedEvents.state).toBe('error');
    expect(crashedEvents.events.map((event: { type: string }) => event.type)).toEqual(['text', 'error']);
    expect(crashedEvents.events[1]).toMatchObject({ type: 'error', message: 'client exited 1', sessionId: 'ses_1' });
  });

  it('reports died when the recorded process is gone, without waiting forever', async () => {
    const hold = deferred();
    const app = await buildApp({ script: () => ({ steps: successSteps().slice(0, 1), finishGate: hold.promise }) });
    const runId = await startRun(app);
    await waitFor(
      async () => (await getStatus(app, app.runGrant.token, runId)).json().data.state,
      (state) => state === 'running',
    );

    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
    const { metaPath } = runPaths(app.home, runId);
    const meta = readRunMeta(metaPath);
    if (!meta.ok) throw new Error(meta.reason);
    writeRunMeta(metaPath, { ...meta.meta, pid: deadPid });

    expect((await getStatus(app, app.runGrant.token, runId)).json().data.state).toBe('died');
    expect((await getEvents(app, app.runGrant.token, runId)).json().data.state).toBe('died');
    hold.release();
  });
});

describe('redaction and audit (NOT-480)', () => {
  it('responses and audit rows carry no pid, log path, cwd, bearer, prompt, or result body', async () => {
    const app = await buildApp();
    const token = app.runGrant.token;
    const secret = parseGrantToken(token)!.secret;
    const runId = await startRun(app);
    await terminalStatus(app, runId);

    const created = await post(app, token, startBody(app));
    const status = await getStatus(app, token, runId);
    const denied = await post(app, token, startBody(app, { cwd: makeDir('ad-runs-unassigned-') }));
    const responses = [created, status, denied].map((response) => response.body);

    const statusKeys = Object.keys(status.json().data).sort();
    expect(statusKeys).toEqual([
      'client',
      'deckId',
      'finalization',
      'lastEventAt',
      'runId',
      'sessionId',
      'startedAt',
      'state',
      'tools',
    ]);
    expect(status.json().data.finalization).toBeNull();
    for (const body of responses) {
      expect(body).not.toContain(PROMPT_SENTINEL);
      expect(body).not.toContain(RESULT_SENTINEL);
      expect(body).not.toContain(app.home);
      expect(body).not.toContain(app.cwdA);
      expect(body).not.toContain(token);
      expect(body).not.toContain(secret);
      expect(body).not.toMatch(/"(pid|logPath|metaPath|cwd|authorization|prompt)"/i);
    }

    // The events stream is the one place model output appears — still no host details.
    const events = (await getEvents(app, token, runId)).body;
    expect(events).toContain(RESULT_SENTINEL);
    expect(events).not.toContain(app.home);
    expect(events).not.toContain(PROMPT_SENTINEL);
    expect(events).not.toMatch(/"(pid|logPath|cwd)"/);

    const auditDump = JSON.stringify(app.audit.list({ limit: 100 }));
    for (const forbidden of [PROMPT_SENTINEL, RESULT_SENTINEL, token, secret, app.home, app.cwdA, 'Bearer']) {
      expect(auditDump).not.toContain(forbidden);
    }
  });

  it('appends scoped creation, denial, and terminal audit events', async () => {
    let script: Script = { steps: successSteps() };
    const app = await buildApp({ script: () => script });
    const grantId = app.runGrant.grant.id;

    const ended = await startRun(app);
    await terminalStatus(app, ended);
    script = { steps: [], fail: new Error('boom') };
    const failed = await startRun(app);
    await terminalStatus(app, failed);

    await post(app, app.runGrant.token, startBody(app, { cwd: assignedCwd(app.deckB) }));
    await post(app, app.runGrant.token, startBody(app, { deckId: app.deckB.id }));
    const mcpOnly = app.grants.issueGrant({ label: 'mcp-only', defaultDeck: app.deckA.id });
    await post(app, mcpOnly.token, startBody(app));
    await post(app, 'adg_garbage', startBody(app));

    const rows = await waitFor(
      () => app.audit.list({ limit: 100 }),
      (list) => list.filter((row) => row.event === 'agent_run.finished').length === 2,
    );
    const pick = (row: (typeof rows)[number]) => ({
      actor: row.actor,
      event: row.event,
      targetId: row.targetId,
      outcome: row.outcome,
      reasonCode: row.reasonCode,
    });
    expect(rows.map(pick)).toEqual(
      expect.arrayContaining([
        { actor: grantId, event: 'agent_run.created', targetId: ended, outcome: 'succeeded', reasonCode: null },
        { actor: grantId, event: 'agent_run.finished', targetId: ended, outcome: 'succeeded', reasonCode: null },
        { actor: grantId, event: 'agent_run.created', targetId: failed, outcome: 'succeeded', reasonCode: null },
        { actor: grantId, event: 'agent_run.finished', targetId: failed, outcome: 'failed', reasonCode: 'run_error' },
        {
          actor: grantId,
          event: 'agent_run.denied',
          targetId: app.deckA.id,
          outcome: 'denied',
          reasonCode: 'workspace_mismatch',
        },
        {
          actor: grantId,
          event: 'agent_run.denied',
          targetId: app.deckB.id,
          outcome: 'denied',
          reasonCode: 'resource_out_of_scope',
        },
        {
          actor: mcpOnly.grant.id,
          event: 'agent_run.denied',
          targetId: 'agent-runs',
          outcome: 'denied',
          reasonCode: 'run_capability_required',
        },
        {
          actor: 'ag_unknown',
          event: 'agent_run.denied',
          targetId: 'agent-runs',
          outcome: 'denied',
          reasonCode: 'invalid_credentials',
        },
      ]),
    );
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(PROMPT_SENTINEL);
    expect(dump).not.toContain(RESULT_SENTINEL);
    expect(dump).not.toContain('boom');
  });
});

// ---------------------------------------------------------------------------
// NOT-481: capabilities, cancellation, restart reconciliation, grant scope.
// ---------------------------------------------------------------------------

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cancel(app: App, headers: Record<string, string>, runId: string) {
  return app.fastify.inject({ method: 'POST', url: `/api/agent-runs/${runId}/cancel`, headers });
}

function eventTypes(body: { data: { events: Array<{ type: string }> } }): string[] {
  return body.data.events.map((event) => event.type);
}

function readMeta(app: App, runId: string) {
  const read = readRunMeta(runPaths(app.home, runId).metaPath);
  if (!read.ok) throw new Error(read.reason);
  return read.meta;
}

type ProbeAnswers = Record<string, { code: number; stdout?: string; stderr?: string }>;
const probeFrom = (answers: ProbeAnswers) => (_bin: string, argv: string[]) => {
  const answer = answers[argv.join(' ')] ?? { code: 127 };
  return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
};

const codexSignedIn: ProbeAnswers = {
  '--version': { code: 0, stdout: 'codex-cli 0.157.1' },
  'login status': { code: 0, stderr: 'Logged in using ChatGPT' },
};

describe('GET /api/agent-runs/capabilities (NOT-481)', () => {
  const capabilityApp = (codex: ProbeAnswers, claudeOk = true) =>
    buildApp({
      claudeOk,
      // Real adapters with injected host probes: availability is the real preflight.
      createAdapter: (client) =>
        client === 'codex'
          ? createCodexAdapter({ bin: 'codex', probe: probeFrom(codex) })
          : client === 'claude'
            ? createClaudeAdapter({ query: () => (async function* () {})() })
            : client === 'cursor'
              ? createCursorAdapter({ bin: 'cursor-agent', probe: probeFrom({}) })
              : fixtureAdapter('muse', () => ({})),
    });

  it('lists only clients whose real preflight passes, with start/resume profile restrictions', async () => {
    const app = await capabilityApp(codexSignedIn);
    const response = await app.fastify.inject({
      method: 'GET',
      url: '/api/agent-runs/capabilities',
      headers: bearer(app.runGrant.token),
    });
    expect(response.statusCode, response.body).toBe(200);
    const data = AgentRunCapabilitiesResponseSchema.parse(response.json().data);
    expect(data.host).toBe('same-host');
    expect(data.clients).toEqual([
      { client: 'claude', start: ['readonly', 'edit'], resume: ['readonly', 'edit'], resumeRequires: 'none' },
      // codex resume cannot re-apply a sandbox: same-profile Agent Deck provenance only.
      {
        client: 'codex',
        start: ['readonly', 'edit'],
        resume: ['readonly', 'edit'],
        resumeRequires: 'same_profile_provenance',
      },
      { client: 'muse', start: ['readonly', 'edit'], resume: ['readonly', 'edit'], resumeRequires: 'none' },
    ]);
    // cursor-agent is missing on this host, so it is not advertised at all.
    expect(response.body).not.toContain('cursor');
  });

  it('omits a missing binary, a signed-out client, and a signed-out claude', async () => {
    const missing = await capabilityApp({}, false);
    const signedOut = await capabilityApp({
      '--version': { code: 0, stdout: 'codex-cli 0.157.1' },
      'login status': { code: 1, stderr: 'Not logged in' },
    });
    for (const [app, absent] of [
      [missing, ['codex', 'claude']],
      [signedOut, ['codex']],
    ] as const) {
      const response = await app.fastify.inject({
        method: 'GET',
        url: '/api/agent-runs/capabilities',
        headers: bearer(app.runGrant.token),
      });
      const clients = AgentRunCapabilitiesResponseSchema.parse(response.json().data).clients.map((c) => c.client);
      for (const client of absent) {
        expect(clients).not.toContain(client);
      }
      expect(clients).toContain('muse');
    }
  });

  it('requires a run grant or the owner dashboard', async () => {
    const app = await capabilityApp(codexSignedIn);
    const mcpOnly = app.grants.issueGrant({ label: 'mcp-only', defaultDeck: app.deckA.id });
    const get = (headers: Record<string, string>) =>
      app.fastify.inject({ method: 'GET', url: '/api/agent-runs/capabilities', headers });
    expect((await get({})).json()).toMatchObject({ error_code: 'GRANT_REQUIRED' });
    expect((await get(bearer(mcpOnly.token))).json()).toMatchObject({ error_code: 'RUN_CAPABILITY_REQUIRED' });
    expect((await get(dashboardAuthHeaders(app.sessions))).statusCode).toBe(200);
  });
});

/**
 * A codex stand-in on disk: prints a thread id, then waits on a grandchild
 * in its own process group, so a group signal is observable on both.
 */
function codexFixtureBin(): { bin: string; grandchildPidFile: string } {
  const dir = makeDir('ad-runs-codex-bin-');
  const grandchildPidFile = path.join(dir, 'grandchild.pid');
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `echo '{"type":"thread.started","thread_id":"th_cancel_fixture"}'`,
      'sleep 30 &',
      `echo $! > '${grandchildPidFile}'`,
      'wait',
      `echo '{"type":"item.completed","item":{"type":"agent_message","text":"late result"}}'`,
      `echo '{"type":"turn.completed"}'`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { bin, grandchildPidFile };
}

describe('POST /api/agent-runs/:runId/cancel (NOT-481)', () => {
  it('signals only the run-owned process group and records one terminal canceled event', async () => {
    const { bin, grandchildPidFile } = codexFixtureBin();
    const kills: number[] = [];
    const app = await buildApp({
      createAdapter: () => createCodexAdapter({ bin, probe: probeFrom(codexSignedIn), isGitRepo: () => true }),
      service: {
        killProcessGroup: (pgid) => {
          kills.push(pgid);
          defaultKillProcessGroup(pgid);
        },
      },
    });
    const runId = await startRun(app);
    const meta = await waitFor(
      () => readMeta(app, runId),
      (value) => value.pgid !== undefined && fs.existsSync(grandchildPidFile),
    );
    const pgid = meta.pgid!;
    const grandchild = Number(fs.readFileSync(grandchildPidFile, 'utf8').trim());
    expect(pgid).not.toBe(process.pid);
    expect(meta.pid).toBe(process.pid);
    expect(isAlive(pgid) && isAlive(grandchild)).toBe(true);

    const first = await cancel(app, bearer(app.runGrant.token), runId);
    expect(first.statusCode, first.body).toBe(200);
    expect(AgentRunStatusSchema.parse(first.json().data)).toMatchObject({ runId, state: 'canceled' });
    expect(kills).toEqual([pgid]);
    await waitFor(() => isAlive(pgid) || isAlive(grandchild), (alive) => !alive);
    // Never the backend's own pid or its group.
    expect(kills).not.toContain(process.pid);

    // Idempotent: a repeat changes nothing and signals nothing.
    const again = await cancel(app, bearer(app.runGrant.token), runId);
    expect(again.statusCode).toBe(200);
    expect(again.json().data.state).toBe('canceled');
    expect(kills).toEqual([pgid]);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const events = (await getEvents(app, app.runGrant.token, runId)).json();
    expect(events.data.state).toBe('canceled');
    expect(eventTypes(events).filter((type) => type === 'canceled')).toHaveLength(1);
    expect(eventTypes(events).at(-1)).toBe('canceled');
    expect(eventTypes(events)).not.toContain('result');
    expect(eventTypes(events)).not.toContain('end');
    expect(eventTypes(events)).not.toContain('error');
    expect(readMeta(app, runId).state).toBe('canceled');
  });

  it('suppresses a result the client delivers after cancellation', async () => {
    const gate = deferred();
    const app = await buildApp({
      script: () => ({
        steps: [
          { event: { kind: 'text', text: 'working', sessionId: 'ses_c' } },
          { event: { kind: 'result', subtype: 'success', result: RESULT_SENTINEL, sessionId: 'ses_c' }, gate: gate.promise },
        ],
      }),
    });
    const runId = await startRun(app);
    await waitFor(
      async () => (await getStatus(app, app.runGrant.token, runId)).json().data.state,
      (state) => state === 'running',
    );
    expect((await cancel(app, bearer(app.runGrant.token), runId)).json().data.state).toBe('canceled');
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const status = (await getStatus(app, app.runGrant.token, runId)).json().data;
    expect(status).toMatchObject({ state: 'canceled', sessionId: 'ses_c' });
    const events = await getEvents(app, app.runGrant.token, runId);
    expect(eventTypes(events.json())).toEqual(['text', 'canceled']);
    expect(events.body).not.toContain(RESULT_SENTINEL);
    expect(readMeta(app, runId).state).toBe('canceled');
    expect(app.audit.list({ limit: 100 }).filter((row) => row.event === 'agent_run.finished')).toEqual([]);
  });

  it('returns an already-terminal state without changing history', async () => {
    const app = await buildApp();
    const runId = await startRun(app);
    await terminalStatus(app, runId);
    const before = (await getEvents(app, app.runGrant.token, runId)).json();

    const response = await cancel(app, bearer(app.runGrant.token), runId);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.state).toBe('ended');
    expect((await getEvents(app, app.runGrant.token, runId)).json()).toEqual(before);
    expect(readMeta(app, runId).state).toBe('ended');

    const rows = app.audit.list({ limit: 100 }).filter((row) => row.event === 'agent_run.canceled');
    expect(rows.map((row) => [row.actor, row.targetId, row.outcome, row.reasonCode])).toEqual([
      [app.runGrant.grant.id, runId, 'succeeded', 'already_terminal'],
    ]);
  });
});

describe('agent run grant scope for status, events, and cancel (NOT-481)', () => {
  it('a grant reaches only its own runs; the owner dashboard reaches every run', async () => {
    const hold = deferred();
    const app = await buildApp({ script: () => ({ steps: successSteps().slice(0, 1), finishGate: hold.promise }) });
    const other = app.grants.issueGrant({ label: 'other', defaultDeck: app.deckA.id, runsEnabled: true });
    const runId = await startRun(app);
    const otherRun = await startRun(app, other.token);

    const operations = (headers: Record<string, string>, id: string) => [
      app.fastify.inject({ method: 'GET', url: `/api/agent-runs/${id}`, headers }),
      app.fastify.inject({ method: 'GET', url: `/api/agent-runs/${id}/events`, headers }),
      cancel(app, headers, id),
    ];

    // Same deck, different grant: denied with a stable code, run untouched.
    for (const response of await Promise.all(operations(bearer(other.token), runId))) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ success: false, error_code: 'RESOURCE_OUT_OF_SCOPE' });
    }
    expect((await getStatus(app, app.runGrant.token, runId)).json().data.state).not.toBe('canceled');
    const missing = await cancel(app, bearer(other.token), 'run-20991231T000000-000000');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error_code: 'RUN_NOT_FOUND' });

    // The owner inspects both grants' runs and may cancel either.
    const owner = dashboardAuthHeaders(app.sessions);
    expect((await app.fastify.inject({ method: 'GET', url: `/api/agent-runs/${otherRun}`, headers: owner })).statusCode).toBe(200);
    expect(
      (await app.fastify.inject({ method: 'GET', url: `/api/agent-runs/${otherRun}/events`, headers: owner })).statusCode,
    ).toBe(200);
    expect((await cancel(app, owner, otherRun)).json().data.state).toBe('canceled');

    // The creating grant keeps full access to its own run.
    for (const response of await Promise.all(operations(bearer(app.runGrant.token), runId))) {
      expect(response.statusCode).toBe(200);
    }
    expect((await getStatus(app, app.runGrant.token, runId)).json().data.state).toBe('canceled');
    hold.release();

    const rows = app.audit.list({ limit: 200 });
    expect(
      rows.filter((row) => row.event === 'agent_run.denied' && row.targetId === runId).map((row) => row.actor),
    ).toEqual([other.grant.id, other.grant.id, other.grant.id]);
    expect(
      rows
        .filter((row) => row.event === 'agent_run.canceled')
        .map((row) => [row.actor, row.targetId, row.reasonCode])
        .sort(),
    ).toEqual(
      [
        ['owner', otherRun, null],
        [app.runGrant.grant.id, runId, null],
      ].sort(),
    );
  });
});

describe('restart reconciliation (NOT-481)', () => {
  it('maps canonical evidence to running, died, ended, error, or canceled without inventing success', async () => {
    const hold = deferred();
    const first = await buildApp({ script: () => ({ steps: successSteps().slice(0, 1), finishGate: hold.promise }) });
    const names = ['running', 'launchOnly', 'orphan', 'ended', 'error', 'wrongReceipt', 'noResult', 'canceledLog', 'canceled'];
    const runs: Record<string, string> = {};
    for (const name of names) {
      runs[name] = await startRun(first);
    }
    await waitFor(
      () => names.every((name) => fs.existsSync(runPaths(first.home, runs[name]).logPath)),
      Boolean,
    );
    // Before the restart, cancel one run through the API.
    expect((await cancel(first, bearer(first.runGrant.token), runs.canceled)).json().data.state).toBe('canceled');
    await first.fastify.close();
    hold.release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Rewrite each record as a crashed backend would have left it.
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid!;
    const live = spawn('sleep', ['30'], { stdio: 'ignore' });
    const orphan = spawn('sleep', ['30'], { stdio: 'ignore', detached: true });
    const now = new Date().toISOString();
    const line = (event: Record<string, unknown>) => `${JSON.stringify({ ts: now, ...event })}\n`;
    const receipt = (deck: string) => line({ t: 'text', text: `◆ ${deck} · 1 MCP · 0 keys` });
    const success = line({ t: 'result', subtype: 'success', result: 'ok', sessionId: 'ses_1' });
    const end = line({ t: 'end', sessionId: 'ses_1' });
    const fixtures: Record<string, { pid: number; log: string; pgid?: number }> = {
      running: { pid: live.pid!, log: receipt(first.deckA.name) },
      launchOnly: { pid: deadPid, log: '' },
      orphan: { pid: deadPid, log: receipt(first.deckA.name), pgid: orphan.pid! },
      ended: { pid: deadPid, log: receipt(first.deckA.name) + success + end },
      error: { pid: deadPid, log: receipt(first.deckA.name) + line({ t: 'error', message: 'exit 1', sessionId: null }) },
      wrongReceipt: { pid: deadPid, log: receipt('some-other-deck') + success + end },
      noResult: { pid: deadPid, log: receipt(first.deckA.name) + end },
      canceledLog: { pid: deadPid, log: success + line({ t: 'canceled', sessionId: 'ses_1' }) + end },
    };
    for (const [name, fixture] of Object.entries(fixtures)) {
      const { metaPath, logPath } = runPaths(first.home, runs[name]);
      fs.writeFileSync(logPath, fixture.log);
      writeRunMeta(metaPath, {
        ...readMeta(first, runs[name]),
        state: 'running',
        pid: fixture.pid,
        startedAt: now,
        ...(fixture.pgid ? { pgid: fixture.pgid, pgidStartedAt: now } : {}),
      });
    }

    const kills: number[] = [];
    try {
      const second = await buildApp({
        restartOf: first,
        service: {
          killProcessGroup: (pgid) => {
            kills.push(pgid);
            defaultKillProcessGroup(pgid);
          },
        },
      });
      const expected: Record<string, string> = {
        running: 'running',
        launchOnly: 'died',
        orphan: 'died',
        ended: 'ended',
        error: 'error',
        wrongReceipt: 'error',
        noResult: 'error',
        canceledLog: 'canceled',
        canceled: 'canceled',
      };
      for (const [name, state] of Object.entries(expected)) {
        const status = await getStatus(second, second.runGrant.token, runs[name]);
        expect(status.json().data.state, name).toBe(state);
        // Persisted, so later reads never depend on this process's view.
        expect(readMeta(second, runs[name]).state, name).toBe(state);
      }
      const canceledEvents = (await getEvents(second, second.runGrant.token, runs.canceledLog)).json();
      expect(eventTypes(canceledEvents)).toEqual(['result', 'canceled']);

      // The orphaned group lost its owner, so it was stopped; the live owner was not touched.
      expect(kills).toEqual([orphan.pid]);
      await waitFor(() => isAlive(orphan.pid!), (alive) => !alive);
      expect(isAlive(live.pid!)).toBe(true);

      const reconciled = second.audit
        .list({ limit: 200 })
        .filter((row) => row.event === 'agent_run.reconciled')
        .map((row) => [row.targetId, row.outcome, row.reasonCode]);
      expect(reconciled.sort()).toEqual(
        [
          [runs.launchOnly, 'failed', 'run_died'],
          [runs.orphan, 'failed', 'run_died'],
          [runs.ended, 'succeeded', null],
          [runs.error, 'failed', 'run_error'],
          [runs.wrongReceipt, 'failed', 'run_error'],
          [runs.noResult, 'failed', 'run_error'],
          [runs.canceledLog, 'failed', 'run_canceled'],
        ].sort(),
      );
      const dump = JSON.stringify(second.audit.list({ limit: 200 }));
      expect(dump).not.toContain(first.home);
      expect(dump).not.toContain(PROMPT_SENTINEL);
    } finally {
      live.kill();
      orphan.kill();
    }
  });
});
