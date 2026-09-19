/**
 * NOT-153: Dashboard create-deck happy path + error surfaces.
 */
import Fastify from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DatabaseManager } from '../models/database';
import { dashboardAuthHeaders } from '../test/auth-fixtures';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import { FileStoreWriter } from '../store/writer';
import { registerDeckRoutes } from './decks';

describe('POST /api/decks (NOT-153 dashboard create)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
    while (tempDirs.length) {
      const dir = tempDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  async function buildApp(options?: {
    storeWriter?: { writeDeck: (deck: unknown) => Promise<void> };
    withRealStore?: boolean;
  }) {
    const db = new DatabaseManager(':memory:');
    await db.createDeck({ name: 'seed' });

    const store = new TrustedSessionStore(db.getSqliteDatabase());
    let storeWriter = options?.storeWriter;
    let storeHome: string | undefined;

    if (options?.withRealStore) {
      storeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-deck-create-'));
      tempDirs.push(storeHome);
      const writer = new FileStoreWriter(storeHome);
      await writer.ensureLayout();
      storeWriter = writer;
    }

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('credentialManager', {
      applySecretStatus: async (credentials: unknown[]) => credentials,
    });
    fastify.decorate('serviceHeaderVault', undefined);

    registerHttpPolicyHook(fastify);
    await fastify.register(registerDeckRoutes, {
      prefix: '/api/decks',
      storeWriter: storeWriter as FileStoreWriter | undefined,
    });
    await fastify.ready();
    servers.push(fastify);

    return { fastify, db, store, storeHome };
  }

  it('dashboard session creates a unique deck (201) and persists it', async () => {
    const { fastify, db, store } = await buildApp({
      storeWriter: { writeDeck: async () => {} },
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/decks',
      headers: dashboardAuthHeaders(store),
      payload: { name: 'Hiring stack', isActive: false },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      name: 'Hiring stack',
      isActive: false,
    });
    expect(body.data.id).toBeTruthy();

    const listed = await db.getAllDecks();
    expect(listed.some((d) => d.id === body.data.id && d.name === 'Hiring stack')).toBe(true);
  });

  it('dashboard create writes the deck file when a file store is configured', async () => {
    const { fastify, store, storeHome } = await buildApp({ withRealStore: true });

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/decks',
      headers: dashboardAuthHeaders(store),
      payload: { name: 'File-backed', isActive: false },
    });

    expect(response.statusCode).toBe(201);
    const deckId = response.json().data.id as string;
    const deckFile = path.join(storeHome!, 'decks', `${deckId}.json`);
    const raw = await fs.readFile(deckFile, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ id: deckId, name: 'File-backed' });
  });

  it('duplicate name returns 400 with an already-exists message', async () => {
    const { fastify, store } = await buildApp({
      storeWriter: { writeDeck: async () => {} },
    });

    const first = await fastify.inject({
      method: 'POST',
      url: '/api/decks',
      headers: dashboardAuthHeaders(store),
      payload: { name: 'dup-name' },
    });
    expect(first.statusCode).toBe(201);

    const second = await fastify.inject({
      method: 'POST',
      url: '/api/decks',
      headers: dashboardAuthHeaders(store),
      payload: { name: 'dup-name' },
    });

    expect(second.statusCode).toBe(400);
    expect(second.json().error).toMatch(/already exists/i);
  });

  it('file-store flush failure returns an error and does not leave an orphan deck', async () => {
    const { fastify, db, store } = await buildApp({
      storeWriter: {
        writeDeck: async () => {
          throw new Error('ENOSPC: no space left on device');
        },
      },
    });

    const before = (await db.getAllDecks()).map((d) => d.id);

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/decks',
      headers: dashboardAuthHeaders(store),
      payload: { name: 'orphan-check' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().success).toBe(false);
    expect(String(response.json().error)).toMatch(/file store|ENOSPC|write/i);

    const after = await db.getAllDecks();
    expect(after.map((d) => d.id).sort()).toEqual([...before].sort());
    expect(after.some((d) => d.name === 'orphan-check')).toBe(false);
  });
});
