import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from '../server/index';
import { assertAllRoutesHavePolicies, registeredHttpRoutes } from '../trusted-session/policy-hook';
import { resolveRoutePolicy } from '../trusted-session/route-policy-registry';

describe('HTTP route policy registry', () => {
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let home: string | undefined;
  let previousHome: string | undefined;

  beforeAll(() => {
    previousHome = process.env.AGENT_DECK_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-policy-'));
    process.env.AGENT_DECK_HOME = home;
  });

  afterAll(async () => {
    await server?.close();
    if (previousHome === undefined) {
      delete process.env.AGENT_DECK_HOME;
    } else {
      process.env.AGENT_DECK_HOME = previousHome;
    }
    if (home) {
      fs.rmSync(home, { recursive: true, force: true });
    }
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

  it('covers execution-authority issuer routes', () => {
    expect(resolveRoutePolicy('POST', '/api/execution-authority/enrollments')).toBe(
      'requireTrustedWriter',
    );
    expect(resolveRoutePolicy('POST', '/api/execution-authority/authorities')).toBe('allowPublic');
    expect(resolveRoutePolicy('POST', '/api/execution-authority/mcp/connect')).toBe('allowPublic');
  });
});
