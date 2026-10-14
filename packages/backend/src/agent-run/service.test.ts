import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAgentRunService,
  createCodexAdapter,
  createRunAdapter,
  RUN_SUPPORTED_CLIENTS,
  writeRunMeta,
  type AdapterStartArgs,
  type AgentRunRequest,
  type AgentRunServiceDeps,
  type ClientAdapter,
  type NormalizedEvent,
  type RunClient,
  type RunMeta,
} from './index';

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DECK = { id: 'deck-api', name: 'api' };
const DEAD_PID = 2147483647;

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

type FixtureScript = {
  events?: NormalizedEvent[];
  /** Thrown after the scripted events, like a crashed client process. */
  fail?: Error;
  /** Holds the stream open after the first event until resolved. */
  hold?: Promise<void>;
  preflightRemedy?: string;
  planRemedy?: string;
};

type FixtureAdapter = ClientAdapter & { starts: AdapterStartArgs[] };

/** In-memory adapter: no process, no model. */
function fixtureAdapter(client: RunClient, script: FixtureScript): FixtureAdapter {
  const starts: AdapterStartArgs[] = [];
  return {
    id: client,
    starts,
    async preflight() {
      return script.preflightRemedy ? { ok: false, remedy: script.preflightRemedy } : { ok: true };
    },
    planStart() {
      return script.planRemedy
        ? { ok: false, remedy: script.planRemedy }
        : { ok: true, trustOverride: false };
    },
    async *start(args) {
      starts.push(args);
      const events = script.events ?? [];
      for (let i = 0; i < events.length; i += 1) {
        yield events[i];
        if (i === 0 && script.hold) {
          await script.hold;
        }
      }
      if (script.fail) {
        throw script.fail;
      }
    },
  };
}

function successEvents(sessionId = 'ses_1'): NormalizedEvent[] {
  return [
    { kind: 'text', text: '◆ api · 1 MCP · 0 keys · 2 playbooks', sessionId },
    { kind: 'tool', name: 'Read', sessionId },
    { kind: 'notice', message: 'heads up', sessionId },
    { kind: 'result', subtype: 'success', result: 'done', sessionId },
  ];
}

function makeService(
  homeDir: string,
  adapter: FixtureAdapter,
  overrides: Partial<AgentRunServiceDeps> = {},
) {
  const createAdapter = vi.fn(() => adapter);
  const service = createAgentRunService({
    homeDir,
    resolveDeck: async (ref) => (ref === DECK.name || ref === DECK.id ? { ...DECK } : null),
    resolveDeckBinding: async () => ({ deckId: DECK.id, deckName: DECK.name }),
    claudeProbe: async () => ({ ok: true }),
    createAdapter,
    ...overrides,
  });
  return { service, createAdapter };
}

