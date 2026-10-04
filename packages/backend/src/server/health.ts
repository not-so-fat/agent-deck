import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

import { parseVaultKey, VAULT_KEY_ENV_VAR, VaultKeyError } from '../vault/encrypted-file-secret-store';

export type ReadinessReason =
  | 'vault_key_missing'
  | 'vault_key_invalid'
  | 'data_not_writable'
  | 'sqlite_unavailable';

export type ReadinessResult =
  | { ready: true }
  | { ready: false; reason: ReadinessReason };

export type ReadinessProbeOptions = {
  env?: NodeJS.ProcessEnv;
  dataPath: string;
  sqliteProbe: () => void | Promise<void>;
};

async function dataPathIsWritable(dataPath: string): Promise<boolean> {
  const probePath = path.join(dataPath, `.agent-deck-ready-${process.pid}-${Date.now()}`);
  try {
    await fs.mkdir(dataPath, { recursive: true });
    await fs.writeFile(probePath, '', { flag: 'wx', mode: 0o600 });
    await fs.unlink(probePath);
    return true;
  } catch {
    await fs.unlink(probePath).catch(() => undefined);
    return false;
  }
}

/**
 * Probe only operator-controlled dependencies. Responses intentionally expose
 * stable codes rather than exception text, paths, key material, or SQLite
 * diagnostics.
 */
export async function assessReadiness(options: ReadinessProbeOptions): Promise<ReadinessResult> {
  const env = options.env ?? process.env;
  const rawVaultKey = env[VAULT_KEY_ENV_VAR];
  if (!rawVaultKey?.trim()) {
    return { ready: false, reason: 'vault_key_missing' };
  }
  try {
    parseVaultKey(rawVaultKey);
  } catch (error) {
    if (error instanceof VaultKeyError) {
      return { ready: false, reason: 'vault_key_invalid' };
    }
    throw error;
  }

  if (!(await dataPathIsWritable(options.dataPath))) {
    return { ready: false, reason: 'data_not_writable' };
  }

  try {
    await options.sqliteProbe();
  } catch {
    return { ready: false, reason: 'sqlite_unavailable' };
  }

  return { ready: true };
}

export function registerHealthRoutes(
  fastify: FastifyInstance,
  options: ReadinessProbeOptions,
): void {
  fastify.get('/healthz', async () => ({ status: 'ok' }));
  fastify.get('/readyz', async (_request, reply) => {
    const result = await assessReadiness(options);
    if (!result.ready) {
      return reply.status(503).send({ status: 'not_ready', reason: result.reason });
    }
    return { status: 'ready' };
  });
}
