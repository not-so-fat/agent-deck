import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type FixtureMessage =
  | { type: 'ready'; port: number }
  | { type: 'request-started' }
  | { type: 'request-completed'; statusCode: number; body: unknown }
  | { type: 'request-failed'; error: string };

describe('graceful SIGTERM shutdown', () => {
  let child: ChildProcess | undefined;

  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child = undefined;
  });

  function nextMessage(...types: FixtureMessage['type'][]): Promise<FixtureMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`fixture did not send ${types.join(' or ')}`)), 5_000);
      const listener = (message: FixtureMessage) => {
        if (!types.includes(message.type)) return;
        clearTimeout(timeout);
        child?.off('message', listener);
        resolve(message);
      };
      child?.on('message', listener);
    });
  }

  it('finishes an in-flight request and exits zero within ten seconds', async () => {
    child = fork(path.join(__dirname, 'graceful-shutdown.fixture.ts'), [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    const startup = await nextMessage('ready', 'request-failed');
    expect(startup.type).toBe('ready');
    const started = nextMessage('request-started');
    const completed = nextMessage('request-completed', 'request-failed');
    child.send('begin-request');
    await started;

    const beforeSignal = Date.now();
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child?.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGTERM');
    const response = await completed;
    expect(response).toEqual({
      type: 'request-completed',
      statusCode: 200,
      body: { completed: true },
    });

    const exit = await exitPromise;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(Date.now() - beforeSignal).toBeLessThan(10_000);
  }, 12_000);
});
