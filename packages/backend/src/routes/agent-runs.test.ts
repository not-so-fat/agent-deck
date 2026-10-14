/**
 * NOT-480: agent run HTTP API through injected adapters.
 *
 * Evidence for: run-enabled grant authorization (every principal/deck case),
 * pre-launch validation with zero adapter starts on denial, Idempotency-Key
 * semantics (sequential and concurrent), truthful lifecycle states with
 * cursor-ordered events, redaction, and payload-free audit records.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_RUN_PROMPT_MAX_CHARS,
  AGENT_RUN_REQUEST_BODY_LIMIT_BYTES,
  AgentRunCapabilitiesResponseSchema,
  AgentRunChangesResponseSchema,
  AgentRunEventsResponseSchema,
  AgentRunStatusSchema,
  CreateAgentRunResponseSchema,
  FinalizeAgentRunResponseSchema,
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
import { FinalizationStore } from '../agent-run-api/finalization-store';
import { createGitFinalizer, defaultGitRunner, type GitFinalizer } from '../agent-run-api/git-finalize';
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
  /** NOT-486: Git finalizer (counting runner, pause seams). */
  finalizer?: GitFinalizer;
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
  await fastify.register(registerAgentRunRoutes, {
    prefix: '/api',
    service,
    ...(options.finalizer ? { finalizer: options.finalizer } : {}),
  });
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

// ---------------------------------------------------------------------------
// NOT-486: baseline capture, changes, and exact-manifest finalization.
// ---------------------------------------------------------------------------

const FILE_SENTINEL = 'FILE_CONTENT_SENTINEL_never_returned_5d1e';
const DIRTY_SENTINEL = 'PRE_EXISTING_DIRTY_SENTINEL_never_returned_a0b9';
const MESSAGE_SENTINEL = 'COMMIT_MESSAGE_SENTINEL_not_audited_c33f';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.test',
  GIT_CONFIG_NOSYSTEM: '1',
};

