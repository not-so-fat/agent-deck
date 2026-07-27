import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../models/database';
import { PlaybookManager } from '../playbooks/playbook-manager';
import { storePaths } from './paths';
import { FileStoreWriter } from './writer';

describe('mutation dual-write', () => {
  let home: string;
  let db: DatabaseManager;
  let manager: PlaybookManager;
  let playbookPath: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-deck-dual-write-'));
    db = new DatabaseManager(path.join(home, 'agent-deck.db'));
    const writer = new FileStoreWriter(home);
    await writer.ensureLayout();
    manager = new PlaybookManager(db, writer);
    playbookPath = path.join(storePaths(home).playbooksDir, 'pb_release_checklist.md');
  });

  afterEach(async () => {
    db.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  it('creates, updates, and deletes the playbook file', async () => {
    const playbook = await manager.create({
      title: 'Release checklist',
      body: 'Original body',
    });

    expect(playbook.id).toBe('pb_release_checklist');
    expect(await fs.readFile(playbookPath, 'utf8')).toContain('Original body');

    await manager.update(playbook.id, { body: 'Updated body' });
    expect(await fs.readFile(playbookPath, 'utf8')).toContain('Updated body');

    await manager.delete(playbook.id);
    await expect(fs.access(playbookPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
