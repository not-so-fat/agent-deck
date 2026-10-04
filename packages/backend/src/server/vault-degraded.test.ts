import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createServer } from './index';

describe('hosted startup without a vault key', () => {
  const originalEnv = { ...process.env };
  let home: string | undefined;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (home) fs.rmSync(home, { recursive: true, force: true });
    home = undefined;
    process.env = { ...originalEnv };
  });

  it('stays live and reports vault_key_missing when legacy secret headers exist', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-vault-degraded-'));
    process.env.AGENT_DECK_HOME = home;
    process.env.AGENT_DECK_HOSTED_MODE = '1';
    process.env.AGENT_DECK_PUBLIC_URL = 'https://deck.example.test';
    process.env.AGENT_DECK_OWNER_BOOTSTRAP_SECRET = 'test-owner-bootstrap';
    delete process.env.AGENT_DECK_SECRET_STORE;
    delete process.env.AGENT_DECK_VAULT_KEY;

    const initial = await createServer();
    const [service] = await initial.db.getAllServices();
    expect(service).toBeDefined();
    await initial.db.updateService(service.id, {
      headers: { Authorization: 'Bearer legacy-secret' },
    });
    await initial.close();

    app = await createServer();
    await app.ready();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const live = await app.inject({ method: 'GET', url: '/healthz' });
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'not_ready', reason: 'vault_key_missing' });
    expect(ready.body).not.toContain('legacy-secret');
  });
});
