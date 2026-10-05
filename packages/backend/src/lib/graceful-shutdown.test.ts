import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { trackInFlightRequests } from './graceful-shutdown';

describe('trackInFlightRequests', () => {
  it('resolves immediately when no request is in flight', async () => {
    const server = Fastify();
    const waitForDrain = trackInFlightRequests(server);
    await expect(waitForDrain()).resolves.toBeUndefined();
    await server.close();
  });

  it('waits for the live request to respond before resolving', async () => {
    const server = Fastify();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.get('/slow', async () => {
      await gate;
      return { completed: true };
    });
    const waitForDrain = trackInFlightRequests(server);

    const responsePromise = server.inject({ method: 'GET', url: '/slow' });
    // Let the request reach the handler before draining.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const drainPromise = waitForDrain();
    let drained = false;
    void drainPromise.then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(drained).toBe(false);

    release();
    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    await expect(drainPromise).resolves.toBeUndefined();
    expect(drained).toBe(true);
    await server.close();
  });
});
