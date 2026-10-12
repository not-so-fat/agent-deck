import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runRunCommand } from './run';
import {
  runRunListCommand,
  runRunLogCommand,
  runRunStatusCommand,
  type RunStatusInfo,
} from './run-status';

const DEAD_PID = 2147483647;

const tmpDirs: string[] = [];
let logs: string[];
let errors: string[];
let warns: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  warns = [];
  vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
    logs.push(String(message));
  });
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    errors.push(String(message));
  });
  vi.spyOn(console, 'warn').mockImplementation((message?: unknown) => {
    warns.push(String(message));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-run-status-'));
  tmpDirs.push(dir);
  return dir;
}

function writeRun(
  homeDir: string,
  runId: string,
  meta: Record<string, unknown>,
  logLines: Array<Record<string, unknown>>,
  rawTail?: string,
): { metaPath: string; logPath: string } {
  const dir = path.join(homeDir, 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  const metaPath = path.join(dir, 'meta.json');
  const logPath = path.join(dir, 'run.jsonl');
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  const body = logLines.map((line) => JSON.stringify(line)).join('\n');
  fs.writeFileSync(logPath, body ? `${body}\n` : '', 'utf8');
  if (rawTail !== undefined) {
    fs.appendFileSync(logPath, rawTail, 'utf8');
  }
  return { metaPath, logPath };
}

function statusJson(): RunStatusInfo {
  expect(logs).toHaveLength(1);
  return JSON.parse(logs[0]) as RunStatusInfo;
}

describe('agent-deck run status (NOT-402)', () => {
  it('fixture: running with live pid reports running with exit 0', async () => {
    const homeDir = makeHome();
    const runId = 'run-live-pid';
    writeRun(
      homeDir,
      runId,
      {
        runId,
        deck: 'deck-planner',
        client: 'claude',
        tools: 'readonly',
        cwd: '/tmp/work',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        state: 'running',
      },
      [{ t: 'text', ts: '2026-10-11T10:00:01.000Z', text: 'hello' }],
    );

    const code = await runRunStatusCommand([runId, '--json'], { homeDir });

    expect(code).toBe(0);
    expect(statusJson()).toMatchObject({ runId, state: 'running' });
  });

  it('fixture: ended reports ended with exit 0', async () => {
    const homeDir = makeHome();
    const runId = 'run-ended';
    writeRun(
      homeDir,
      runId,
      {
        runId,
        deck: 'deck-planner',
        client: 'claude',
        tools: 'readonly',
        cwd: '/tmp/work',
        pid: DEAD_PID,
        startedAt: '2026-10-10T10:00:00.000Z',
        state: 'ended',
        sessionId: 'ses_ended',
      },
      [
        { t: 'text', ts: '2026-10-10T10:00:01.000Z', text: 'hi' },
        { t: 'end', ts: '2026-10-10T10:00:02.000Z', sessionId: 'ses_ended' },
      ],
    );

    const code = await runRunStatusCommand([runId, '--json'], { homeDir });

    expect(code).toBe(0);
    expect(statusJson()).toMatchObject({ runId, state: 'ended', sessionId: 'ses_ended' });
  });

  it('fixture: error reports error with exit 0', async () => {
    const homeDir = makeHome();
    const runId = 'run-error';
    writeRun(
      homeDir,
      runId,
      {
        runId,
        deck: 'deck-planner',
        client: 'claude',
        tools: 'readonly',
        cwd: '/tmp/work',
        pid: DEAD_PID,
        startedAt: '2026-10-10T11:00:00.000Z',
        state: 'error',
        sessionId: 'ses_err',
      },
      [{ t: 'error', ts: '2026-10-10T11:00:01.000Z', message: 'boom', sessionId: 'ses_err' }],
    );

    const code = await runRunStatusCommand([runId, '--json'], { homeDir });

    expect(code).toBe(0);
    expect(statusJson()).toMatchObject({ runId, state: 'error' });
  });

  it('fixture: running with dead pid reports died with exit 0', async () => {
    const homeDir = makeHome();
    const runId = 'run-dead-pid';
    writeRun(
      homeDir,
      runId,
      {
        runId,
        deck: 'deck-planner',
        client: 'claude',
        tools: 'readonly',
        cwd: '/tmp/work',
        pid: DEAD_PID,
        startedAt: '2026-10-10T12:00:00.000Z',
        state: 'running',
      },
      [{ t: 'text', ts: '2026-10-10T12:00:01.000Z', text: 'orphaned' }],
    );

    const code = await runRunStatusCommand([runId, '--json'], { homeDir });

    expect(code).toBe(0);
    expect(statusJson()).toMatchObject({ runId, state: 'died' });
  });

  it('fixture: truncated last line reports without crashing with exit 0', async () => {
    const homeDir = makeHome();
    const runId = 'run-truncated';
    writeRun(
      homeDir,
      runId,
      {
        runId,
        deck: 'deck-planner',
        client: 'claude',
        tools: 'readonly',
        cwd: '/tmp/work',
        pid: DEAD_PID,
        startedAt: '2026-10-10T13:00:00.000Z',
        state: 'ended',
        sessionId: 'ses_trunc',
      },
      [
        { t: 'text', ts: '2026-10-10T13:00:01.000Z', text: 'first' },
        { t: 'end', ts: '2026-10-10T13:00:02.000Z', sessionId: 'ses_trunc' },
      ],
      '{"t":"text","ts":"2026-10-10T13:00:03.000Z","text":"torn',
    );

    const code = await runRunStatusCommand([runId, '--json'], { homeDir });

    expect(code).toBe(0);
    expect(statusJson()).toMatchObject({
      runId,
      state: 'ended',
      lastLogTs: '2026-10-10T13:00:02.000Z',
    });
    expect(warns.join('\n')).toMatch(/truncated/);
  });

  it('--json output of status has the keys runId/deck/client/state/sessionId/startedAt/logPath and is stable (snapshot)', async () => {
    const homeDir = makeHome();
    const runId = 'run-snapshot';
    writeRun(
      homeDir,
      runId,
      {
        runId,
        deck: 'deck-planner',
        client: 'claude',
        tools: 'readonly',
        cwd: '/tmp/work',
        pid: DEAD_PID,
        startedAt: '2026-10-09T09:00:00.000Z',
        state: 'ended',
        sessionId: 'ses_snap',
      },
      [
        { t: 'text', ts: '2026-10-09T09:00:01.000Z', text: 'hello' },
        { t: 'tool', ts: '2026-10-09T09:00:02.000Z', name: 'Read' },
        {
          t: 'result',
          ts: '2026-10-09T09:00:03.000Z',
          sessionId: 'ses_snap',
          subtype: 'success',
          result: 'done',
        },
        { t: 'end', ts: '2026-10-09T09:00:04.000Z', sessionId: 'ses_snap' },
      ],
    );

    const code = await runRunStatusCommand([runId, '--json'], { homeDir });

    expect(code).toBe(0);
    const info = statusJson();
    expect(Object.keys(info).sort()).toEqual(
      ['client', 'deck', 'lastLogTs', 'logPath', 'runId', 'sessionId', 'startedAt', 'state'].sort(),
    );
    for (const key of ['runId', 'deck', 'client', 'state', 'sessionId', 'startedAt', 'logPath'] as const) {
      expect(info).toHaveProperty(key);
    }
    // The tmpdir prefix varies per run; normalize it so the snapshot is stable.
    expect({ ...info, logPath: '<home>/runs/run-snapshot/run.jsonl' }).toMatchSnapshot();
  });

  it('unknown run id exits non-zero with a one-line message', async () => {
    const homeDir = makeHome();

    const code = await runRunStatusCommand(['run-nope', '--json'], { homeDir });

    expect(code).not.toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe('Unknown run: run-nope');
    expect(logs).toHaveLength(0);
  });

  it('corrupt meta.json reports error without crashing', async () => {
    const homeDir = makeHome();
    const runId = 'run-corrupt-meta';
    const dir = path.join(homeDir, 'runs', runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), '{not json\n', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'run.jsonl'),
      `${JSON.stringify({ t: 'text', ts: '2026-10-10T14:00:01.000Z', text: 'x' })}\n`,
      'utf8',
    );

    const code = await runRunStatusCommand([runId, '--json'], { homeDir });

    expect(code).toBe(0);
    expect(statusJson()).toMatchObject({ runId, state: 'error' });
    expect(warns.join('\n')).toMatch(/corrupt/);
  });

  it('human status prints runId, deck, client, state, sessionId, startedAt, last log time, and log path', async () => {
    const homeDir = makeHome();
    const runId = 'run-human';
    const { logPath } = writeRun(
      homeDir,
      runId,
      {
        runId,
        deck: 'deck-planner',
        client: 'claude',
        tools: 'readonly',
        cwd: '/tmp/work',
        pid: DEAD_PID,
        startedAt: '2026-10-10T15:00:00.000Z',
        state: 'ended',
        sessionId: 'ses_human',
      },
      [{ t: 'end', ts: '2026-10-10T15:00:05.000Z', sessionId: 'ses_human' }],
    );

    const code = await runRunStatusCommand([runId], { homeDir });

    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain(runId);
    expect(out).toContain('deck-planner');
    expect(out).toContain('claude');
    expect(out).toContain('ended');
    expect(out).toContain('ses_human');
    expect(out).toContain('2026-10-10T15:00:00.000Z');
    expect(out).toContain('2026-10-10T15:00:05.000Z');
    expect(out).toContain(logPath);
  });

  it('run log --tail 3 returns the last three events', async () => {
    const homeDir = makeHome();
    const runId = 'run-tail';
    writeRun(
      homeDir,
      runId,
      {
        runId,
        deck: 'deck-planner',
        client: 'claude',
        tools: 'readonly',
        cwd: '/tmp/work',
        pid: DEAD_PID,
        startedAt: '2026-10-10T16:00:00.000Z',
        state: 'ended',
        sessionId: 'ses_tail',
      },
      [
        { t: 'text', ts: '2026-10-10T16:00:01.000Z', text: 'one' },
        { t: 'text', ts: '2026-10-10T16:00:02.000Z', text: 'two' },
        { t: 'tool', ts: '2026-10-10T16:00:03.000Z', name: 'Read' },
        {
          t: 'result',
          ts: '2026-10-10T16:00:04.000Z',
          sessionId: 'ses_tail',
          subtype: 'success',
          result: 'ok',
        },
        { t: 'end', ts: '2026-10-10T16:00:05.000Z', sessionId: 'ses_tail' },
      ],
    );

    const code = await runRunLogCommand([runId, '--tail', '3'], { homeDir });

    expect(code).toBe(0);
    expect(logs).toHaveLength(3);
    expect(logs.join('\n')).toContain('Read');
    expect(logs.join('\n')).toContain('result');
    expect(logs.join('\n')).toContain('end');
    expect(logs.join('\n')).not.toContain('one');
  });

  it('run log --json returns the same lines as the log file', async () => {
    const homeDir = makeHome();
    const runId = 'run-raw';
    const { logPath } = writeRun(
      homeDir,
      runId,
      {
        runId,
        deck: 'deck-planner',
        client: 'claude',
        tools: 'readonly',
        cwd: '/tmp/work',
        pid: DEAD_PID,
        startedAt: '2026-10-10T17:00:00.000Z',
        state: 'ended',
        sessionId: 'ses_raw',
      },
      [
        { t: 'text', ts: '2026-10-10T17:00:01.000Z', text: 'a' },
        { t: 'end', ts: '2026-10-10T17:00:02.000Z', sessionId: 'ses_raw' },
      ],
    );

    const code = await runRunLogCommand([runId, '--json'], { homeDir });

    expect(code).toBe(0);
    const fileLines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(logs).toEqual(fileLines);
  });

  it('run log --follow against a fixture that appends an end line exits 0 after that line', async () => {
    const homeDir = makeHome();
    const runId = 'run-follow';
    const { logPath } = writeRun(
      homeDir,
      runId,
      {
        runId,
        deck: 'deck-planner',
        client: 'claude',
        tools: 'readonly',
        cwd: '/tmp/work',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        state: 'running',
      },
      [{ t: 'text', ts: '2026-10-10T18:00:01.000Z', text: 'waiting' }],
    );

    const following = runRunLogCommand([runId, '--follow'], { homeDir, followPollMs: 10 });
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({ t: 'end', ts: '2026-10-10T18:00:02.000Z', sessionId: 'ses_follow' })}\n`,
      'utf8',
    );
    const code = await following;

    expect(code).toBe(0);
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs.at(-1)).toContain('end');
  });

  it('run log for an unknown run id exits non-zero with a one-line message', async () => {
    const homeDir = makeHome();

    const code = await runRunLogCommand(['run-missing'], { homeDir });

    expect(code).not.toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe('Unknown run: run-missing');
  });

  it('run list lists recent runs newest first with a default limit of 20', async () => {
    const homeDir = makeHome();
    for (const [runId, startedAt] of [
      ['run-old', '2026-10-08T10:00:00.000Z'],
      ['run-mid', '2026-10-09T10:00:00.000Z'],
      ['run-new', '2026-10-10T10:00:00.000Z'],
    ] as const) {
      writeRun(
        homeDir,
        runId,
        {
          runId,
          deck: 'deck-planner',
          client: 'claude',
          tools: 'readonly',
          cwd: '/tmp/work',
          pid: DEAD_PID,
          startedAt,
          state: 'ended',
        },
        [],
      );
    }

    const code = await runRunListCommand(['--json'], { homeDir });

    expect(code).toBe(0);
    expect(logs).toHaveLength(1);
    const infos = JSON.parse(logs[0]) as RunStatusInfo[];
    expect(infos.map((info) => info.runId)).toEqual(['run-new', 'run-mid', 'run-old']);
  });

  it('run subcommands route through the top-level run command', async () => {
    const homeDir = makeHome();
    const runId = 'run-routed';
    writeRun(
      homeDir,
      runId,
      {
        runId,
        deck: 'deck-planner',
        client: 'claude',
        tools: 'readonly',
        cwd: '/tmp/work',
        pid: DEAD_PID,
        startedAt: '2026-10-10T19:00:00.000Z',
        state: 'ended',
        sessionId: 'ses_routed',
      },
      [{ t: 'end', ts: '2026-10-10T19:00:01.000Z', sessionId: 'ses_routed' }],
    );

    expect(await runRunCommand(['status', runId, '--json'], { homeDir })).toBe(0);
    expect(statusJson()).toMatchObject({ runId, state: 'ended' });
    logs = [];
    expect(await runRunCommand(['log', runId, '--json'], { homeDir })).toBe(0);
    expect(logs).toHaveLength(1);
    logs = [];
    expect(await runRunCommand(['list', '--json'], { homeDir })).toBe(0);
    expect(logs).toHaveLength(1);
  });
});
