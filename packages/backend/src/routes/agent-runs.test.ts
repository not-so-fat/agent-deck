/**
 * NOT-480: agent run HTTP API through injected adapters.
 *
 * Evidence for: run-enabled grant authorization (every principal/deck case),
 * pre-launch validation with zero adapter starts on denial, Idempotency-Key
 * semantics (sequential and concurrent), truthful lifecycle states with
 * cursor-ordered events, redaction, and payload-free audit records.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_RUN_PROMPT_MAX_CHARS,
  AGENT_RUN_REQUEST_BODY_LIMIT_BYTES,
  AgentRunEventsResponseSchema,
  AgentRunStatusSchema,
  CreateAgentRunResponseSchema,
} from '@agent-deck/shared';

import {
  createCodexAdapter,
  readRunMeta,
  runPaths,
  writeRunMeta,
  type AdapterStartArgs,
  type ClientAdapter,
  type NormalizedEvent,
  type RunClient,
} from '../agent-run';
import { createBackendAgentRunService } from '../agent-run-api/host';
import { AuditStore } from '../audit/store';
import { ClientGrantStore, parseGrantToken } from '../auth/client-grants';
import { registerHostedModeGuard } from '../auth/hosted-mode';
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
  createAdapter?: (client: RunClient) => ClientAdapter;
  hosted?: boolean;
};

async function buildApp(options: BuildOptions = {}) {
  const home = makeDir('ad-runs-home-');
  const db = new DatabaseManager(':memory:');
  const deckA = await db.createDeck({ name: 'runs-deck-a' });
  const deckB = await db.createDeck({ name: 'runs-deck-b' });
  const sessions = new TrustedSessionStore(db.getSqliteDatabase());
  const grants = new ClientGrantStore(db.getSqliteDatabase());
  const audit = new AuditStore(db.getSqliteDatabase());
  const adapter = fixtureAdapter('codex', options.script ?? (() => ({ steps: successSteps() })));
  const createAdapter = vi.fn(options.createAdapter ?? ((): ClientAdapter => adapter));
  const service = createBackendAgentRunService(db, home, {
    createAdapter,
    claudeProbe: async () => (options.claudeOk === false ? { ok: false, reason: 'not-signed-in' } : { ok: true }),
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

  const runGrant = grants.issueGrant({ label: 'coordinator', defaultDeck: deckA.id, runsEnabled: true });
  const cwdA = assignedCwd(deckA);
  return { fastify, db, home, sessions, grants, audit, adapter, createAdapter, deckA, deckB, runGrant, cwdA };
}

type App = Awaited<ReturnType<typeof buildApp>>;

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
    expect(resolveRoutePolicy('GET', '/api/agent-runs/run-20261013T000000-abcdef')).toBe('requireRunGrant');
    expect(resolveRoutePolicy('GET', '/api/agent-runs/run-20261013T000000-abcdef/events')).toBe('requireRunGrant');
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
      { name: 'dashboard', headers: dashboardAuthHeaders(app.sessions), status: 401, code: 'GRANT_REQUIRED' },
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

  it('fails closed for an unavailable client and a profile the client cannot enforce on resume', async () => {
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

    const resumedEdit = await post(
      app,
      app.runGrant.token,
      startBody(app, { tools: 'edit', resumeSessionId: 'thread-opaque-1' }),
    );
    expect(resumedEdit.statusCode).toBe(422);
    expect(resumedEdit.json()).toMatchObject({ error_code: 'PROFILE_UNSUPPORTED' });
    expect(resumedEdit.body).not.toContain('--tools');

    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(app.home, 'runs'))).toBe(false);
  });

  it('starts and resumes through the shared service and returns 202 with an opaque run id', async () => {
    const app = await buildApp();
    const start = await post(app, app.runGrant.token, { ...startBody(app), tools: undefined });
    expect(start.statusCode).toBe(202);
    const created = CreateAgentRunResponseSchema.parse(start.json().data);
    expect(created.runId).toMatch(/^run-/);
    expect(app.adapter.starts[0]).toEqual({ cwd: app.cwdA, prompt: PROMPT_SENTINEL, tools: 'readonly' });

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
    expect(statusKeys).toEqual(['client', 'deckId', 'lastEventAt', 'runId', 'sessionId', 'startedAt', 'state', 'tools']);
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
