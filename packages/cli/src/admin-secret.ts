import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveAgentDeckHome } from '@agent-deck/shared';

const ADMIN_SECRET_FILENAME = 'admin-secret';

export async function getAdminSecretPath(): Promise<string> {
  return path.join(resolveAgentDeckHome(), ADMIN_SECRET_FILENAME);
}

export async function ensureAdminSecret(): Promise<string> {
  const secretPath = await getAdminSecretPath();
  try {
    const existing = await fs.readFile(secretPath, 'utf8');
    const trimmed = existing.trim();
    if (trimmed.length >= 32) {
      return trimmed;
    }
  } catch {
    // create below
  }

  const secret = randomBytes(32).toString('base64url');
  await fs.mkdir(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(secretPath, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  return secret;
}

export async function readAdminSecret(): Promise<string | null> {
  const fromEnv = process.env.AGENT_DECK_ADMIN_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 32) {
    return fromEnv;
  }

  try {
    const secretPath = await getAdminSecretPath();
    const value = await fs.readFile(secretPath, 'utf8');
    const trimmed = value.trim();
    return trimmed.length >= 32 ? trimmed : null;
  } catch {
    return null;
  }
}

export function hashAdminSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function verifyAdminSecret(provided: string, expected: string): boolean {
  const digest = Buffer.from(hashAdminSecret(provided), 'hex');
  const expectedDigest = Buffer.from(hashAdminSecret(expected), 'hex');
  if (digest.length !== expectedDigest.length) {
    return false;
  }
  return timingSafeEqual(digest, expectedDigest);
}
