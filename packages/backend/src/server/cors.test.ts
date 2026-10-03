import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerCors } from './cors-origins';

describe('registerCors', () => {
  let app: Awaited<ReturnType<typeof Fastify>> | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  async function build() {
    app = Fastify();
    await registerCors(app!, { PORT: '2111' } as NodeJS.ProcessEnv);
    app!.get('/ping', async () => ({ ok: true }));
    return app!;
  }

  it('allows the configured loopback origin with credentials', async () => {
    const server = await build();
    const res = await server.inject({
      method: 'GET',
      url: '/ping',
      headers: { origin: 'http://127.0.0.1:2111' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:2111');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('allows requests with no Origin (curl/CLI)', async () => {
    const server = await build();
    const res = await server.inject({ method: 'GET', url: '/ping' });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['wrong port', 'http://localhost:2112', undefined],
    ['subdomain suffix', 'http://127.0.0.1.evil.example:2111', undefined],
    ['parent-domain suffix', 'http://127.0.0.1:2111.evil.example', undefined],
    ['opaque origin', 'null', undefined],
    ['unlisted origin regardless of Host', 'http://evil.example', 'evil.example'],
  ])('rejects %s without reflecting it', async (_label, origin, host) => {
    const server = await build();
    const res = await server.inject({
      method: 'GET',
      url: '/ping',
      headers: {
        origin,
        ...(host ? { host } : {}),
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
