import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendRunLogLine,
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
      'runId', 'deck', 'client', 'tools', 'cwd', 'canonicalCwd', 'pid', 'startedAt', 'state', 'sessionId',
    ]);
    expect(meta).toMatchObject({
      runId: outcome.runId,
      deck: DECK.id,
      client: 'codex',
      tools: 'readonly',
      cwd,
      canonicalCwd: fs.realpathSync(cwd),
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
      message: `No deck assigned in ${cwd}: run \`agent-deck use api\` there first, then retry. Refusing to start an unbound session.`,
    });

    const misbound = makeService(home, adapter, {
      resolveDeckBinding: async () => ({ deckId: 'deck-other', deckName: 'other' }),
    });
    const outcome = await misbound.service.start(request(cwd));
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
      error: 'Deck not found: nope',
    });
    expect(await service.validate(request(cwd, { prompt: '  ' }))).toMatchObject({ ok: false });
    expect(await service.validate(request(path.join(cwd, 'missing')))).toMatchObject({ ok: false });
    expect(await service.validate(request(cwd, { client: 'claude' }))).toEqual({
      ok: false,
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
      message: 'cursor-agent is not signed in',
    });

    // The shipped codex adapter behind injected process seams: a codex
    // resume no Agent Deck run started fails closed before anything spawns.
    const spawn = vi.fn();
    const codex = createCodexAdapter({
      probe: () => ({ code: 0, stdout: 'Logged in using ChatGPT', stderr: '' }),
      spawn,
      isGitRepo: () => true,
    });
    const { service } = makeService(home, Object.assign(codex, { starts: [] }));
    const outcome = await service.start(request(cwd, { tools: 'edit', resumeId: 'thread-1' }));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.message).toContain(
      'Cannot resume codex session thread-1: no Agent Deck run on this host started it',
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, 'runs'))).toBe(false);
  });

  it('builds the shipped adapter for every supported client by default', () => {
    for (const client of RUN_SUPPORTED_CLIENTS) {
      expect(createRunAdapter(client).id).toBe(client);
    }
  });
});

const THREAD = '019a0000-0000-7000-8000-00000000c0de';
const BYPASS = '--dangerously-bypass-approvals-and-sandbox';

type CodexCall = { argv: string[]; cwd: string };

/** The shipped codex adapter over a fake `codex` process that reports `thread`. */
function codexService(
  homeDir: string,
  overrides: Partial<AgentRunServiceDeps> = {},
  thread = THREAD,
): { service: ReturnType<typeof createAgentRunService>; calls: CodexCall[] } {
  const calls: CodexCall[] = [];
  const lines = [
    JSON.stringify({ type: 'thread.started', thread_id: thread }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: '◆ api · 1 MCP · 0 keys · 2 playbooks' },
    }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
  ];
  const service = createAgentRunService({
    homeDir,
    resolveDeck: async (ref) => (ref === DECK.name || ref === DECK.id ? { ...DECK } : null),
    resolveDeckBinding: async () => ({ deckId: DECK.id, deckName: DECK.name }),
    adapters: {
      codex: {
        probe: () => ({ code: 0, stdout: '', stderr: 'Logged in using ChatGPT' }),
        isGitRepo: () => true,
        spawn: (_bin, argv, opts) => {
          calls.push({ argv, cwd: opts.cwd });
          return {
            stdout: (async function* (): AsyncGenerator<string> {
              yield* lines;
            })(),
            wait: async () => ({ code: 0, stderrTail: '' }),
          };
        },
      },
    },
    ...overrides,
  });
  return { service, calls };
}

function runDirs(home: string): string[] {
  const root = path.join(home, 'runs');
  return fs.existsSync(root) ? fs.readdirSync(root).sort() : [];
}

function readMeta(metaPath: string): RunMeta {
  return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as RunMeta;
}

async function startOrigin(
  service: ReturnType<typeof createAgentRunService>,
  cwd: string,
  tools: 'readonly' | 'edit',
) {
  const origin = await service.start(request(cwd, { tools }));
  if (origin.kind !== 'finished') throw new Error(origin.message);
  expect(origin).toMatchObject({ state: 'ended', sessionId: THREAD });
  return origin;
}