function gitIn(dir: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function writeFile(root: string, rel: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
  fs.chmodSync(path.join(root, rel), mode);
}

function bindFolder(dir: string, deck: { id: string; name: string }): void {
  fs.mkdirSync(path.join(dir, '.agent-deck'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.agent-deck', 'use.json'),
    JSON.stringify({ version: 3, deckId: deck.id, deckName: deck.name }),
  );
}

/**
 * A committed repository assigned to `deck` (the binding file stays
 * untracked), with tracked files to modify, delete, and keep.
 */
function gitRepo(deck: { id: string; name: string }): string {
  const dir = fs.realpathSync(makeDir('ad-fin-repo-'));
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'config', 'user.name', 'Fixture');
  gitIn(dir, 'config', 'user.email', 'fixture@example.test');
  gitIn(dir, 'config', 'commit.gpgsign', 'false');
  writeFile(dir, 'tracked.txt', 'tracked v1\n');
  writeFile(dir, 'old.txt', 'to be deleted\n');
  writeFile(dir, 'keep.txt', 'keep v1\n');
  writeFile(dir, 'README.md', 'readme\n');
  gitIn(dir, 'add', 'tracked.txt', 'old.txt', 'keep.txt', 'README.md');
  gitIn(dir, 'commit', '-q', '-m', 'base');
  bindFolder(dir, deck);
  return dir;
}

/** Pre-existing user work the run must leave alone (and the commit must exclude). */
function dirtyBeforeRun(dir: string): void {
  writeFile(dir, 'keep.txt', `keep v1\n${DIRTY_SENTINEL} local edit\n`);
  writeFile(dir, 'notes.txt', `${DIRTY_SENTINEL} untracked notes\n`);
}

/** What the fixture "agent" changes: new, modified, deleted, and executable files. */
function agentEdits(dir: string): void {
  writeFile(dir, 'src/new.txt', `${FILE_SENTINEL} new\n`);
  writeFile(dir, 'tracked.txt', `tracked v2 ${FILE_SENTINEL}\n`);
  fs.rmSync(path.join(dir, 'old.txt'));
  writeFile(dir, 'bin/run.sh', '#!/bin/sh\necho hi\n', 0o755);
}

function editScript(apply: () => void): () => Script {
  return () => {
    apply();
    return { steps: successSteps() };
  };
}

function prepareBody(app: App, cwd: string, extra: Record<string, unknown> = {}) {
  return startBody(app, { cwd, tools: 'edit', prepareFinalization: true, ...extra });
}

function getChanges(app: App, token: string, runId: string) {
  return app.fastify.inject({ method: 'GET', url: `/api/agent-runs/${runId}/changes`, headers: bearer(token) });
}

function postFinalize(app: App, token: string, runId: string, payload: unknown, key: string | null = freshKey()) {
  return app.fastify.inject({
    method: 'POST',
    url: `/api/agent-runs/${runId}/finalize`,
    headers: { ...bearer(token), ...(key === null ? {} : { 'idempotency-key': key }) },
    payload: payload as Record<string, unknown>,
  });
}

function finalizeBody(changes: { baselineDigest: string; baseCommit: string; files: unknown[] }, extra: Record<string, unknown> = {}) {
  return {
    baselineDigest: changes.baselineDigest,
    expectedBaseCommit: changes.baseCommit,
    reviewId: 'review-1',
    commitMessage: `agent change\n\n${MESSAGE_SENTINEL}\n`,
    files: changes.files,
    ...extra,
  };
}

/** Byte-level snapshot of what a failed finalization must not change. */
function repoSnapshot(dir: string, files: string[]) {
  return {
    head: gitIn(dir, 'rev-parse', 'HEAD'),
    commits: gitIn(dir, 'rev-list', '--all', '--count'),
    staged: gitIn(dir, 'diff', '--cached', '--name-only'),
    status: gitIn(dir, 'status', '--porcelain=v1', '--untracked-files=all'),
    lock: fs.existsSync(path.join(gitIn(dir, 'rev-parse', '--absolute-git-dir'), 'index.lock')),
    files: Object.fromEntries(
      files.map((rel) => [rel, fs.existsSync(path.join(dir, rel)) ? sha256File(path.join(dir, rel)) : null]),
    ),
  };
}

const WATCHED = ['keep.txt', 'notes.txt', 'tracked.txt', 'src/new.txt', 'bin/run.sh', 'old.txt', '.agent-deck/use.json'];

/** One terminal prepared edit run on a dirty repository, plus a finalization-enabled creating grant. */
async function preparedRun(options: { finalizer?: GitFinalizer; repo?: (deck: App['deckA']) => string; edits?: (dir: string) => void } = {}) {
  let repo = '';
  const app = await buildApp({
    script: editScript(() => (options.edits ?? agentEdits)(repo)),
    ...(options.finalizer ? { finalizer: options.finalizer } : {}),
  });
  repo = (options.repo ?? gitRepo)(app.deckA);
  dirtyBeforeRun(repo);
  app.grants.setFinalizationEnabled(app.runGrant.grant.id, true);
  const runId = await startRun(app, app.runGrant.token, { cwd: repo, tools: 'edit', prepareFinalization: true });
  await terminalStatus(app, runId);
  return { app, repo, runId };
}

async function readChanges(app: App, runId: string) {
  const response = await getChanges(app, app.runGrant.token, runId);
  expect(response.statusCode, response.body).toBe(200);
  return AgentRunChangesResponseSchema.parse(response.json().data);
}

describe('prepareFinalization baseline capture (NOT-486)', () => {
  it('captures an opaque baseline for a dirty working tree and exposes no path or dirty content', async () => {
    let repo = '';
    const app = await buildApp({ script: editScript(() => agentEdits(repo)) });
    repo = gitRepo(app.deckA);
    dirtyBeforeRun(repo);
    const created = await post(app, app.runGrant.token, prepareBody(app, repo));
    expect(created.statusCode, created.body).toBe(202);
    const runId = created.json().data.runId as string;
    await terminalStatus(app, runId);

    const status = await getStatus(app, app.runGrant.token, runId);
    const data = AgentRunStatusSchema.parse(status.json().data);
    expect(data.finalization).toMatchObject({ state: 'prepared', commit: null });
    expect(data.finalization?.baselineRef).toMatch(/^bl_[0-9a-f]{24}$/);
    expect(data.finalization?.baselineDigest).toMatch(/^[0-9a-f]{64}$/);
    for (const body of [created.body, status.body]) {
      expect(body).not.toContain(repo);
      expect(body).not.toContain(DIRTY_SENTINEL);
      expect(body).not.toContain('keep.txt');
      expect(body).not.toContain('notes.txt');
    }
    expect(app.adapter.starts).toHaveLength(1);
    // The private baseline is captured before the adapter edits anything.
    expect(app.audit.list({ limit: 50 }).find((row) => row.event === 'agent_run.finalization_prepared')).toMatchObject({
      targetId: runId,
      outcome: 'succeeded',
      detail: { baselineDigest: data.finalization?.baselineDigest },
    });
  });

  it('rejects non-Git, readonly, and dirty-index requests before any adapter start', async () => {
    const app = await buildApp();
    const repo = gitRepo(app.deckA);
    const nonGit = await post(app, app.runGrant.token, prepareBody(app, app.cwdA));
    expect(nonGit.statusCode).toBe(422);
    expect(nonGit.json()).toMatchObject({ error_code: 'FINALIZATION_INVALID' });

    const readonly = await post(app, app.runGrant.token, prepareBody(app, repo, { tools: 'readonly' }));
    expect(readonly.statusCode).toBe(422);
    expect(readonly.json()).toMatchObject({ error_code: 'FINALIZATION_INVALID' });
    const defaultTools = await post(app, app.runGrant.token, { ...prepareBody(app, repo), tools: undefined });
    expect(defaultTools.statusCode).toBe(422);

    writeFile(repo, 'staged.txt', 'staged\n');
    gitIn(repo, 'add', 'staged.txt');
    const key = freshKey();
    const dirtyIndex = await post(app, app.runGrant.token, prepareBody(app, repo), key);
    expect(dirtyIndex.statusCode).toBe(409);
    expect(dirtyIndex.json()).toMatchObject({ error_code: 'INDEX_DIRTY' });
    for (const response of [nonGit, readonly, dirtyIndex]) {
      expect(response.body).not.toContain(repo);
      expect(response.body).not.toContain(app.cwdA);
    }
    expect(app.adapter.starts).toHaveLength(0);
    expect(app.createAdapter).toHaveBeenCalled();
    // Still staged exactly as the user left it; the key is free for a corrected retry.
    expect(gitIn(repo, 'diff', '--cached', '--name-only')).toBe('staged.txt');
    gitIn(repo, 'rm', '-q', '--cached', 'staged.txt');
    expect((await post(app, app.runGrant.token, prepareBody(app, repo), key)).statusCode).toBe(202);
    expect(app.adapter.starts).toHaveLength(1);
  });

  it('a run without prepareFinalization has no baseline and cannot expose changes', async () => {
    const app = await buildApp();
    const repo = gitRepo(app.deckA);
    const runId = await startRun(app, app.runGrant.token, { cwd: repo, tools: 'edit' });
    await terminalStatus(app, runId);
    expect((await getStatus(app, app.runGrant.token, runId)).json().data.finalization).toBeNull();
    const changes = await getChanges(app, app.runGrant.token, runId);
    expect(changes.statusCode).toBe(409);
    expect(changes.json()).toMatchObject({ error_code: 'FINALIZATION_NOT_PREPARED' });
    app.grants.setFinalizationEnabled(app.runGrant.grant.id, true);
    const finalize = await postFinalize(app, app.runGrant.token, runId, {
      baselineDigest: 'a'.repeat(64),
      expectedBaseCommit: gitIn(repo, 'rev-parse', 'HEAD'),
      reviewId: 'r',
      commitMessage: 'm',
      files: [{ path: 'README.md', sha256: 'b'.repeat(64), mode: '100644' }],
    });
    expect(finalize.statusCode).toBe(409);
    expect(finalize.json()).toMatchObject({ error_code: 'FINALIZATION_NOT_PREPARED' });
  });
});

describe('finalization authorization (NOT-486)', () => {
  it('denies every principal but the creating finalization-enabled grant, with zero Git mutation', async () => {
    const { app, repo, runId } = await preparedRun();
    app.grants.setFinalizationEnabled(app.runGrant.grant.id, false);
    const changes = await readChanges(app, runId);
    const body = finalizeBody(changes);
    const before = repoSnapshot(repo, WATCHED);

    const both = { runsEnabled: true, finalizationEnabled: true };
    const mcpOnly = app.grants.issueGrant({ label: 'mcp-only', defaultDeck: app.deckA.id });
    const finalizeOnly = app.grants.issueGrant({ label: 'fin-only', defaultDeck: app.deckA.id, finalizationEnabled: true });
    const revoked = app.grants.issueGrant({ label: 'revoked', defaultDeck: app.deckA.id, ...both });
    app.grants.revokeGrant(revoked.grant.id);
    const expired = app.grants.issueGrant({
      label: 'expired',
      defaultDeck: app.deckA.id,
      ...both,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const wrongDeck = app.grants.issueGrant({ label: 'deck-b', defaultDeck: app.deckB.id, ...both });
    const otherGrant = app.grants.issueGrant({ label: 'other', defaultDeck: app.deckA.id, ...both });
    const owner = dashboardAuthHeaders(app.sessions);

    const cases: Array<{ name: string; headers: Record<string, string>; status: number; code: string }> = [
      { name: 'missing', headers: {}, status: 401, code: 'GRANT_REQUIRED' },
      { name: 'dashboard', headers: owner, status: 401, code: 'GRANT_REQUIRED' },
      { name: 'mcp-only', headers: bearer(mcpOnly.token), status: 403, code: 'RUN_CAPABILITY_REQUIRED' },
      { name: 'finalize-only', headers: bearer(finalizeOnly.token), status: 403, code: 'RUN_CAPABILITY_REQUIRED' },
      { name: 'run-only creator', headers: bearer(app.runGrant.token), status: 403, code: 'FINALIZATION_CAPABILITY_REQUIRED' },
      { name: 'revoked', headers: bearer(revoked.token), status: 401, code: 'GRANT_REQUIRED' },
      { name: 'expired', headers: bearer(expired.token), status: 401, code: 'GRANT_REQUIRED' },
      { name: 'wrong-deck', headers: bearer(wrongDeck.token), status: 403, code: 'RESOURCE_OUT_OF_SCOPE' },
      { name: 'non-creating', headers: bearer(otherGrant.token), status: 403, code: 'RESOURCE_OUT_OF_SCOPE' },
    ];
    for (const testCase of cases) {
      const response = await app.fastify.inject({
        method: 'POST',
        url: `/api/agent-runs/${runId}/finalize`,
        headers: { ...testCase.headers, 'idempotency-key': freshKey() },
        payload: body,
      });
      expect(response.statusCode, testCase.name).toBe(testCase.status);
      expect(response.json(), testCase.name).toMatchObject({ success: false, error_code: testCase.code });
    }
    // Changes belong to the creating grant too.
    for (const token of [otherGrant.token, wrongDeck.token]) {
      const denied = await getChanges(app, token, runId);
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain('tracked.txt');
    }
    expect((await app.fastify.inject({ method: 'GET', url: `/api/agent-runs/${runId}/changes`, headers: owner })).statusCode).toBe(401);
    expect(repoSnapshot(repo, WATCHED)).toEqual(before);

    // The owner enables finalization on the creating grant; run capability is unchanged.
    app.grants.setFinalizationEnabled(app.runGrant.grant.id, true);
    expect(app.grants.getGrant(app.runGrant.grant.id)).toMatchObject({ runsEnabled: true, finalizationEnabled: true });
    const ok = await postFinalize(app, app.runGrant.token, runId, body);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(gitIn(repo, 'rev-parse', 'HEAD')).toBe(ok.json().data.commit);
  });
});

describe('GET /api/agent-runs/:runId/changes (NOT-486)', () => {
  it('returns the ordered run-produced manifest, excluding unchanged pre-existing and binding paths', async () => {
    const { app, repo, runId } = await preparedRun();
    const response = await getChanges(app, app.runGrant.token, runId);
    expect(response.statusCode).toBe(200);
    const data = AgentRunChangesResponseSchema.parse(response.json().data);
    expect(data.baseCommit).toBe(gitIn(repo, 'rev-parse', 'HEAD'));
    expect(data.files).toEqual([
      { path: 'bin/run.sh', sha256: sha256File(path.join(repo, 'bin/run.sh')), mode: '100755' },
      { path: 'old.txt', sha256: null, mode: null },
      { path: 'src/new.txt', sha256: sha256Of(`${FILE_SENTINEL} new\n`), mode: '100644' },
      { path: 'tracked.txt', sha256: sha256Of(`tracked v2 ${FILE_SENTINEL}\n`), mode: '100644' },
    ]);
    expect(Object.keys(response.json().data).sort()).toEqual(
      ['baseCommit', 'baselineDigest', 'baselineRef', 'files', 'manifestDigest', 'runId'].sort(),
    );
    expect(response.body).not.toContain(FILE_SENTINEL);
    expect(response.body).not.toContain(DIRTY_SENTINEL);
    expect(response.body).not.toContain(repo);
    expect(response.body).not.toContain('.agent-deck');
    expect(response.body).not.toContain('keep.txt');
  });

  it('denies a running run and a run whose pre-existing dirty path changed', async () => {
    const hold = deferred();
    let repo = '';
    const app = await buildApp({
      script: () => {
        agentEdits(repo);
        writeFile(repo, 'keep.txt', 'the agent overwrote user work\n');
        return { steps: successSteps(), finishGate: hold.promise };
      },
    });
    repo = gitRepo(app.deckA);
    dirtyBeforeRun(repo);
    const runId = await startRun(app, app.runGrant.token, { cwd: repo, tools: 'edit', prepareFinalization: true });
    await waitFor(() => app.adapter.starts.length, (count) => count === 1);
    const running = await getChanges(app, app.runGrant.token, runId);
    expect(running.statusCode).toBe(409);
    expect(running.json()).toMatchObject({ error_code: 'RUN_NOT_TERMINAL' });
    hold.release();
    await terminalStatus(app, runId);

    const changed = await getChanges(app, app.runGrant.token, runId);
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ error_code: 'BASELINE_MISMATCH' });
    expect(changed.body).not.toContain('keep.txt');
    expect(changed.body).not.toContain(repo);
  });
});

describe('finalize manifest rejection before staging (NOT-486)', () => {
  it('fails closed for invalid, unexpected, stale, and mismatched manifests with an empty index', async () => {
    const { app, repo, runId } = await preparedRun({
      repo: (deck) => {
        const dir = gitRepo(deck);
        // A committed submodule gitlink and a committed symlink that escapes the worktree.
        const outside = fs.realpathSync(makeDir('ad-fin-outside-'));
        writeFile(outside, 'secret', 'outside\n');
        fs.symlinkSync(outside, path.join(dir, 'link'));
        gitIn(dir, 'update-index', '--add', '--cacheinfo', `160000,${gitIn(dir, 'rev-parse', 'HEAD')},sub`);
        gitIn(dir, 'add', 'link');
        gitIn(dir, 'commit', '-q', '-m', 'links');
        fs.mkdirSync(path.join(dir, 'sub'));
        return dir;
      },
    });
    const changes = await readChanges(app, runId);
    const files = changes.files;
    const before = repoSnapshot(repo, WATCHED);
    const outsideBefore = fs.readFileSync(path.join(repo, 'link', 'secret'), 'utf8');
    const entry = (rel: string) => ({ path: rel, sha256: 'c'.repeat(64), mode: '100644' });

    const fixtures: Array<{ name: string; body: Record<string, unknown>; status: number; code: string }> = [
      { name: 'absolute', body: finalizeBody(changes, { files: [...files, entry('/etc/passwd')] }), status: 422, code: 'PATH_INVALID' },
      { name: 'traversal', body: finalizeBody(changes, { files: [...files, entry('src/../../x')] }), status: 422, code: 'PATH_INVALID' },
      { name: '.git', body: finalizeBody(changes, { files: [...files, entry('.git/config')] }), status: 422, code: 'PATH_INVALID' },
      { name: '.GIT nested', body: finalizeBody(changes, { files: [...files, entry('src/.GIT/hooks')] }), status: 422, code: 'PATH_INVALID' },
      { name: 'binding', body: finalizeBody(changes, { files: [...files, entry('.agent-deck/use.json')] }), status: 422, code: 'PATH_INVALID' },
      { name: 'submodule', body: finalizeBody(changes, { files: [...files, entry('sub')] }), status: 422, code: 'PATH_INVALID' },
      { name: 'inside submodule', body: finalizeBody(changes, { files: [...files, entry('sub/file')] }), status: 422, code: 'PATH_INVALID' },
      { name: 'symlink escape', body: finalizeBody(changes, { files: [...files, entry('link/secret')] }), status: 422, code: 'PATH_INVALID' },
      { name: 'symlink itself', body: finalizeBody(changes, { files: [...files, entry('link')] }), status: 422, code: 'PATH_INVALID' },
      { name: 'duplicate', body: finalizeBody(changes, { files: [...files, files[0]] }), status: 422, code: 'PATH_INVALID' },
      { name: 'extra unchanged path', body: finalizeBody(changes, { files: [...files, entry('README.md')] }), status: 409, code: 'PATH_UNEXPECTED' },
      { name: 'pre-existing dirty path', body: finalizeBody(changes, { files: [...files, entry('keep.txt')] }), status: 409, code: 'PATH_UNEXPECTED' },
      { name: 'missing run path', body: finalizeBody(changes, { files: files.slice(1) }), status: 409, code: 'PATH_UNEXPECTED' },
      {
        name: 'digest mismatch',
        body: finalizeBody(changes, { files: files.map((f, i) => (i === 2 ? { ...f, sha256: 'd'.repeat(64) } : f)) }),
        status: 409,
        code: 'DIGEST_MISMATCH',
      },
      {
        name: 'mode mismatch',
        body: finalizeBody(changes, { files: files.map((f, i) => (i === 0 ? { ...f, mode: '100644' } : f)) }),
        status: 409,
        code: 'DIGEST_MISMATCH',
      },
      { name: 'stale baseline', body: finalizeBody(changes, { baselineDigest: 'e'.repeat(64) }), status: 409, code: 'BASELINE_MISMATCH' },
      { name: 'wrong base', body: finalizeBody(changes, { expectedBaseCommit: 'f'.repeat(40) }), status: 409, code: 'BASE_MISMATCH' },
      { name: 'empty manifest', body: finalizeBody(changes, { files: [] }), status: 400, code: 'INVALID_REQUEST' },
      { name: 'cwd override', body: finalizeBody(changes, { cwd: '/tmp' }), status: 400, code: 'INVALID_REQUEST' },
      { name: 'half-deleted entry', body: finalizeBody(changes, { files: [{ path: 'x', sha256: null, mode: '100644' }] }), status: 400, code: 'INVALID_REQUEST' },
    ];
    for (const fixture of fixtures) {
      const response = await postFinalize(app, app.runGrant.token, runId, fixture.body);
      expect(response.statusCode, `${fixture.name}: ${response.body}`).toBe(fixture.status);
      expect(response.json(), fixture.name).toMatchObject({ success: false, error_code: fixture.code });
      expect(response.body).not.toContain(repo);
      expect(response.body).not.toContain(MESSAGE_SENTINEL);
      expect(repoSnapshot(repo, WATCHED), fixture.name).toEqual(before);
    }
    expect(fs.readFileSync(path.join(repo, 'link', 'secret'), 'utf8')).toBe(outsideBefore);

    // A pre-existing dirty path that changes after the review fails the next attempt.
    writeFile(repo, 'notes.txt', 'changed after review\n');
    const changedBaseline = await postFinalize(app, app.runGrant.token, runId, finalizeBody(changes));
    expect(changedBaseline.statusCode).toBe(409);
    expect(changedBaseline.json()).toMatchObject({ error_code: 'BASELINE_MISMATCH' });
    expect(gitIn(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(gitIn(repo, 'rev-parse', 'HEAD')).toBe(before.head);

    // A dirty index at finalize time fails closed too, leaving the user's staging as it was.
    writeFile(repo, 'notes.txt', `${DIRTY_SENTINEL} untracked notes\n`);
    gitIn(repo, 'add', 'README.md', 'notes.txt');
    const dirtyIndex = await postFinalize(app, app.runGrant.token, runId, finalizeBody(changes));
    expect(dirtyIndex.statusCode).toBe(409);
    expect(dirtyIndex.json()).toMatchObject({ error_code: 'INDEX_DIRTY' });
    expect(gitIn(repo, 'diff', '--cached', '--name-only')).toBe('notes.txt');
  });
});

function counting(deps: Parameters<typeof createGitFinalizer>[0] = {}) {
  const calls: string[][] = [];
  const finalizer = createGitFinalizer({
    ...deps,
    runGit: (args, options) => {
      calls.push(args);
      return defaultGitRunner(args, options);
    },
  });
  return { finalizer, calls };
}

function expectExactCommit(repo: string, data: Record<string, unknown>, base: string, files: Array<{ path: string; sha256: string | null; mode: string | null }>) {
  expect(gitIn(repo, 'rev-parse', 'HEAD')).toBe(data.commit);
  expect(gitIn(repo, 'rev-parse', 'HEAD^')).toBe(base);
  expect(gitIn(repo, 'rev-parse', 'HEAD^{tree}')).toBe(data.tree);
  expect(gitIn(repo, 'rev-list', '--count', `${base}..HEAD`)).toBe('1');
  expect(gitIn(repo, 'log', '-1', '--format=%B')).toBe(`agent change\n\n${MESSAGE_SENTINEL}`);
  const changed = gitIn(repo, 'diff-tree', '--no-commit-id', '-r', '--no-renames', '--name-status', 'HEAD')
    .split('\n')
    .map((line) => line.split('\t'));
  const inBase = (rel: string) => gitIn(repo, 'ls-tree', base, '--', rel) !== '';
  expect(changed).toEqual(files.map((file) => [file.sha256 === null ? 'D' : inBase(file.path) ? 'M' : 'A', file.path]));
  for (const file of files) {
    if (file.sha256 === null) {
      continue;
    }
    const [mode, , oid] = gitIn(repo, 'ls-tree', 'HEAD', '--', file.path).split(/\s+/);
    expect(mode).toBe(file.mode);
    const blob = spawnSync('git', ['cat-file', 'blob', oid], { cwd: repo });
    expect(createHash('sha256').update(blob.stdout).digest('hex')).toBe(file.sha256);
  }
  // Nothing unrelated or binding entered the commit, and the real index matches the new HEAD.
  expect(gitIn(repo, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toMatch(/keep\.txt\n?.*notes|\.agent-deck|notes\.txt/);
  expect(gitIn(repo, 'show', 'HEAD:keep.txt')).toBe('keep v1');
  expect(gitIn(repo, 'diff', '--cached', '--name-only')).toBe('');
}

describe('POST /api/agent-runs/:runId/finalize commits exactly the manifest (NOT-486)', () => {
  for (const layout of ['full clone', 'linked worktree'] as const) {
    it(`creates one commit on expectedBaseCommit in a ${layout}`, async () => {
      const { app, repo, runId } = await preparedRun({
        repo: (deck) => {
          const origin = gitRepo(deck);
          if (layout === 'full clone') {
            const clone = path.join(fs.realpathSync(makeDir('ad-fin-clone-')), 'clone');
            gitIn(path.dirname(clone), 'clone', '-q', origin, clone);
            gitIn(clone, 'config', 'user.name', 'Fixture');
            gitIn(clone, 'config', 'user.email', 'fixture@example.test');
            gitIn(clone, 'config', 'commit.gpgsign', 'false');
            bindFolder(clone, deck);
            return clone;
          }
          const worktree = path.join(fs.realpathSync(makeDir('ad-fin-wt-')), 'wt');
          gitIn(origin, 'worktree', 'add', '-q', '-b', 'feature', worktree);
          bindFolder(worktree, deck);
          return worktree;
        },
      });
      const base = gitIn(repo, 'rev-parse', 'HEAD');
      const unrelated = { keep: sha256File(path.join(repo, 'keep.txt')), notes: sha256File(path.join(repo, 'notes.txt')) };
      const changes = await readChanges(app, runId);
      const response = await postFinalize(app, app.runGrant.token, runId, finalizeBody(changes));
      expect(response.statusCode, response.body).toBe(200);
      const data = FinalizeAgentRunResponseSchema.parse(response.json().data);
      expect(data).toMatchObject({
        runId,
        finalizationState: 'finalized',
        parent: base,
        manifestDigest: changes.manifestDigest,
        fileCount: 4,
        reviewId: 'review-1',
      });
      expect(response.body).not.toContain(repo);
      expect(response.body).not.toContain(FILE_SENTINEL);
      expect(response.body).not.toContain(MESSAGE_SENTINEL);
      expectExactCommit(repo, data, base, changes.files);
      if (layout === 'linked worktree') {
        expect(gitIn(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature');
        expect(gitIn(repo, 'rev-parse', 'main')).toBe(base);
      }
      // Unrelated pre-existing work is byte-identical and still uncommitted.
      expect(sha256File(path.join(repo, 'keep.txt'))).toBe(unrelated.keep);
      expect(sha256File(path.join(repo, 'notes.txt'))).toBe(unrelated.notes);
      const porcelain = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
      expect(porcelain.stdout.split('\n').filter(Boolean).sort()).toEqual(
        [' M keep.txt', '?? .agent-deck/use.json', '?? notes.txt'].sort(),
      );
      const status = AgentRunStatusSchema.parse((await getStatus(app, app.runGrant.token, runId)).json().data);
      expect(status.finalization).toMatchObject({ state: 'finalized', commit: data.commit });
    });
  }
});

describe('finalization idempotency, locks, and ref races (NOT-486)', () => {
  it('replays the same key without Git, conflicts on a changed body or key, and survives restart', async () => {
    const { finalizer, calls } = counting();
    const { app, repo, runId } = await preparedRun({ finalizer });
    const changes = await readChanges(app, runId);
    const body = finalizeBody(changes);
    const key = freshKey();
    const first = await postFinalize(app, app.runGrant.token, runId, body, key);
    expect(first.statusCode, first.body).toBe(200);
    const commitsAfter = gitIn(repo, 'rev-list', '--all', '--count');
    const gitCalls = calls.length;

    const replay = await postFinalize(app, app.runGrant.token, runId, { ...body, files: [...body.files].reverse() }, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data).toEqual(first.json().data);
    expect(calls.length).toBe(gitCalls);

    const changedBody = await postFinalize(app, app.runGrant.token, runId, { ...body, reviewId: 'review-2' }, key);
    expect(changedBody.statusCode).toBe(409);
    expect(changedBody.json()).toMatchObject({ error_code: 'IDEMPOTENCY_CONFLICT' });
    const otherKey = await postFinalize(app, app.runGrant.token, runId, body);
    expect(otherKey.statusCode).toBe(409);
    expect(otherKey.json()).toMatchObject({ error_code: 'IDEMPOTENCY_CONFLICT' });

    const restarted = await buildApp({ restartOf: app, finalizer });
    const afterRestart = await postFinalize(restarted, app.runGrant.token, runId, body, key);
    expect(afterRestart.statusCode).toBe(200);
    expect(afterRestart.json().data).toEqual(first.json().data);
    expect(calls.length).toBe(gitCalls);
    expect(gitIn(repo, 'rev-list', '--all', '--count')).toBe(commitsAfter);
    expect(app.audit.list({ limit: 100 }).filter((row) => row.event === 'agent_run.finalized' && row.reasonCode === 'replayed')).toHaveLength(2);
  });

  it('concurrent requests produce one commit: same key shares it, another key conflicts', async () => {
    const gate = deferred();
    const { finalizer } = counting({ pause: async (stage) => (stage === 'staged' ? gate.promise : undefined) });
    const { app, repo, runId } = await preparedRun({ finalizer });
    const changes = await readChanges(app, runId);
    const base = gitIn(repo, 'rev-parse', 'HEAD');
    const key = freshKey();
    const a = postFinalize(app, app.runGrant.token, runId, finalizeBody(changes), key);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const b = postFinalize(app, app.runGrant.token, runId, finalizeBody(changes), key);
    const c = postFinalize(app, app.runGrant.token, runId, finalizeBody(changes));
    const conflict = await c;
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error_code: 'IDEMPOTENCY_CONFLICT' });
    gate.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.statusCode, ra.body).toBe(200);
    expect(rb.json().data).toEqual(ra.json().data);
    expect(gitIn(repo, 'rev-list', '--count', `${base}..HEAD`)).toBe('1');
  });

  it('fails closed on a held Git index lock without removing it, then succeeds once released', async () => {
    const { app, repo, runId } = await preparedRun();
    const changes = await readChanges(app, runId);
    const lock = path.join(gitIn(repo, 'rev-parse', '--absolute-git-dir'), 'index.lock');
    fs.writeFileSync(lock, '');
    const before = repoSnapshot(repo, WATCHED);
    const key = freshKey();
    const locked = await postFinalize(app, app.runGrant.token, runId, finalizeBody(changes), key);
    expect(locked.statusCode).toBe(409);
    expect(locked.json()).toMatchObject({ error_code: 'GIT_LOCK_CONFLICT' });
    expect(fs.existsSync(lock)).toBe(true);
    expect(repoSnapshot(repo, WATCHED)).toEqual(before);

    fs.rmSync(lock);
    const retried = await postFinalize(app, app.runGrant.token, runId, finalizeBody(changes), key);
    expect(retried.statusCode, retried.body).toBe(200);
  });

  it('a ref that moves before the compare-and-swap returns REF_RACE without a second commit', async () => {
    let repo = '';
    let raced = '';
    const { finalizer } = counting({
      pause: async (stage) => {
        if (stage === 'commit-object') {
          const tree = gitIn(repo, 'rev-parse', 'HEAD^{tree}');
          raced = gitIn(repo, 'commit-tree', tree, '-p', 'HEAD', '-m', 'someone else');
          gitIn(repo, 'update-ref', 'refs/heads/main', raced);
        }
      },
    });
    const prepared = await preparedRun({ finalizer });
    repo = prepared.repo;
    const { app, runId } = prepared;
    const changes = await readChanges(app, runId);
    const base = gitIn(repo, 'rev-parse', 'HEAD');
    const unrelated = sha256File(path.join(repo, 'keep.txt'));
    const response = await postFinalize(app, app.runGrant.token, runId, finalizeBody(changes));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error_code: 'REF_RACE' });
    expect(gitIn(repo, 'rev-parse', 'refs/heads/main')).toBe(raced);
    expect(gitIn(repo, 'rev-list', '--count', `${base}..main`)).toBe('1');
    expect(gitIn(repo, 'diff', '--cached', '--name-only', base)).toBe('');
    expect(fs.existsSync(path.join(repo, '.git', 'index.lock'))).toBe(false);
    expect(sha256File(path.join(repo, 'keep.txt'))).toBe(unrelated);
    expect(fs.readdirSync(path.join(repo, '.git')).filter((name) => name.startsWith('agent-deck-finalize-'))).toEqual([]);
    expect((await getStatus(app, app.runGrant.token, runId)).json().data.finalization).toMatchObject({ state: 'prepared' });
  });
});

describe('finalization cancellation (NOT-486)', () => {
  it('cancel before the commit removes only finalizer staging; cancel after the commit keeps history', async () => {
    let stopAt: string | null = 'staged';
    const reached = deferred();
    const resume = deferred();
    const { finalizer } = counting({
      pause: async (stage) => {
        if (stage === stopAt) {
          reached.release();
          await resume.promise;
        }
      },
    });
    const { app, repo, runId } = await preparedRun({ finalizer });
    const changes = await readChanges(app, runId);
    const before = repoSnapshot(repo, WATCHED);

    const pending = postFinalize(app, app.runGrant.token, runId, finalizeBody(changes));
    await reached.promise;
    expect(fs.existsSync(path.join(repo, '.git', 'index.lock'))).toBe(true);
    const cancel = await app.fastify.inject({
      method: 'POST',
      url: `/api/agent-runs/${runId}/cancel`,
      headers: bearer(app.runGrant.token),
    });
    expect(cancel.statusCode).toBe(200);
    resume.release();
    const canceled = await pending;
    expect(canceled.statusCode).toBe(409);
    expect(canceled.json()).toMatchObject({ error_code: 'FINALIZATION_CANCELED' });
    expect(repoSnapshot(repo, WATCHED)).toEqual(before);
    expect(fs.readdirSync(path.join(repo, '.git')).filter((name) => name.startsWith('agent-deck-finalize-'))).toEqual([]);

    // After the ref moved, cancellation is ignored: history is never rewritten.
    stopAt = 'ref-updated';
    const reachedAfter = deferred();
    const resumeAfter = deferred();
    const after = createGitFinalizer({
      pause: async (stage) => {
        if (stage === 'ref-updated') {
          reachedAfter.release();
          await resumeAfter.promise;
        }
      },
    });
    const restarted = await buildApp({ restartOf: app, finalizer: after });
    const committing = postFinalize(restarted, app.runGrant.token, runId, finalizeBody(changes));
    await reachedAfter.promise;
    await restarted.fastify.inject({ method: 'POST', url: `/api/agent-runs/${runId}/cancel`, headers: bearer(app.runGrant.token) });
    resumeAfter.release();
    const committed = await committing;
    expect(committed.statusCode, committed.body).toBe(200);
    expectExactCommit(repo, committed.json().data, before.head, changes.files);
  });
});

describe('finalization audit redaction (NOT-486)', () => {
  it('audits identifiers, counts, digests, and commit ids only', async () => {
    const { app, repo, runId } = await preparedRun();
    const changes = await readChanges(app, runId);
    await postFinalize(app, app.runGrant.token, runId, finalizeBody(changes, { expectedBaseCommit: 'f'.repeat(40) }));
    const ok = await postFinalize(app, app.runGrant.token, runId, finalizeBody(changes));
    expect(ok.statusCode).toBe(200);
    const rows = app.audit.list({ limit: 100 });
    const finalized = rows.find((row) => row.event === 'agent_run.finalized' && row.outcome === 'succeeded');
    expect(finalized).toMatchObject({
      actor: app.runGrant.grant.id,
      targetId: runId,
      reasonCode: null,
      detail: {
        manifestDigest: changes.manifestDigest,
        baselineDigest: changes.baselineDigest,
        fileCount: 4,
        commit: ok.json().data.commit,
        tree: ok.json().data.tree,
      },
    });
    expect(finalized?.detail?.repositoryId).toMatch(/^repo_[0-9a-f]{24}$/);
    expect(rows.find((row) => row.event === 'agent_run.finalized' && row.reasonCode === 'base_mismatch')).toMatchObject({
      outcome: 'denied',
    });
    expect(rows.some((row) => row.event === 'agent_run.changes_read' && row.outcome === 'succeeded')).toBe(true);
    const dump = JSON.stringify(rows);
    for (const secret of [
      PROMPT_SENTINEL,
      RESULT_SENTINEL,
      FILE_SENTINEL,
      DIRTY_SENTINEL,
      MESSAGE_SENTINEL,
      app.runGrant.token,
      parseGrantToken(app.runGrant.token)!.secret,
      repo,
      'tracked.txt',
      'keep.txt',
    ]) {
      expect(dump).not.toContain(secret);
    }
  });
});

describe('finalization restart recovery (NOT-486)', () => {
  it('a crash after the ref moved recovers as finalized; one before it releases and removes only its own staging', async () => {
    const { app, repo, runId } = await preparedRun();
    const changes = await readChanges(app, runId);
    const base = changes.baseCommit;
    const store = new FinalizationStore(app.db.getSqliteDatabase());
    const gitDir = gitIn(repo, 'rev-parse', '--absolute-git-dir');

    // Crash before the compare-and-swap: a claim, our private index, and our index.lock remain.
    store.claim({ runId, grantId: app.runGrant.grant.id, idempotencyKey: 'crashed', requestHash: 'h' });
    const lock = path.join(gitDir, 'index.lock');
    fs.writeFileSync(lock, '');
    fs.writeFileSync(path.join(gitDir, `agent-deck-finalize-${runId}-deadbeef.index`), 'x');
    const foreign = path.join(gitDir, 'agent-deck-finalize-run-other-0000.index');
    fs.writeFileSync(foreign, 'not ours');
    store.markLocked(runId, fs.lstatSync(lock).ino);
    const restarted = await buildApp({ restartOf: app });
    expect(store.get(runId)).toBeNull();
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readdirSync(gitDir).filter((name) => name.includes(runId))).toEqual([]);
    expect(fs.existsSync(foreign)).toBe(true);
    expect(gitIn(repo, 'rev-parse', 'HEAD')).toBe(base);
    expect((await getStatus(restarted, app.runGrant.token, runId)).json().data.finalization).toMatchObject({ state: 'prepared' });

    // Crash after the ref moved to the recorded commit: the outcome is durable.
    const tree = gitIn(repo, 'rev-parse', 'HEAD^{tree}');
    const commit = gitIn(repo, 'commit-tree', tree, '-p', base, '-m', 'recorded');
    store.claim({ runId, grantId: app.runGrant.grant.id, idempotencyKey: 'crashed-2', requestHash: 'h2' });
    const result = {
      runId,
      finalizationState: 'finalized' as const,
      commit,
      tree,
      parent: base,
      manifestDigest: changes.manifestDigest,
      fileCount: changes.files.length,
      reviewId: 'review-1',
    };
    store.markPending(runId, result);
    gitIn(repo, 'update-ref', 'refs/heads/main', commit, base);
    const again = await buildApp({ restartOf: app });
    expect(store.get(runId)).toMatchObject({ state: 'finalized', result });
    expect((await getStatus(again, app.runGrant.token, runId)).json().data.finalization).toMatchObject({
      state: 'finalized',
      commit,
    });
  });
});
