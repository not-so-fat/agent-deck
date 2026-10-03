import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';

export const DEFAULT_CORS_PORT_FALLBACK = 8000;

export const DEFAULT_ALLOWED_ORIGINS = [
  'http://127.0.0.1:1111',
  'http://localhost:1111',
  'http://127.0.0.1:3000',
  'http://localhost:3000',
];

function resolvePort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT?.trim();
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }
  }
  return DEFAULT_CORS_PORT_FALLBACK;
}

function isAllowedExtraOrigin(entry: string): boolean {
  if (entry === '' || entry.includes('*')) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }
  // No path, query, fragment, or wildcard: entry must be a bare origin.
  const afterScheme = entry.slice(entry.indexOf('://') + 3);
  if (afterScheme === '' || /[/?#]/.test(afterScheme)) {
    return false;
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return false;
  }
  return true;
}

export function resolveAllowedOrigins(env: NodeJS.ProcessEnv): string[] {
  const port = resolvePort(env);
  const seen = new Set<string>();
  const result: string[] = [];
  const push = (origin: string) => {
    if (!seen.has(origin)) {
      seen.add(origin);
      result.push(origin);
    }
  };

  push(`http://127.0.0.1:${port}`);
  push(`http://localhost:${port}`);
  for (const origin of DEFAULT_ALLOWED_ORIGINS) {
    push(origin);
  }

  const rawExtra = env.AGENT_DECK_DASHBOARD_ORIGIN;
  if (rawExtra !== undefined && rawExtra !== '') {
    for (const part of rawExtra.split(',')) {
      const entry = part.trim();
      if (entry === '' || seen.has(entry)) {
        continue;
      }
      if (isAllowedExtraOrigin(entry)) {
        push(entry);
      }
    }
  }

  return result;
}

export async function registerCors(
  fastify: FastifyInstance,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const allowedOrigins = resolveAllowedOrigins(env);
  await fastify.register(cors, {
    origin: (origin, cb) => {
      if (!origin) {
        // Non-browser clients (curl, CLI) — allow.
        return cb(null, true);
      }
      if (allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      cb(new Error('Origin not allowed by CORS'), false);
    },
    credentials: true,
  });
}
