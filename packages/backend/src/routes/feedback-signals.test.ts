import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_DECK_CLIENT_HEADER,
  AGENT_DECK_DASHBOARD_CLIENT,
  AGENT_DECK_AGENT_CLIENT,
  generateShortId,
} from '@agent-deck/shared';
import { DatabaseManager } from '../models/database';
import { PlaybookManager } from '../playbooks/playbook-manager';
import { PatchManager } from '../playbooks/patch-manager';
import { registerFeedbackSignalRoutes } from './feedback-signals';
import { dashboardAuthHeaders } from '../test/auth-fixtures';

const dashboardHeaders = dashboardAuthHeaders();
const agentHeaders = {
  [AGENT_DECK_CLIENT_HEADER]: AGENT_DECK_AGENT_CLIENT,
};

describe('feedback-signals routes (dashboard)', () => {
  let dbPath: string;
  let db: DatabaseManager;
  let playbookManager: PlaybookManager;
  let patchManager: PatchManager;
  let app: ReturnType<typeof Fastify>;
  let playbookId: string;
  let deckId: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `agent-deck-feedback-${Date.now()}.db`);
    db = new DatabaseManager(dbPath);
    playbookManager = new PlaybookManager(db);
    patchManager = new PatchManager(db, playbookManager);

    const deck = await db.createDeck({ name: `deck-${Date.now()}`, isActive: false });
    deckId = deck.id;
    const playbook = await playbookManager.create({
      title: 'PR summary',
      body: '## Gotchas\n- Keep it short.\n',
      triggers: ['summarize PR'],
    });
    playbookId = playbook.id;
    await playbookManager.addToDeck({ deckId, playbookId });

    app = Fastify();
    app.decorate('db', db);
    app.decorate('playbookManager', playbookManager);
    app.decorate('patchManager', patchManager);
    await app.register(registerFeedbackSignalRoutes, { prefix: '/api/feedback-signals' });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('lists and counts open signals for dashboard only', async () => {
    await db.createFeedbackSignal({
      id: `fs_${generateShortId()}`,
      source: 'ide',
      sourceRef: null,
      failureSummary: 'x',
      userFeedbackExcerpt: 'y',
      correctedOutputHint: null,
      candidatePlaybookId: playbookId,
      candidateDeckId: deckId,
      linkedPatchId: null,
      status: 'open',
    });

    const denied = await app.inject({
      method: 'GET',
      url: '/api/feedback-signals?status=open',
      headers: agentHeaders,
    });
    expect(denied.statusCode).toBe(403);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/feedback-signals?status=open',
      headers: dashboardHeaders,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data).toHaveLength(1);

    const counted = await app.inject({
      method: 'GET',
      url: '/api/feedback-signals/count',
      headers: dashboardHeaders,
    });
    expect(counted.statusCode).toBe(200);
    expect(counted.json().data.open).toBe(1);
  });

  it('excludes in-proposal rows from available count and list filter', async () => {
    const parked = await db.createFeedbackSignal({
      id: `fs_${generateShortId()}`,
      source: 'ide',
      sourceRef: null,
      failureSummary: 'parked',
      userFeedbackExcerpt: 'in flight',
      correctedOutputHint: null,
      candidatePlaybookId: playbookId,
      candidateDeckId: deckId,
      linkedPatchId: null,
      status: 'open',
    });
    const free = await db.createFeedbackSignal({
      id: `fs_${generateShortId()}`,
      source: 'ide',
      sourceRef: null,
      failureSummary: 'free',
      userFeedbackExcerpt: 'available',
      correctedOutputHint: null,
      candidatePlaybookId: playbookId,
      candidateDeckId: deckId,
      linkedPatchId: null,
      status: 'open',
    });

    const proposed = await patchManager.propose(
      {
        kind: 'update',
        playbook_id: playbookId,
        ops: [{ op: 'add_item', section: 'Gotchas', text: 'Parked lesson.' }],
        rationale: 'link one',
        signal_ids: [parked.id],
      },
      'ide',
      null,
    );
    expect(proposed.kind).toBe('update');

    const counted = await app.inject({
      method: 'GET',
      url: '/api/feedback-signals/count',
      headers: dashboardHeaders,
    });
    expect(counted.json().data.open).toBe(1);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/feedback-signals?status=open&excludeInProposal=true',
      headers: dashboardHeaders,
    });
    const ids = (listed.json().data as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(free.id);
    expect(ids).not.toContain(parked.id);
  });

  it('imports backfill signals with partial success', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/feedback-signals/import',
      headers: dashboardHeaders,
      payload: {
        signals: [
          {
            failureSummary: 'from transcript',
            userFeedbackExcerpt: 'fix that',
            candidatePlaybookId: playbookId,
            candidateDeckId: deckId,
          },
          {
            failureSummary: '',
            userFeedbackExcerpt: 'bad',
          },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    const data = response.json().data;
    expect(data.inserted).toBe(1);
    expect(data.errors).toHaveLength(1);
  });

  it('discards open signals from dashboard', async () => {
    const s1 = await db.createFeedbackSignal({
      id: `fs_${generateShortId()}`,
      source: 'ide',
      sourceRef: null,
      failureSummary: 'noise',
      userFeedbackExcerpt: 'ignore',
      correctedOutputHint: null,
      candidatePlaybookId: playbookId,
      candidateDeckId: deckId,
      linkedPatchId: null,
      status: 'open',
    });

    const denied = await app.inject({
      method: 'POST',
      url: '/api/feedback-signals/discard',
      headers: agentHeaders,
      payload: { signalIds: [s1.id] },
    });
    expect(denied.statusCode).toBe(403);

    const response = await app.inject({
      method: 'POST',
      url: '/api/feedback-signals/discard',
      headers: dashboardHeaders,
      payload: { signalIds: [s1.id] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.discarded).toBe(1);
    expect((await db.getFeedbackSignal(s1.id))?.status).toBe('discarded');
  });
});

describe('propose with signal_ids', () => {
  let dbPath: string;
  let db: DatabaseManager;
  let playbookManager: PlaybookManager;
  let patchManager: PatchManager;
  let playbookId: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `agent-deck-signal-ids-${Date.now()}.db`);
    db = new DatabaseManager(dbPath);
    playbookManager = new PlaybookManager(db);
    patchManager = new PatchManager(db, playbookManager);
    const playbook = await playbookManager.create({
      title: 'Test',
      body: '## Gotchas\n- Keep it short.\n',
      triggers: [],
    });
    playbookId = playbook.id;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('links curated signal_ids without marking actioned until accept', async () => {
    const s1 = await db.createFeedbackSignal({
      id: `fs_${generateShortId()}`,
      source: 'ide',
      sourceRef: null,
      failureSummary: 'A',
      userFeedbackExcerpt: 'add A',
      correctedOutputHint: null,
      candidatePlaybookId: playbookId,
      candidateDeckId: null,
      linkedPatchId: null,
      status: 'open',
    });
    const s2 = await db.createFeedbackSignal({
      id: `fs_${generateShortId()}`,
      source: 'ide',
      sourceRef: null,
      failureSummary: 'B',
      userFeedbackExcerpt: 'add B',
      correctedOutputHint: null,
      candidatePlaybookId: playbookId,
      candidateDeckId: null,
      linkedPatchId: null,
      status: 'open',
    });

    const beforeCount = (await db.listFeedbackSignals()).length;

    const result = await patchManager.propose(
      {
        kind: 'update',
        playbook_id: playbookId,
        ops: [{ op: 'add_item', section: 'Gotchas', text: 'Cover A and B.' }],
        rationale: 'Consolidated from backlog',
        evidence: {
          failure_summary: 'Related gotchas',
          user_feedback_excerpt: 'add A',
        },
        signal_ids: [s1.id, s2.id, 'fs_unknown'],
      },
      'ide',
      null,
    );

    expect(result.kind).toBe('update');
    if (result.kind === 'signal_only') throw new Error('expected patch');
    expect(result.signal).toBeNull();
    expect((await db.listFeedbackSignals()).length).toBe(beforeCount);
    expect((await db.getFeedbackSignal(s1.id))?.status).toBe('open');
    expect((await db.getFeedbackSignal(s1.id))?.linkedPatchId).toBe(result.patch.id);
    expect((await db.getFeedbackSignal(s2.id))?.linkedPatchId).toBe(result.patch.id);

    await patchManager.accept(result.patch.id);
    expect((await db.getFeedbackSignal(s1.id))?.status).toBe('actioned');
    expect((await db.getFeedbackSignal(s2.id))?.status).toBe('actioned');
  });
});
