import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createStorageFailureServer, isStorageStartupError } from './degraded';

const TEST_KEY = Buffer.alloc(32, 9).toString('base64');

describe('storage-degraded backend', () => {
  it.each(['SQLITE_CANTOPEN', 'SQLITE_CORRUPT', 'EROFS', 'EACCES'])(
    'recognizes %s as a storage startup failure',
    (code) => {
      const error = Object.assign(new Error('startup failed'), { code });
      expect(isStorageStartupError(error)).toBe(true);
    },
  );

  it('does not hide unrelated configuration failures', () => {
    expect(isStorageStartupError(new Error('AGENT_DECK_PUBLIC_URL is required'))).toBe(false);
  });

  it('stays live but not ready when SQLite cannot open', async () => {
    const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-deck-degraded-'));
    const app = createStorageFailureServer(
      Object.assign(new Error('sensitive sqlite detail'), { code: 'SQLITE_CANTOPEN' }),
      { env: { AGENT_DECK_VAULT_KEY: TEST_KEY }, dataPath },
    );
    const live = await app.inject({ method: 'GET', url: '/healthz' });
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'not_ready', reason: 'sqlite_unavailable' });
    expect(ready.body).not.toContain('sensitive sqlite detail');
    await app.close();
    await fs.rm(dataPath, { recursive: true, force: true });
  });
});
