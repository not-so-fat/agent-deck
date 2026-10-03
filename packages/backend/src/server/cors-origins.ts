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
    // Mirror the listener in packages/backend/src/index.ts, which parses
    // with parseInt(process.env.PORT), so CORS derives from the same port
    // the backend actually binds (e.g. '2111abc' listens on 2111).
    const parsed = parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }
  }
  return DEFAULT_CORS_PORT_FALLBACK;
}

// Validate an AGENT_DECK_DASHBOARD_ORIGIN entry and return its normalized
// origin, or undefined when it must be ignored. Only bare http/https
// origins (no path, query, fragment, or wildcard) are kept.
function normalizeExtraOrigin(entry: string): string | undefined {
  if (entry === '' || entry.includes('*')) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined;
  }
  // No path, query, fragment, or wildcard: entry must be a bare origin.
  const afterScheme = entry.slice(entry.indexOf('://') + 3);
  if (afterScheme === '' || /[/?#]/.test(afterScheme)) {
    return undefined;
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return undefined;
  }
  // Store the normalized origin: browsers send url.origin, so a typed entry
  // like 'HTTP://A.example' or 'http://a.example:80' would otherwise never
  // match the incoming Origin header.
  return url.origin;
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
      const normalized = normalizeExtraOrigin(part.trim());
      if (normalized === undefined || seen.has(normalized)) {
        continue;
      }
      push(normalized);
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
