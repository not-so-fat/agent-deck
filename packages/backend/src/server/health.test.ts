import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerHealthRoutes } from './health';

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

describe('backend health endpoints', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function build(
    env: NodeJS.ProcessEnv,
    options: { sqliteProbe?: () => void | Promise<void>; dataPath?: string } = {},
  ) {
    const app = Fastify();
    const dataPath = options.dataPath ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'agent-deck-ready-')));
    cleanup.push(dataPath);
    registerHealthRoutes(app, {
      env,
      dataPath,
      sqliteProbe: options.sqliteProbe ?? (() => undefined),
    });
    return app;
  }

  it('keeps liveness independent from readiness', async () => {
    const app = await build({});
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it.each([
    ['unset', {}, 'vault_key_missing'],
    ['empty', { AGENT_DECK_VAULT_KEY: '   ' }, 'vault_key_missing'],
    ['malformed', { AGENT_DECK_VAULT_KEY: 'this-is-not-a-key' }, 'vault_key_invalid'],
  ])('returns a secret-free reason when the vault key is %s', async (_label, env, reason) => {
    const app = await build(env);
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason });
    expect(response.body).not.toContain(env.AGENT_DECK_VAULT_KEY ?? 'never-present');
    await app.close();
  });

  it('reports a non-writable data path without exposing it', async () => {
    const blockedPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-deck-ready-readonly-'));
    cleanup.push(blockedPath);
    await fs.chmod(blockedPath, 0o555);
    const app = await build({ AGENT_DECK_VAULT_KEY: TEST_KEY }, { dataPath: blockedPath });
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'data_not_writable' });
    expect(response.body).not.toContain(blockedPath);
    await app.close();
    await fs.chmod(blockedPath, 0o755);
  });

  it('reports a SQLite open failure with a stable reason', async () => {
    const app = await build(
      { AGENT_DECK_VAULT_KEY: TEST_KEY },
      { sqliteProbe: () => { throw new Error('secret database detail'); } },
    );
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'sqlite_unavailable' });
    expect(response.body).not.toContain('secret database detail');
    await app.close();
  });

  it('returns ready only when every probe succeeds', async () => {
    const app = await build({ AGENT_DECK_VAULT_KEY: TEST_KEY });
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
    await app.close();
  });
});