describe('codex resume provenance (NOT-484)', () => {
  it.each(['edit', 'readonly'] as const)(
    'resumes a trusted %s session with the same profile under the unchanged session id',
    async (tools) => {
      const home = makeDir('ad-svc-home-');
      const cwd = makeDir('ad-svc-cwd-');
      const { service, calls } = codexService(home);
      const origin = await startOrigin(service, cwd, tools);

      const resumed = await service.start(request(cwd, { tools, resumeId: THREAD, prompt: 'again' }));

      if (resumed.kind !== 'finished') throw new Error(resumed.message);
      expect(resumed).toMatchObject({ state: 'ended', sessionId: THREAD });
      expect(resumed.runId).not.toBe(origin.runId);
      expect(calls.map((call) => call.argv)).toEqual([
        ['exec', '--json', '-s', tools === 'edit' ? 'workspace-write' : 'read-only', '--', 'brief'],
        ['exec', 'resume', '--json', '--', THREAD, 'again'],
      ]);
      for (const call of calls) {
        expect(call.argv).not.toContain(BYPASS);
      }

      const originRef = { runId: origin.runId, sessionId: THREAD, tools };
      expect(readMeta(resumed.metaPath)).toMatchObject({
        tools,
        sessionId: THREAD,
        canonicalCwd: fs.realpathSync(cwd),
        resumedFrom: originRef,
      });
      expect(readMeta(origin.metaPath).resumedFrom).toBeUndefined();
      const status = service.status(resumed.runId);
      expect(status.found && status.info).toMatchObject({ sessionId: THREAD, resumedFrom: originRef });
      const notice = service.events(resumed.runId)?.events[0]?.event;
      expect(notice).toMatchObject({ t: 'notice', sessionId: THREAD });
      expect(String((notice as { message?: string }).message)).toContain(
        `started by run ${origin.runId}: the thread keeps its original sandbox (--tools ${tools}`,
      );

      // A second resume still traces to the starting run, not to the resume.
      const again = await service.start(request(cwd, { tools, resumeId: THREAD }));
      if (again.kind !== 'finished') throw new Error(again.message);
      expect(readMeta(again.metaPath).resumedFrom).toEqual(originRef);
    },
  );

  it('accepts the same canonical cwd reached through a symlink', async () => {
    const home = makeDir('ad-svc-home-');
    const cwd = makeDir('ad-svc-cwd-');
    const link = path.join(makeDir('ad-svc-link-'), 'repo');
    fs.symlinkSync(cwd, link);
    const { service } = codexService(home);
    await startOrigin(service, cwd, 'edit');

    const resumed = await service.start(request(link, { tools: 'edit', resumeId: THREAD }));

    expect(resumed).toMatchObject({ kind: 'finished', state: 'ended', sessionId: THREAD });
  });

  it('rejects readonly→edit and edit→readonly before spawning codex', async () => {
    const home = makeDir('ad-svc-home-');
    const cwd = makeDir('ad-svc-cwd-');
    const { service, calls } = codexService(home);
    const readonlyOrigin = await startOrigin(service, cwd, 'readonly');
    const before = runDirs(home);

    const escalate = await service.start(request(cwd, { tools: 'edit', resumeId: THREAD }));
    expect(escalate).toEqual({
      kind: 'rejected',
      message:
        `Cannot resume session ${THREAD} with --tools edit: run ${readonlyOrigin.runId} started it with --tools readonly, ` +
        'and a resumed codex thread keeps its original sandbox. Resume with --tools readonly, or start a new run with --tools edit.',
    });

    const otherHome = makeDir('ad-svc-home-');
    const other = codexService(otherHome);
    await startOrigin(other.service, cwd, 'edit');
    const mislabel = await other.service.start(request(cwd, { tools: 'readonly', resumeId: THREAD }));
    expect(mislabel.kind === 'rejected' && mislabel.message).toContain('started it with --tools edit');

    expect(calls).toHaveLength(1);
    expect(other.calls).toHaveLength(1);
    expect(runDirs(home)).toEqual(before);
  });

  it('rejects unknown and external sessions before spawning codex', async () => {
    const home = makeDir('ad-svc-home-');
    const cwd = makeDir('ad-svc-cwd-');
    const { service, calls } = codexService(home);

    for (const tools of ['readonly', 'edit'] as const) {
      const unknown = await service.start(request(cwd, { tools, resumeId: THREAD }));
      expect(unknown).toEqual({
        kind: 'rejected',
        message:
          `Cannot resume codex session ${THREAD}: no Agent Deck run on this host started it, so its sandbox is unknown. ` +
          'Resume only a sessionId printed by `agent-deck run` (see `agent-deck run list`), or start a new run without --resume.',
      });
    }

    // A resume record alone is not provenance: the starting run is missing.
    const { runId, metaPath } = service.allocate();
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    writeRunMeta(metaPath, {
      runId,
      deck: DECK.id,
      client: 'codex',
      tools: 'edit',
      cwd,
      pid: DEAD_PID,
      startedAt: new Date().toISOString(),
      state: 'ended',
      sessionId: THREAD,
      resumedFrom: { runId: 'run-gone', sessionId: THREAD, tools: 'edit' },
    });
    const orphan = await service.start(request(cwd, { tools: 'edit', resumeId: THREAD }));
    expect(orphan.kind === 'rejected' && orphan.message).toContain('no Agent Deck run on this host started it');

    expect(calls).toEqual([]);
    expect(runDirs(home)).toEqual([runId]);
  });

  it('does not treat a pre-NOT-484 resume record as the starting run', async () => {
    const home = makeDir('ad-svc-home-');
    const cwd = makeDir('ad-svc-cwd-');
    const { service, calls } = codexService(home);
    const { runId, metaPath, logPath } = service.allocate();
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    writeRunMeta(metaPath, {
      runId,
      deck: DECK.id,
      client: 'codex',
      tools: 'readonly',
      cwd,
      pid: DEAD_PID,
      startedAt: new Date().toISOString(),
      state: 'ended',
      sessionId: THREAD,
    });
    appendRunLogLine(logPath, {
      t: 'notice',
      ts: new Date().toISOString(),
      message:
        `Resuming codex thread ${THREAD}: the thread keeps its original sandbox; ` +
        '--tools readonly is recorded but cannot be re-applied on resume.',
      sessionId: THREAD,
    });

    const outcome = await service.start(request(cwd, { tools: 'readonly', resumeId: THREAD }));

    expect(outcome.kind === 'rejected' && outcome.message).toContain('no Agent Deck run on this host started it');
    expect(calls).toEqual([]);
  });

  it('rejects a cwd mismatch before spawning codex', async () => {
    const home = makeDir('ad-svc-home-');
    const cwd = makeDir('ad-svc-cwd-');
    const elsewhere = makeDir('ad-svc-cwd-');
    const { service, calls } = codexService(home);
    const origin = await startOrigin(service, cwd, 'edit');
    const before = runDirs(home);

    const outcome = await service.start(request(elsewhere, { tools: 'edit', resumeId: THREAD }));

    expect(outcome).toEqual({
      kind: 'rejected',
      message:
        `Cannot resume session ${THREAD} in ${elsewhere}: run ${origin.runId} started it in ${fs.realpathSync(cwd)}. ` +
        `Resume it with --cwd ${fs.realpathSync(cwd)}, or start a new run here.`,
    });
    expect(calls).toHaveLength(1);
    expect(runDirs(home)).toEqual(before);
  });

  it('rejects a deck mismatch before spawning codex', async () => {
    const home = makeDir('ad-svc-home-');
    const cwd = makeDir('ad-svc-cwd-');
    const { service, calls } = codexService(home);
    const origin = await startOrigin(service, cwd, 'edit');
    const before = runDirs(home);

    const otherDeck = { id: 'deck-other', name: 'other' };
    const onOther = codexService(home, {
      resolveDeck: async () => ({ ...otherDeck }),
      resolveDeckBinding: async () => ({ deckId: otherDeck.id, deckName: otherDeck.name }),
    });
    const outcome = await onOther.service.start(
      request(cwd, { deckRef: 'other', tools: 'edit', resumeId: THREAD }),
    );

    expect(outcome).toEqual({
      kind: 'rejected',
      message:
        `Cannot resume session ${THREAD} on deck "other" (deck-other): run ${origin.runId} started it on deck ${DECK.id}. ` +
        'Resume it on that deck, or start a new run on "other".',
    });
    expect(calls).toHaveLength(1);
    expect(onOther.calls).toEqual([]);
    expect(runDirs(home)).toEqual(before);
  });

  it('rejects a client mismatch before spawning codex', async () => {
    const home = makeDir('ad-svc-home-');
    const cwd = makeDir('ad-svc-cwd-');
    const claude = await makeService(
      home,
      fixtureAdapter('claude', { events: successEvents(THREAD) }),
    ).service.start(request(cwd, { client: 'claude', tools: 'edit' }));
    if (claude.kind !== 'finished') throw new Error(claude.message);
    const before = runDirs(home);
    const { service, calls } = codexService(home);

    const outcome = await service.start(request(cwd, { tools: 'edit', resumeId: THREAD }));

    expect(outcome).toEqual({
      kind: 'rejected',
      message:
        `Cannot resume session ${THREAD} with --client codex: it was started by --client claude in run ${claude.runId}. ` +
        'Resume it with --client claude, or start a new run.',
    });
    expect(calls).toEqual([]);
    expect(runDirs(home)).toEqual(before);
  });

  it('fails closed in the codex plan when execute is handed a resume without provenance', async () => {
    const home = makeDir('ad-svc-home-');
    const cwd = makeDir('ad-svc-cwd-');
    const { service, calls } = codexService(home);
    await startOrigin(service, cwd, 'readonly');

    const unproven = await service.execute({
      request: request(cwd, { tools: 'edit', resumeId: THREAD }),
      deck: DECK,
    });
    expect(unproven.kind === 'rejected' && unproven.message).toContain(
      `Cannot resume codex thread ${THREAD}: no trusted Agent Deck run is known to have started it`,
    );
    const mismatched = await service.execute({
      request: request(cwd, { tools: 'edit', resumeId: THREAD }),
      deck: DECK,
      resumedFrom: { runId: 'run-x', sessionId: THREAD, tools: 'readonly' },
    });
    expect(mismatched.kind === 'rejected' && mismatched.message).toContain(
      `Cannot resume codex thread ${THREAD} with --tools edit: run run-x started it with --tools readonly`,
    );
    expect(calls).toHaveLength(1);
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