function request(cwd: string, extra: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return { deckRef: 'api', client: 'codex', cwd, prompt: 'brief', tools: 'readonly', ...extra };
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('agent run service through injected adapters (NOT-479)', () => {
  it('starts a run and writes the canonical JSONL log and meta.json', async () => {
    const home = makeDir('ad-svc-home-');
    const cwd = makeDir('ad-svc-cwd-');
    const adapter = fixtureAdapter('codex', { events: successEvents() });
    const { service, createAdapter } = makeService(home, adapter);

    const outcome = await service.start(request(cwd));

    expect(createAdapter).toHaveBeenCalledWith('codex');
    expect(adapter.starts).toEqual([{ cwd, prompt: 'brief', tools: 'readonly' }]);
    if (outcome.kind !== 'finished') throw new Error(outcome.message);
    expect(outcome).toMatchObject({
      state: 'ended',
      sessionId: 'ses_1',
      receiptMismatch: null,
      failure: null,
      logPath: path.join(home, 'runs', outcome.runId, 'run.jsonl'),
      metaPath: path.join(home, 'runs', outcome.runId, 'meta.json'),
    });

    const lines = readJsonl(outcome.logPath);
    expect(lines.map((line) => Object.keys(line))).toEqual([
      ['t', 'ts', 'text'],
      ['t', 'ts', 'name'],
      ['t', 'ts', 'message', 'sessionId'],
      ['t', 'ts', 'sessionId', 'subtype', 'result'],
      ['t', 'ts', 'sessionId'],
    ]);
    for (const line of lines) {
      expect(line.ts).toMatch(ISO_TS);
    }
    expect(lines.map(({ ts: _ts, ...rest }) => rest)).toEqual([
      { t: 'text', text: '◆ api · 1 MCP · 0 keys · 2 playbooks' },
      { t: 'tool', name: 'Read' },
      { t: 'notice', message: 'heads up', sessionId: 'ses_1' },
      { t: 'result', sessionId: 'ses_1', subtype: 'success', result: 'done' },
      { t: 'end', sessionId: 'ses_1' },
    ]);

    const meta = JSON.parse(fs.readFileSync(outcome.metaPath, 'utf8')) as RunMeta;
    expect(Object.keys(meta)).toEqual([
      'runId', 'deck', 'client', 'tools', 'cwd', 'pid', 'startedAt', 'state', 'sessionId',
    ]);
    expect(meta).toMatchObject({
      runId: outcome.runId,
      deck: DECK.id,
      client: 'codex',
      tools: 'readonly',
      cwd,
      pid: process.pid,
      state: 'ended',
      sessionId: 'ses_1',
    });
  });

  it('observes a running run, then its terminal status and ordered events', async () => {
    const home = makeDir('ad-svc-home-');
    const cwd = makeDir('ad-svc-cwd-');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = fixtureAdapter('claude', { events: successEvents('ses_obs'), hold });
    const { service } = makeService(home, adapter);

    const pending = service.start(request(cwd, { client: 'claude' }));
    await vi.waitFor(() => {
      expect(service.list(10)).toHaveLength(1);
      expect(service.events(service.list(10)[0].runId)?.events).toHaveLength(1);
    });
    const runId = service.list(10)[0].runId;
    const running = service.status(runId);
    expect(running.found && running.info).toMatchObject({
      runId,
      deck: DECK.id,
      client: 'claude',
      state: 'running',
      sessionId: 'ses_obs',
    });

    release();
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'finished', runId, state: 'ended' });
    const ended = service.status(runId);
    expect(ended.found && ended.info.state).toBe('ended');
    expect(service.events(runId)?.events.map((entry) => entry.event.t)).toEqual([
      'text', 'tool', 'notice', 'result', 'end',
    ]);
    expect(service.events('run-unknown')).toBeNull();
    expect(service.status('run-unknown')).toEqual({ found: false });
  });

  it('resumes a session as a new run that starts from the given session id', async () => {
    const home = makeDir('ad-svc-home-');
    const cwd = makeDir('ad-svc-cwd-');
    const adapter = fixtureAdapter('muse', {
      events: [{ kind: 'result', subtype: 'success', result: 'again' }],
    });
    const { service } = makeService(home, adapter);

    const outcome = await service.start(
      request(cwd, { client: 'muse', tools: 'edit', resumeId: 'ses_prev' }),
    );

    expect(adapter.starts).toEqual([
      { cwd, prompt: 'brief', tools: 'edit', resumeId: 'ses_prev' },
    ]);
    if (outcome.kind !== 'finished') throw new Error(outcome.message);
    expect(outcome).toMatchObject({ state: 'ended', sessionId: 'ses_prev' });
    const lines = readJsonl(outcome.logPath);
    expect(lines.map((line) => [line.t, line.sessionId])).toEqual([
      ['result', 'ses_prev'],
      ['end', 'ses_prev'],
    ]);
    const meta = JSON.parse(fs.readFileSync(outcome.metaPath, 'utf8')) as RunMeta;
    expect(meta).toMatchObject({ state: 'ended', tools: 'edit', sessionId: 'ses_prev' });
  });

  it('terminates in error when the client fails, ends without a result, or names another deck', async () => {
    const home = makeDir('ad-svc-home-');
    const cwd = makeDir('ad-svc-cwd-');

    const crashed = await makeService(
      home,
      fixtureAdapter('cursor', {
        events: [{ kind: 'text', text: 'partial', sessionId: 'ses_c' }],
        fail: new Error('cursor-agent exited with code 1'),
      }),
    ).service.start(request(cwd, { client: 'cursor' }));
    if (crashed.kind !== 'finished') throw new Error(crashed.message);
    expect(crashed).toMatchObject({
      state: 'error',
      sessionId: 'ses_c',
      failure: 'cursor-agent exited with code 1',
    });
    const crashLines = readJsonl(crashed.logPath);
    expect(crashLines.at(-1)).toMatchObject({
      t: 'error',
      message: 'cursor-agent exited with code 1',
      sessionId: 'ses_c',
    });
    expect(crashLines.some((line) => line.t === 'end')).toBe(false);

    const noResult = await makeService(
      home,
      fixtureAdapter('codex', { events: [{ kind: 'text', text: 'hi' }] }),
    ).service.start(request(cwd));
    expect(noResult).toMatchObject({ kind: 'finished', state: 'error', failure: null });

    const misbound = await makeService(
      home,
      fixtureAdapter('codex', {
        events: [
          { kind: 'text', text: '◆ other' },
          { kind: 'text', text: ' · 1 MCP' },
          { kind: 'result', subtype: 'success', result: 'ok' },
        ],
      }),
    ).service.start(request(cwd));
    expect(misbound).toMatchObject({ kind: 'finished', state: 'error', receiptMismatch: 'other' });
  });

  it('reports a running record whose process is gone as died', () => {
    const home = makeDir('ad-svc-home-');
    const { service } = makeService(home, fixtureAdapter('codex', {}));
    const { runId, metaPath, logPath } = service.allocate();
    expect(logPath).toBe(path.join(home, 'runs', runId, 'run.jsonl'));
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    writeRunMeta(metaPath, {
      runId,
      deck: DECK.id,
      client: 'codex',
      tools: 'readonly',
      cwd: home,
      pid: DEAD_PID,
      startedAt: new Date().toISOString(),
      state: 'running',
    });
    const status = service.status(runId);
    expect(status.found && status.info.state).toBe('died');
  });
});

