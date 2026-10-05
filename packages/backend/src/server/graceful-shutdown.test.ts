import { fork, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type FixtureMessage =
  | { type: 'ready'; port: number }
  | { type: 'request-started' }
  | { type: 'startup-failed'; error: string };

describe('graceful SIGTERM shutdown', () => {
  let child: ChildProcess | undefined;
  // Tail of the fixture's stdout/stderr, kept so an IPC timeout reports
  // what the fixture was doing instead of a bare "did not send".
  let fixtureOutput = '';

  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child = undefined;
    fixtureOutput = '';
  });

  function nextMessage(...types: FixtureMessage['type'][]): Promise<FixtureMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const tail = fixtureOutput.slice(-2000);
        reject(
          new Error(
            `fixture did not send ${types.join(' or ')}${tail ? `\n--- fixture output tail ---\n${tail}` : ''}`,
          ),
        );
      }, 5_000);
      const listener = (message: FixtureMessage) => {
        if (!types.includes(message.type)) return;
        clearTimeout(timeout);
        child?.off('message', listener);
        resolve(message);
      };
      child?.on('message', listener);
    });
  }

  // The HTTP client runs here in the parent, not in the fixture: the
  // fixture's process.exit(0) after server.close() must not be able to
  // kill the client observing the drain. No keep-alive agent, so the
  // socket closes after the response and server.close() drains on request
  // completion instead of hanging on an idle keep-alive connection.
  function getSlow(port: number): Promise<{ statusCode: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port, path: '/slow', agent: false }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          let body: unknown = Buffer.concat(chunks).toString('utf8');
          try {
            body = JSON.parse(body as string);
          } catch {
            // Keep the raw text so the assertion reports it.
          }
          resolve({ statusCode: response.statusCode ?? 0, body });
        });
        response.on('error', reject);
      });
      request.on('error', reject);
    });
  }

  it('finishes an in-flight request and exits zero within ten seconds', async () => {
    child = fork(path.join(__dirname, 'graceful-shutdown.fixture.ts'), [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const appendOutput = (chunk: unknown): void => {
      fixtureOutput += String(chunk);
      if (fixtureOutput.length > 8000) fixtureOutput = fixtureOutput.slice(-8000);
    };
    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);

    const startup = await nextMessage('ready', 'startup-failed');
    expect(startup.type).toBe('ready');
    if (startup.type !== 'ready') throw new Error(`fixture failed to start: ${startup.error}`);
    const started = nextMessage('request-started');
    const responsePromise = getSlow(startup.port);
    await started;

    const beforeSignal = Date.now();
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child?.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGTERM');
    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ completed: true });

    const exit = await exitPromise;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(Date.now() - beforeSignal).toBeLessThan(10_000);
  }, 12_000);
});
