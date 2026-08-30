import { afterAll, describe, expect, it } from 'vitest';

import { createServer } from '../server/index';
import { assertAllRoutesHavePolicies, registeredHttpRoutes } from '../trusted-session/policy-hook';

describe('HTTP route policy registry', () => {
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  afterAll(async () => {
    await server?.close();
  });

  it('every registered API route declares an authorization policy', async () => {
    registeredHttpRoutes.length = 0;
    server = await createServer();
    await server.ready();

    expect(() => assertAllRoutesHavePolicies()).not.toThrow();
    expect(registeredHttpRoutes.length).toBeGreaterThan(80);
  });
});