describe('agent run service fail-closed gates (NOT-479)', () => {
  it('rejects an unbound or mis-bound folder before any adapter or record', async () => {
    const home = makeDir('ad-svc-home-');
    const cwd = makeDir('ad-svc-cwd-');
    const adapter = fixtureAdapter('codex', { events: successEvents() });

    const unbound = makeService(home, adapter, { resolveDeckBinding: async () => ({}) });
    expect(await unbound.service.start(request(cwd))).toEqual({
      kind: 'rejected',
      code: 'deck_unassigned',
      message: `No deck assigned in ${cwd}: run \`agent-deck use api\` there first, then retry. Refusing to start an unbound session.`,
    });

    const misbound = makeService(home, adapter, {
      resolveDeckBinding: async () => ({ deckId: 'deck-other', deckName: 'other' }),
    });
    const outcome = await misbound.service.start(request(cwd));
    expect(outcome.kind === 'rejected' && outcome.code).toBe('deck_mismatch');
    expect(outcome.kind === 'rejected' && outcome.message).toContain(
      `Folder ${cwd} is bound to "other" (deck-other), not "api".`,
    );

    expect(unbound.createAdapter).not.toHaveBeenCalled();
    expect(misbound.createAdapter).not.toHaveBeenCalled();
    expect(adapter.starts).toEqual([]);
    expect(fs.existsSync(path.join(home, 'runs'))).toBe(false);
  });

  it('rejects an unknown deck, empty brief, missing cwd, and a signed-out Claude client', async () => {
    const home = makeDir('ad-svc-home-');
    const cwd = makeDir('ad-svc-cwd-');
    const adapter = fixtureAdapter('claude', {});
    const { service } = makeService(home, adapter, {
      claudeProbe: async () => ({ ok: false, reason: 'not-signed-in' }),
    });

    expect(await service.validate(request(cwd, { deckRef: 'nope' }))).toEqual({
      ok: false,
      code: 'deck_not_found',
      error: 'Deck not found: nope',
    });
    expect(await service.validate(request(cwd, { prompt: '  ' }))).toMatchObject({
      ok: false,
      code: 'prompt_empty',
    });
    expect(await service.validate(request(path.join(cwd, 'missing')))).toMatchObject({
      ok: false,
      code: 'cwd_not_found',
    });
    expect(await service.validate(request(cwd, { client: 'claude' }))).toEqual({
      ok: false,
      code: 'client_unavailable',
      error:
        'Claude Code is not signed in. Run `claude auth login` to sign in with your own account, then retry.',
    });
    // The Claude probe guards claude runs only.
    expect(await service.validate(request(cwd))).toEqual({ ok: true, deck: DECK });
    expect(adapter.starts).toEqual([]);
  });

  it('returns adapter preflight and start-plan remedies without writing a record', async () => {
    const home = makeDir('ad-svc-home-');
    const cwd = makeDir('ad-svc-cwd-');

    const preflight = makeService(
      home,
      fixtureAdapter('cursor', { preflightRemedy: 'cursor-agent is not signed in' }),
    );
    expect(await preflight.service.start(request(cwd, { client: 'cursor' }))).toEqual({
      kind: 'rejected',
      code: 'client_unavailable',
      message: 'cursor-agent is not signed in',
    });

    // The shipped codex adapter behind injected process seams: resumed edit
    // runs fail closed in planStart, before anything is spawned.
    const spawn = vi.fn();
    const codex = createCodexAdapter({
      probe: () => ({ code: 0, stdout: 'Logged in using ChatGPT', stderr: '' }),
      spawn,
      isGitRepo: () => true,
    });
    const { service } = makeService(home, Object.assign(codex, { starts: [] }));
    const outcome = await service.start(request(cwd, { tools: 'edit', resumeId: 'thread-1' }));
    expect(outcome.kind === 'rejected' && outcome.code).toBe('profile_unsupported');
    expect(outcome.kind === 'rejected' && outcome.message).toContain(
      'Cannot resume codex thread thread-1 with --tools edit',
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, 'runs'))).toBe(false);
  });

  it('launch returns once the record is written and settles completion at the terminal state', async () => {
    const home = makeDir('ad-svc-home-');
    const cwd = makeDir('ad-svc-cwd-');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = fixtureAdapter('codex', { events: successEvents(), hold });
    const { service } = makeService(home, adapter);

    const launched = await service.launch(request(cwd));
    if (launched.kind !== 'launched') throw new Error(launched.message);
    const running = service.status(launched.runId);
    expect(running.found && running.info.state).toBe('running');

    release();
    const finished = await launched.completion;
    expect(finished).toMatchObject({ kind: 'finished', runId: launched.runId, state: 'ended' });

    const rejected = await service.launch(request(cwd, { deckRef: 'nope' }));
    expect(rejected).toMatchObject({ kind: 'rejected', code: 'deck_not_found' });
    expect(adapter.starts).toHaveLength(1);
  });

  it('builds the shipped adapter for every supported client by default', () => {
    for (const client of RUN_SUPPORTED_CLIENTS) {
      expect(createRunAdapter(client).id).toBe(client);
    }
  });
});

describe('agent-run module boundary (NOT-479)', () => {
  it('imports only node built-ins and its own modules', () => {
    const dir = __dirname;
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const match of source.matchAll(/from '([^']+)'/g)) {
        expect(match[1], `${file} imports ${match[1]}`).toMatch(/^(node:|\.\/)/);
      }
    }
  });
});
