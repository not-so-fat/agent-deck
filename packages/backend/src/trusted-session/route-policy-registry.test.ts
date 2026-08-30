import { afterAll, describe, expect, it } from 'vitest';

import { createServer } from '../server/index';
import { assertAllRoutesHavePolicies, registeredHttpRoutes } from '../trusted-session/policy-hook';
import { resolveRoutePolicy } from '../trusted-session/route-policy-registry';

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

  it('resolves sensitive mutation routes to requireDashboard', () => {
    expect(resolveRoutePolicy('POST', '/api/playbooks')).toBe('requireDashboard');
    expect(resolveRoutePolicy('PUT', '/api/playbooks/pb_123')).toBe('requireDashboard');
    expect(resolveRoutePolicy('PUT', '/api/services/svc_123/tool-settings')).toBe('requireDashboard');
    expect(resolveRoutePolicy('POST', '/api/playbook-patches')).toBe('requireAgentOrDashboard');
  });
});
