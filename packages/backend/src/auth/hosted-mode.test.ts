import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerDashboardAuthRoutes } from '../routes/trusted-session';
import { createServer } from '../server';
import { registeredHttpRoutes, registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import { SqliteOwnerAuthProvider } from './owner-auth';
import {
  registerHostedModeGuard,
  resolveHostedModeConfig,
} from './hosted-mode';

const PUBLIC_ORIGIN = 'https://deck.example.test';
const BOOTSTRAP_SECRET = 'bootstrap-secret-sentinel';
const OWNER = 'owner@example.test';
const CREDENTIAL = 'credential-sentinel';

describe('hosted owner authentication', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];
  let previousEnv: Record<string, string | undefined>;

  beforeEach(() => {
    previousEnv = {
      AGENT_DECK_HOSTED_MODE: process.env.AGENT_DECK_HOSTED_MODE,
      AGENT_DECK_PUBLIC_URL: process.env.AGENT_DECK_PUBLIC_URL,
      AGENT_DECK_OWNER_BOOTSTRAP_SECRET: process.env.AGENT_DECK_OWNER_BOOTSTRAP_SECRET,
      AGENT_DECK_HOME: process.env.AGENT_DECK_HOME,
    };
    process.env.AGENT_DECK_HOSTED_MODE = '1';
    process.env.AGENT_DECK_PUBLIC_URL = PUBLIC_ORIGIN;
    process.env.AGENT_DECK_OWNER_BOOTSTRAP_SECRET = BOOTSTRAP_SECRET;
  });

  afterEach(async () => {
    while (servers.length) await servers.pop()?.close();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function buildAuthApp(logs?: string[], now?: () => number) {
    const db = new Database(':memory:');
    const store = new TrustedSessionStore(db);
    const provider = new SqliteOwnerAuthProvider(db, BOOTSTRAP_SECRET);
    const app = logs
      ? Fastify({
          logger: {
            stream: { write: (chunk: string) => logs.push(chunk) },
          },
        })
      : Fastify();
    app.decorate('trustedSessionStore', store);
    app.decorate('ownerAuthProvider', provider);
    registerHostedModeGuard(app, { enabled: true, publicOrigin: PUBLIC_ORIGIN, now });
    registerHttpPolicyHook(app);
    app.post('/api/feedback-signals/discard', async () => ({ success: true }));
    await app.register(registerDashboardAuthRoutes, { prefix: '/api/dashboard-auth' });
    await app.ready();
    servers.push(app);
    return { app, db, store, provider };
  }

  async function signIn(app: Awaited<ReturnType<typeof Fastify>>, bootstrap = false) {
    return app.inject({
      method: 'POST',
      url: '/api/dashboard-auth/sign-in',
      payload: {
        owner: OWNER,
        credential: CREDENTIAL,
        ...(bootstrap ? { bootstrapSecret: BOOTSTRAP_SECRET } : {}),
      },
    });
  }

  it('bootstraps once through sign-in and sets a hardened host-only cookie', async () => {
    const { app } = await buildAuthApp();
    const response = await signIn(app, true);

    expect(response.statusCode).toBe(200);
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Domain=');

    const secondOwner = await app.inject({
      method: 'POST',
      url: '/api/dashboard-auth/sign-in',
      payload: {
        owner: 'other@example.test',
        credential: 'other-secret',
        bootstrapSecret: BOOTSTRAP_SECRET,
      },
    });
    expect(secondOwner.statusCode).toBe(401);
  });

  it('uses one byte-identical response for wrong credentials and unknown owners', async () => {
    const { app } = await buildAuthApp();
    await signIn(app, true);

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/dashboard-auth/sign-in',
      payload: { owner: OWNER, credential: 'wrong-secret' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/dashboard-auth/sign-in',
      payload: { owner: 'unknown@example.test', credential: 'wrong-secret' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.body).toBe(unknown.body);
  });

  it('limits sign-in failures per socket client and recovers after the window', async () => {
    let now = 10_000;
    const { app } = await buildAuthApp(undefined, () => now);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await signIn(app);
      expect(response.statusCode).toBe(401);
    }
    const limited = await signIn(app, true);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');

    now += 60_000;
    const recovered = await signIn(app, true);
    expect(recovered.statusCode).toBe(200);
  });

  it('rejects an oversized public mutation body with 413', async () => {
    const { app } = await buildAuthApp();
    const signedIn = await signIn(app, true);
    const cookie = String(signedIn.headers['set-cookie']).split(';')[0];
    const response = await app.inject({
      method: 'POST',
      url: '/api/feedback-signals/discard',
      headers: { cookie, origin: PUBLIC_ORIGIN },
      payload: { value: 'x'.repeat(1024 * 1024) },
    });
    expect(response.statusCode).toBe(413);
  });

  it('limits public mutations per socket IP, ignores forwarded IPs, and recovers', async () => {
    let now = 20_000;
    const { app } = await buildAuthApp(undefined, () => now);
    const signedIn = await signIn(app, true);
    const cookie = String(signedIn.headers['set-cookie']).split(';')[0];

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/feedback-signals/discard',
        headers: {
          cookie,
          origin: PUBLIC_ORIGIN,
          'x-forwarded-for': `198.51.100.${attempt + 1}`,
        },
      });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/feedback-signals/discard',
      headers: {
        cookie,
        origin: PUBLIC_ORIGIN,
        'x-forwarded-for': '203.0.113.200',
      },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');

    now += 60_000;
    const recovered = await app.inject({
      method: 'POST',
      url: '/api/feedback-signals/discard',
      headers: { cookie, origin: PUBLIC_ORIGIN },
    });
    expect(recovered.statusCode).toBe(200);
  });

  it('rejects a cross-site mutation with a valid session before state changes', async () => {
    const { app } = await buildAuthApp();
    const signedIn = await signIn(app, true);
    const cookie = String(signedIn.headers['set-cookie']).split(';')[0];

    const response = await app.inject({
      method: 'POST',
      url: '/api/dashboard-auth/revoke-all',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(response.statusCode).toBe(403);

    const stillSignedIn = await app.inject({
      method: 'POST',
      url: '/api/dashboard-auth/logout',
      headers: { cookie, origin: PUBLIC_ORIGIN },
    });
    expect(stillSignedIn.statusCode).toBe(200);
  });

  it('logout and revoke-all invalidate sessions on the next request', async () => {
    const { app } = await buildAuthApp();
    await signIn(app, true);
    const first = await signIn(app);
    const second = await signIn(app);
    const firstCookie = String(first.headers['set-cookie']).split(';')[0];
    const secondCookie = String(second.headers['set-cookie']).split(';')[0];

    expect((await app.inject({
      method: 'POST', url: '/api/dashboard-auth/logout',
      headers: { cookie: firstCookie, origin: PUBLIC_ORIGIN },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: '/api/dashboard-auth/logout',
      headers: { cookie: firstCookie, origin: PUBLIC_ORIGIN },
    })).statusCode).toBe(401);

    expect((await app.inject({
      method: 'POST', url: '/api/dashboard-auth/revoke-all',
      headers: { cookie: secondCookie, origin: PUBLIC_ORIGIN },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: '/api/dashboard-auth/logout',
      headers: { cookie: secondCookie, origin: PUBLIC_ORIGIN },
    })).statusCode).toBe(401);
  });

  it('never returns submitted credentials or bootstrap secrets', async () => {
    const logs: string[] = [];
    const { app } = await buildAuthApp(logs);
    const success = await signIn(app, true);
    const failure = await app.inject({
      method: 'POST',
      url: '/api/dashboard-auth/sign-in',
      payload: { owner: OWNER, credential: CREDENTIAL, bootstrapSecret: 'wrong-bootstrap' },
    });
    for (const response of [success, failure]) {
      expect(response.body).not.toContain(CREDENTIAL);
      expect(response.body).not.toContain(BOOTSTRAP_SECRET);
      expect(response.body).not.toContain(String(success.headers['set-cookie']).split('=')[1]?.split(';')[0]);
    }
    const emittedLogs = logs.join('');
    expect(emittedLogs).not.toContain(CREDENTIAL);
    expect(emittedLogs).not.toContain(BOOTSTRAP_SECRET);
    expect(emittedLogs).not.toContain(
      String(success.headers['set-cookie']).split('=')[1]?.split(';')[0],
    );
  });

  it('returns 401 from every registered route except probes and sign-in', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-hosted-matrix-'));
    process.env.AGENT_DECK_HOME = home;
    registeredHttpRoutes.length = 0;
    const server = await createServer();
    await server.ready();
    servers.push(server);

    const tested = new Set<string>();
    for (const route of registeredHttpRoutes) {
      const url = route.url.replace(/:([^/]+)/g, 'test-id').replace(/\*/g, 'asset');
      const key = `${route.method} ${url}`;
      if (
        tested.has(key) ||
        key === 'GET /health' ||
        key === 'HEAD /health' ||
        key === 'GET /healthz' ||
        key === 'HEAD /healthz' ||
        key === 'GET /readyz' ||
        key === 'HEAD /readyz' ||
        key === 'POST /api/dashboard-auth/sign-in'
      ) {
        continue;
      }
      tested.add(key);
      const response = await server.inject({ method: route.method, url });
      expect(response.statusCode, key).toBe(401);
      expect(response.body, key).not.toContain('deck');
    }
    expect(tested.size).toBeGreaterThan(80);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('resolveHostedModeConfig', () => {
  it('is enabled only by the exact explicit flag', () => {
    expect(resolveHostedModeConfig({ AGENT_DECK_HOSTED_MODE: '0' })).toEqual({ enabled: false });
    expect(resolveHostedModeConfig({ AGENT_DECK_HOSTED_MODE: 'true' })).toEqual({ enabled: false });
    expect(resolveHostedModeConfig({
      AGENT_DECK_HOSTED_MODE: '1',
      AGENT_DECK_PUBLIC_URL: 'https://deck.example.test/path',
    })).toEqual({ enabled: true, publicOrigin: 'https://deck.example.test' });
  });

  it('requires an HTTPS public URL in hosted mode', () => {
    expect(() => resolveHostedModeConfig({ AGENT_DECK_HOSTED_MODE: '1' })).toThrow();
    expect(() => resolveHostedModeConfig({
      AGENT_DECK_HOSTED_MODE: '1',
      AGENT_DECK_PUBLIC_URL: 'http://deck.example.test',
    })).toThrow();
  });
});
