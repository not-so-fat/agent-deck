/**
 * The CLI drives the shared host-local run service (NOT-479): a fixture
 * adapter injected through RunDeps runs start, resume, observe, and terminal
 * paths through `agent-deck run`, and a service the backend builds over the
 * same home reads the very same run record.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAgentRunService,
  type AdapterStartArgs,
  type ClientAdapter,
  type NormalizedEvent,
  type RunClient,
} from '@agent-deck/backend/agent-run';

import type { McpLaunchPlan } from './mcp-launcher';
import { runRunCommand, type RunDeps, type RunMeta } from './run';

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DECK = { id: 'deck-svc', name: 'svc' };

const tmpDirs: string[] = [];
let logs: string[];
let errors: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
    logs.push(String(message));
  });
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    errors.push(String(message));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function fixtureAdapter(
  client: RunClient,
  events: NormalizedEvent[],
  fail?: Error,
): ClientAdapter & { starts: AdapterStartArgs[] } {
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
      yield* events;
      if (fail) {
        throw fail;
      }
    },
  };
}

function makeDeps(homeDir: string, cwd: string, adapter: ClientAdapter): RunDeps {
  const plan: McpLaunchPlan = {
    workspaceRoot: cwd,
    mcpUrl: 'http://127.0.0.1:1110/mcp',
    deckId: DECK.id,
    deckName: DECK.name,
    headers: [],
  };
  return {
    homeDir,
    resolveDeck: async (ref) => (ref === DECK.name ? { ...DECK } : null),
    resolveLaunchPlan: (async () => plan) as unknown as RunDeps['resolveLaunchPlan'],
    claudeProbe: async () => ({ ok: true }),
    createAdapter: () => adapter,
  };
}

function runIdFromLog(line: string | undefined): string {
  const match = /^run (\S+) /.exec(line ?? '');
  if (!match) throw new Error(`no run line in ${line}`);
  return match[1];
}

describe('agent-deck run on the shared run service (NOT-479)', () => {
  it('starts, observes, and resumes a fixture run with the existing JSONL and meta shapes', async () => {
    const home = makeDir('ad-cli-svc-home-');
    const cwd = makeDir('ad-cli-svc-cwd-');
    const first = fixtureAdapter('codex', [
      { kind: 'text', text: 'working', sessionId: 'thread-1' },
      { kind: 'tool', name: 'command_execution', sessionId: 'thread-1' },
      { kind: 'result', subtype: 'success', result: 'shipped', sessionId: 'thread-1' },
    ]);

    const code = await runRunCommand(
      ['svc', '--client', 'codex', '--cwd', cwd, '--prompt', 'brief'],
      makeDeps(home, cwd, first),
    );

    expect(errors).toEqual([]);
    expect(code).toBe(0);
    expect(first.starts).toEqual([{ cwd, prompt: 'brief', tools: 'readonly' }]);
    const runId = runIdFromLog(logs[0]);
    const logPath = path.join(home, 'runs', runId, 'run.jsonl');
    expect(logs).toEqual([`run ${runId} ended: log ${logPath} sessionId thread-1`]);

    const lines = fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const line of lines) {
      expect(line.ts).toMatch(ISO_TS);
    }
    expect(lines.map(({ ts: _ts, ...rest }) => rest)).toEqual([
      { t: 'text', text: 'working' },
      { t: 'tool', name: 'command_execution' },
      { t: 'result', sessionId: 'thread-1', subtype: 'success', result: 'shipped' },
      { t: 'end', sessionId: 'thread-1' },
    ]);
    const meta = JSON.parse(
      fs.readFileSync(path.join(home, 'runs', runId, 'meta.json'), 'utf8'),
    ) as RunMeta;
    expect(meta).toEqual({
      runId,
      deck: DECK.id,
      client: 'codex',
      tools: 'readonly',
      cwd,
      canonicalCwd: fs.realpathSync(cwd),
      pid: process.pid,
      startedAt: expect.stringMatching(ISO_TS),
      state: 'ended',
      sessionId: 'thread-1',
    });

    // Observe through the CLI poll commands...
    logs = [];
    expect(await runRunCommand(['status', runId, '--json'], { homeDir: home })).toBe(0);
    expect(JSON.parse(logs[0])).toMatchObject({ runId, state: 'ended', sessionId: 'thread-1' });
    logs = [];
    expect(await runRunCommand(['log', runId, '--json'], { homeDir: home })).toBe(0);
    expect(logs.map((line) => (JSON.parse(line) as { t: string }).t)).toEqual([
      'text', 'tool', 'result', 'end',
    ]);

    // ...and through a service the backend builds over the same home: one record.
    const backend = createAgentRunService({
      homeDir: home,
      resolveDeck: async () => null,
      resolveDeckBinding: async () => ({}),
    });
    const status = backend.status(runId);
    expect(status.found && status.info).toMatchObject({ runId, deck: DECK.id, state: 'ended' });
    expect(backend.events(runId)?.events.map((entry) => entry.raw)).toEqual(
      fs.readFileSync(logPath, 'utf8').trim().split('\n'),
    );

    // Resume continues the session under a new run.
    logs = [];
    const second = fixtureAdapter('codex', [{ kind: 'result', subtype: 'success', result: 'again' }]);
    expect(
      await runRunCommand(
        ['svc', '--client', 'codex', '--cwd', cwd, '--prompt', 'more', '--resume', 'thread-1'],
        makeDeps(home, cwd, second),
      ),
    ).toBe(0);
    // Codex resume carries the trusted origin run (NOT-484).
    expect(second.starts).toEqual([
      {
        cwd,
        prompt: 'more',
        tools: 'readonly',
        resumeId: 'thread-1',
        resumedFrom: { runId, sessionId: 'thread-1', tools: 'readonly' },
      },
    ]);
    const resumedId = runIdFromLog(logs[0]);
    expect(resumedId).not.toBe(runId);
    expect(logs[0]).toMatch(/ ended: .* sessionId thread-1$/);
  });

  it('terminates a failing fixture run as error with the error line and exit 1', async () => {
    const home = makeDir('ad-cli-svc-home-');
    const cwd = makeDir('ad-cli-svc-cwd-');
    const adapter = fixtureAdapter(
      'muse',
      [{ kind: 'text', text: 'partial', sessionId: 'ses_m' }],
      new Error('muse exited with code 2'),
    );

    const code = await runRunCommand(
      ['svc', '--client', 'muse', '--cwd', cwd, '--prompt', 'brief', '--tools', 'edit'],
      makeDeps(home, cwd, adapter),
    );

    expect(code).toBe(1);
    const runId = runIdFromLog(logs[0]);
    const logPath = path.join(home, 'runs', runId, 'run.jsonl');
    expect(logs).toEqual([`run ${runId} error: log ${logPath} sessionId ses_m`]);
    const last = JSON.parse(fs.readFileSync(logPath, 'utf8').trim().split('\n').at(-1) ?? '{}');
    expect(last).toMatchObject({ t: 'error', message: 'muse exited with code 2', sessionId: 'ses_m' });
    const meta = JSON.parse(
      fs.readFileSync(path.join(home, 'runs', runId, 'meta.json'), 'utf8'),
    ) as RunMeta;
    expect(meta).toMatchObject({ state: 'error', tools: 'edit', sessionId: 'ses_m' });
  });
});
