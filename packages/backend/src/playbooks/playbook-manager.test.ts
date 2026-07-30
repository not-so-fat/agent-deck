import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../models/database';
import { PlaybookManager } from './playbook-manager';

describe('PlaybookManager', () => {
  let dbPath: string;
  let db: DatabaseManager;
  let manager: PlaybookManager;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `agent-deck-playbooks-${Date.now()}.db`);
    db = new DatabaseManager(dbPath);
    manager = new PlaybookManager(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('creates and lists playbook cards', async () => {
    const playbook = await manager.create({
      title: 'Hiring inbox',
      body: '# Steps\n1. Run CLI',
      triggers: ['check inbox'],
      dependsOnCredentialIds: ['cred_ashby'],
    });

    expect(playbook.id).toBe('pb_hiring_inbox');
    expect(await manager.list()).toHaveLength(1);
  });

  it('blocks credential delete when a playbook depends on it', async () => {
    await db.createCredential({
      id: 'cred_ashby',
      label: 'Ashby',
      scheme: 'bearer',
      envName: 'ASHBY_API_KEY',
      keychainAccount: 'cred_ashby',
      tags: [],
      hasSecret: true,
    });

    await manager.create({
      title: 'Hiring inbox',
      body: 'Use Ashby',
      dependsOnCredentialIds: ['cred_ashby'],
    });

    const dependents = await manager.getDependentsForCredential('cred_ashby');
    expect(dependents).toHaveLength(1);
    expect(dependents[0].title).toBe('Hiring inbox');
  });

  it('auto-detects dependencies when creating via agent flow', async () => {
    await db.createCredential({
      id: 'cred_ashby',
      label: 'Ashby',
      scheme: 'bearer',
      envName: 'ASHBY_API_KEY',
      keychainAccount: 'cred_ashby',
      tags: [],
      hasSecret: true,
    });

    const playbook = await manager.createWithDependencies({
      title: 'Hiring inbox',
      body: 'Run with cred_ashby via agent-deck exec --connections cred_ashby -- …',
      addToBoundDeck: true,
      autoDetectDependencies: true,
    });

    expect(playbook.dependsOnCredentialIds).toEqual(['cred_ashby']);
    expect(playbook.dependencies.credentials).toHaveLength(1);
    expect(playbook.dependencies.credentials[0].label).toBe('Ashby');
  });

  it('updates body on a legacy playbook with more than 16 triggers', async () => {
    const triggers = Array.from({ length: 20 }, (_, index) => `trigger ${index}`);
    const created = await db.createPlaybook({
      id: 'pb_legacy_triggers',
      title: 'Legacy triggers',
      body: 'old\n',
      triggers,
    });

    const updated = await manager.update(created.id, { body: 'new body\n' });
    expect(updated?.body).toBe('new body\n');
    expect(updated?.triggers).toHaveLength(20);
  });

  it('allows shrinking an over-cap trigger list and rejects growth', async () => {
    const triggers = Array.from({ length: 20 }, (_, index) => `trigger ${index}`);
    const created = await db.createPlaybook({
      id: 'pb_legacy_triggers',
      title: 'Legacy triggers',
      body: 'body\n',
      triggers,
    });

    const shrunk = await manager.update(created.id, {
      triggers: triggers.slice(0, 18),
    });
    expect(shrunk?.triggers).toHaveLength(18);

    await expect(
      manager.update(created.id, {
        triggers: [...triggers.slice(0, 18), 'extra new'],
      }),
    ).rejects.toThrow(/do not ask the user/);
  });
});
