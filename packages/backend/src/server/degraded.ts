import Fastify from 'fastify';

import { resolveAgentDeckHome } from '../lib/paths';
import { registerHealthRoutes } from './health';

const STORAGE_ERROR_CODES = new Set([
  'EACCES',
  'EPERM',
  'EROFS',
  'ENOTDIR',
  'SQLITE_CANTOPEN',
  'SQLITE_CORRUPT',
  'SQLITE_IOERR',
  'SQLITE_NOTADB',
  'SQLITE_READONLY',
]);

export function isStorageStartupError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code && (STORAGE_ERROR_CODES.has(code) || code.startsWith('SQLITE_'))) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /sqlite|database (?:is|could not be) (?:opened|open)|readonly database/i.test(message);
}

/**
 * If persistent state cannot initialize, retain only the two probe endpoints.
 * This keeps liveness truthful while readiness reports the operator-fixable
 * storage reason; no product API is exposed with half-initialized state.
 */
export function createStorageFailureServer(
  startupError: unknown,
  options: { env?: NodeJS.ProcessEnv; dataPath?: string } = {},
) {
  const fastify = Fastify({ logger: { level: 'info' } });
  fastify.log.error({ err: startupError }, 'persistent state unavailable; serving probes only');
  registerHealthRoutes(fastify, {
    env: options.env,
    dataPath: options.dataPath ?? resolveAgentDeckHome(),
    sqliteProbe: () => { throw startupError; },
  });
  return fastify;
}
