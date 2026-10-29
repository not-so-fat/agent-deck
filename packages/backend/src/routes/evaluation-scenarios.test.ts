import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EvaluationScenarioSchema } from '@agent-deck/shared';
import { DatabaseManager } from '../models/database';
import { dashboardAuthHeaders } from '../test/auth-fixtures';
import { TrustedSessionStore } from '../trusted-session/store';
import { registerEvaluationScenarioRoutes } from './evaluation-scenarios';

describe('evaluation scenario routes', () => {
  let dbPath: string;
  let db: DatabaseManager;
  let app: ReturnType<typeof Fastify>;
  let headers: Record<string, string>;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `agent-deck-scenario-routes-${Date.now()}-${Math.random()}.db`);
    db = new DatabaseManager(dbPath);
    await db.createPlaybook({
      id: 'pb_review_pr',
      title: 'Review a PR',
      body: '',
      triggers: [],
      dependsOnCredentialIds: [],
      dependsOnServiceIds: [],
    });
    for (const id of ['fs_first', 'fs_second']) {
      await db.createFeedbackSignal({
        id,
        source: 'ide',
        sourceRef: `mcp-session:${id}`,
        failureSummary: 'Missed a blocking issue.',
        userFeedbackExcerpt: 'Identify the blocker.',
        correctedOutputHint: null,
        candidatePlaybookId: 'pb_review_pr',
        candidateDeckId: null,
        linkedPatchId: null,
        status: 'open',
      });
    }

    app = Fastify();
    app.decorate('db', db);
    const sessions = new TrustedSessionStore(db.getSqliteDatabase());
    app.decorate('trustedSessionStore', sessions);
    headers = dashboardAuthHeaders(sessions);
    await app.register(registerEvaluationScenarioRoutes, {
      prefix: '/api/evaluation-scenarios',
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    fs.rmSync(dbPath, { force: true });
  });

  const readyPayload = {
    id: 'es_ready_checks',
    targetPlaybookId: 'pb_review_pr',
    name: 'Ready checks',
    taskInput: 'Review this pull request.',
    historicalFailedOutput: 'Looks good.',
    expectations: [{ id: 'mentions-blocker', type: 'contains', value: 'blocking' }],
    sourceSignalIds: ['fs_first'],
    status: 'ready',
  } as const;

  it.each([
    ['task input', { taskInput: '' }],
    ['historical failed output', { historicalFailedOutput: null }],
    ['source signal', { sourceSignalIds: [] }],
    ['deterministic expectation', { expectations: [] }],
  ])('rejects ready creation without %s', async (_label, override) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/evaluation-scenarios',
      headers,
      payload: { ...readyPayload, ...override },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false });
  });

  it('creates a two-signal draft, requires failed output, then lists it ready by playbook', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/evaluation-scenarios',
      headers,
      payload: {
        id: 'es_feedback_case',
        targetPlaybookId: 'pb_review_pr',
        name: 'Feedback-derived blocker case',
        taskInput: 'Review this pull request.',
        historicalFailedOutput: null,
        expectations: [{ id: 'mentions-blocker', type: 'contains', value: 'blocking' }],
        sourceSignalIds: ['fs_first', 'fs_second'],
        status: 'draft',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(EvaluationScenarioSchema.parse(created.json().data)).toMatchObject({
      id: 'es_feedback_case',
      status: 'draft',
    });

    const rejected = await app.inject({
      method: 'PUT',
      url: '/api/evaluation-scenarios/es_feedback_case',
      headers,
      payload: { status: 'ready' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toContain('historical failed output');

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/evaluation-scenarios/es_feedback_case',
      headers,
      payload: {
        historicalFailedOutput: 'No blocking issues found.',
        status: 'ready',
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(EvaluationScenarioSchema.parse(updated.json().data).status).toBe('ready');

    const listed = await app.inject({
      method: 'GET',
      url: '/api/evaluation-scenarios?targetPlaybookId=pb_review_pr&status=ready',
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data).toHaveLength(1);
    expect(listed.json().data[0].id).toBe('es_feedback_case');

    const fetched = await app.inject({
      method: 'GET',
      url: '/api/evaluation-scenarios/es_feedback_case',
      headers,
    });
    expect(fetched.statusCode).toBe(200);
    expect(EvaluationScenarioSchema.parse(fetched.json().data).sourceSignalIds).toEqual([
      'fs_first',
      'fs_second',
    ]);
  });

  it('validates references and returns not-found responses', async () => {
    const missingPlaybook = await app.inject({
      method: 'POST',
      url: '/api/evaluation-scenarios',
      headers,
      payload: {
        targetPlaybookId: 'pb_missing',
        name: 'Missing playbook',
      },
    });
    expect(missingPlaybook.statusCode).toBe(400);
    expect(missingPlaybook.json().error).toContain('Referenced playbook not found');

    const missingSignal = await app.inject({
      method: 'POST',
      url: '/api/evaluation-scenarios',
      headers,
      payload: {
        targetPlaybookId: 'pb_review_pr',
        name: 'Missing signal',
        sourceSignalIds: ['fs_missing'],
      },
    });
    expect(missingSignal.statusCode).toBe(400);
    expect(missingSignal.json().error).toContain('Referenced feedback signal not found');

    for (const method of ['GET', 'PUT'] as const) {
      const response = await app.inject({
        method,
        url: '/api/evaluation-scenarios/es_missing',
        headers,
        ...(method === 'PUT' ? { payload: { name: 'Still missing' } } : {}),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        success: false,
        error: 'Evaluation scenario not found',
      });
    }
  });
});
