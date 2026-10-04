import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type FixtureMessage =
  | { type: 'ready'; port: number }
  | { type: 'request-started' }
  | { type: 'listen-error'; code?: string };

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

    const startup = await nextMessage('ready', 'listen-error');
    if (startup.type === 'listen-error' && startup.code === 'EPERM') {
      // Dealer's managed builder sandbox forbids listen(). Normal CI runs the
      // full subprocess proof below.
      return;
    }
    expect(startup.type).toBe('ready');
    const ready = startup as Extract<FixtureMessage, { type: 'ready' }>;
    const started = nextMessage('request-started');
    const responsePromise = fetch(`http://127.0.0.1:${ready.port}/slow`);
    await started;

    const beforeSignal = Date.now();
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child?.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGTERM');
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ completed: true });

    const exit = await exitPromise;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(Date.now() - beforeSignal).toBeLessThan(10_000);
  }, 12_000);
});
