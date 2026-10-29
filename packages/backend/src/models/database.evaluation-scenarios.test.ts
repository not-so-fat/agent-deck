import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from './database';

describe('DatabaseManager evaluation scenarios', () => {
  const databases: DatabaseManager[] = [];
  const paths: string[] = [];

  afterEach(() => {
    while (databases.length > 0) databases.pop()?.close();
    while (paths.length > 0) fs.rmSync(paths.pop()!, { force: true });
  });

  function createDatabase(): DatabaseManager {
    const dbPath = path.join(os.tmpdir(), `agent-deck-scenarios-${Date.now()}-${Math.random()}.db`);
    paths.push(dbPath);
    const db = new DatabaseManager(dbPath);
    databases.push(db);
    return db;
  }

  async function createPlaybook(db: DatabaseManager, id: string) {
    return db.createPlaybook({
      id,
      title: id,
      body: '',
      triggers: [],
      dependsOnCredentialIds: [],
      dependsOnServiceIds: [],
    });
  }

  async function createSignal(db: DatabaseManager, id: string, playbookId: string) {
    return db.createFeedbackSignal({
      id,
      source: 'ide',
      sourceRef: 'mcp-session:historical',
      failureSummary: 'The response missed a blocking issue.',
      userFeedbackExcerpt: 'Call out the blocking issue.',
      correctedOutputHint: 'Lead with the issue.',
      candidatePlaybookId: playbookId,
      candidateDeckId: null,
      linkedPatchId: null,
      status: 'open',
    });
  }

  it('persists a draft from feedback signals and filters the ready transition by playbook', async () => {
    const db = createDatabase();
    await createPlaybook(db, 'pb_review_pr');
    await createPlaybook(db, 'pb_other');
    await createSignal(db, 'fs_first', 'pb_review_pr');
    await createSignal(db, 'fs_second', 'pb_review_pr');

    const draft = await db.createEvaluationScenario({
      id: 'es_review_pr',
      targetPlaybookId: 'pb_review_pr',
      name: 'Preserve blocking findings',
      description: 'The reviewer must surface blocking findings.',
      taskInput: 'Review this pull request.',
      historicalFailedOutput: null,
      expectations: [{ id: 'mentions-blocker', type: 'contains', value: 'blocking' }],
      sourceSignalIds: ['fs_first', 'fs_second'],
      status: 'draft',
    });

    expect(await db.getEvaluationScenario(draft.id)).toEqual(draft);
    await expect(
      db.updateEvaluationScenario(draft.id, { status: 'ready' }),
    ).rejects.toThrow('historical failed output');

    const ready = await db.updateEvaluationScenario(draft.id, {
      historicalFailedOutput: 'No concerns. Looks good.',
      status: 'ready',
    });
    expect(ready).toMatchObject({
      id: draft.id,
      status: 'ready',
      sourceSignalIds: ['fs_first', 'fs_second'],
    });

    await db.createEvaluationScenario({
      id: 'es_other_draft',
      targetPlaybookId: 'pb_other',
      name: 'Other draft',
      description: '',
      taskInput: '',
      historicalFailedOutput: null,
      expectations: [],
      sourceSignalIds: [],
      status: 'draft',
    });

    expect(
      await db.listEvaluationScenarios({
        targetPlaybookId: 'pb_review_pr',
        status: 'ready',
      }),
    ).toEqual([ready]);
    expect(await db.listEvaluationScenarios({ status: 'draft' })).toHaveLength(1);
  });

  it('rejects missing playbook and feedback signal references', async () => {
    const db = createDatabase();
    await createPlaybook(db, 'pb_review_pr');

    await expect(
      db.createEvaluationScenario({
        id: 'es_missing_playbook',
        targetPlaybookId: 'pb_missing',
        name: 'Missing playbook',
        description: '',
        taskInput: '',
        historicalFailedOutput: null,
        expectations: [],
        sourceSignalIds: [],
        status: 'draft',
      }),
    ).rejects.toThrow('Referenced playbook not found');

    await expect(
      db.createEvaluationScenario({
        id: 'es_missing_signal',
        targetPlaybookId: 'pb_review_pr',
        name: 'Missing signal',
        description: '',
        taskInput: '',
        historicalFailedOutput: null,
        expectations: [],
        sourceSignalIds: ['fs_missing'],
        status: 'draft',
      }),
    ).rejects.toThrow('Referenced feedback signal not found');
  });

  it('adds the table on startup without changing existing rows', async () => {
    const db = createDatabase();
    await createPlaybook(db, 'pb_existing');
    const dbPath = paths[paths.length - 1];
    db.close();
    databases.pop();

    const reopened = new DatabaseManager(dbPath);
    databases.push(reopened);

    expect(await reopened.getPlaybook('pb_existing')).toMatchObject({ id: 'pb_existing' });
    expect(
      reopened
        .getSqliteDatabase()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'evaluation_scenarios'")
        .get(),
    ).toEqual({ name: 'evaluation_scenarios' });
  });
});
