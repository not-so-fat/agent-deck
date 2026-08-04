import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../models/database';
import { PlaybookManager } from './playbook-manager';
import { PatchManager, PatchConflictError, PatchNoChangeError } from './patch-manager';

describe('PatchManager', () => {
  let dbPath: string;
  let db: DatabaseManager;
  let playbookManager: PlaybookManager;
  let patchManager: PatchManager;
  let deckId: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `agent-deck-patches-${Date.now()}.db`);
    db = new DatabaseManager(dbPath);
    playbookManager = new PlaybookManager(db);
    patchManager = new PatchManager(db, playbookManager);
    const deck = await db.createDeck({ name: `dev-${Date.now()}`, isActive: false });
    deckId = deck.id;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('proposes, previews, accepts an update patch', async () => {
    const playbook = await playbookManager.create({
      title: 'Hiring inbox',
      body: '## Gotchas\n- Old gotcha.\n',
      triggers: ['check inbox'],
    });
    await playbookManager.addToDeck({ deckId, playbookId: playbook.id });

    const result = await patchManager.propose(
      {
        kind: 'update',
        playbook_id: playbook.id,
        ops: [{ op: 'add_item', section: 'Gotchas', text: 'New gotcha.' }],
        rationale: 'User corrected output.',
        evidence: {
          failure_summary: 'Missed dry-run',
          user_feedback_excerpt: 'always dry-run first',
        },
      },
      'ide',
      'session-1',
    );
    expect(result.kind).toBe('update');
    if (result.kind === 'signal_only') throw new Error('expected patch');
    const patch = result.patch;

    const preview = await patchManager.preview(patch.id);
    expect(preview?.after.body).toContain('New gotcha.');

    const accepted = await patchManager.accept(patch.id);
    expect(accepted.status).toBe('accepted');

    const updated = await db.getPlaybook(playbook.id);
    expect(updated?.body).toContain('New gotcha.');

    const versions = await db.listPlaybookVersions(playbook.id);
    expect(versions).toHaveLength(1);
  });

  it('proposes and accepts genesis create patch', async () => {
    const result = await patchManager.propose(
      {
        kind: 'create',
        new_playbook: {
          title: 'Slip risk',
          body: '## Gotchas\n- Check velocity vs capacity.\n',
          triggers: ['slip risk', 'sprint risk'],
          deck_id: deckId,
        },
        rationale: 'New task uncovered by correction.',
      },
      'ide',
      null,
    );
    expect(result.kind).toBe('create');
    if (result.kind === 'signal_only') throw new Error('expected patch');
    const patch = result.patch;

    const accepted = await patchManager.accept(patch.id);
    expect(accepted.status).toBe('accepted');

    const onDeck = await playbookManager.listForDeck(deckId);
    expect(onDeck).toHaveLength(1);
    expect(onDeck[0].triggers).toContain('slip risk');
  });

  it('rejects propose when anchor does not resolve', async () => {
    const playbook = await playbookManager.create({
      title: 'Test',
      body: '## Steps\n- Step one.\n',
      triggers: [],
    });

    await expect(
      patchManager.propose(
        {
          kind: 'update',
          playbook_id: playbook.id,
          ops: [
            {
              op: 'amend_item',
              section: 'Steps',
              anchor: '- Missing anchor.',
              text: '- Nope.',
            },
          ],
          rationale: 'test',
        },
        'ide',
        null,
      ),
    ).rejects.toBeInstanceOf(PatchConflictError);
  });

  it('rejects propose when ops produce no change', async () => {
    const playbook = await playbookManager.create({
      title: 'Test',
      body: '## Steps\n- Step one.\n',
      triggers: ['ship'],
    });

    await expect(
      patchManager.propose(
        {
          kind: 'update',
          playbook_id: playbook.id,
          ops: [{ op: 'set_triggers', triggers: ['ship'] }],
          rationale: 'test',
        },
        'ide',
        null,
      ),
    ).rejects.toBeInstanceOf(PatchNoChangeError);
  });

  it('marks patch stale on anchor conflict at accept and reopens linked signals', async () => {
    const playbook = await playbookManager.create({
      title: 'Test',
      body: '## Steps\n- Step one.\n',
      triggers: [],
    });

    // Bypass propose-time validation by inserting patch directly (simulates legacy proposals).
    const patch = await db.createPlaybookPatch({
      id: `pp_${Date.now()}`,
      kind: 'update',
      playbookId: playbook.id,
      opsJson: JSON.stringify([
        {
          op: 'amend_item',
          section: 'Steps',
          anchor: '- Missing anchor.',
          text: '- Nope.',
        },
      ]),
      rationale: 'test',
      source: 'ide',
      sourceRef: null,
      evidenceJson: null,
    });

    const signal = await db.createFeedbackSignal({
      id: `fs_stale_${Date.now()}`,
      source: 'ide',
      sourceRef: null,
      failureSummary: 'linked',
      userFeedbackExcerpt: 'linked',
      correctedOutputHint: null,
      candidatePlaybookId: playbook.id,
      candidateDeckId: null,
      linkedPatchId: patch.id,
      status: 'open',
    });

    await expect(patchManager.accept(patch.id)).rejects.toBeInstanceOf(PatchConflictError);
    const stale = await db.getPlaybookPatch(patch.id);
    expect(stale?.status).toBe('stale');
    const reopened = await db.getFeedbackSignal(signal.id);
    expect(reopened?.status).toBe('open');
    expect(reopened?.linkedPatchId).toBeNull();
  });

  it('rejects a proposed patch with reason', async () => {
    const playbook = await playbookManager.create({
      title: 'Test',
      body: 'Body',
      triggers: [],
    });
    const result = await patchManager.propose(
      {
        kind: 'update',
        playbook_id: playbook.id,
        ops: [{ op: 'rewrite_body', text: 'Nope' }],
        rationale: 'test',
      },
      'ide',
      null,
    );
    if (result.kind === 'signal_only') throw new Error('expected patch');
    const patch = result.patch;

    const rejected = await patchManager.reject(patch.id, 'Too broad');
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.rejectionReason).toBe('Too broad');

    const signals = await db.listFeedbackSignals({ status: 'open' });
    expect(signals.some((s) => s.userFeedbackExcerpt === 'test' || s.failureSummary === 'test')).toBe(
      true,
    );
    const linked = signals.find((s) => s.failureSummary === 'test' || s.userFeedbackExcerpt === 'test');
    expect(linked?.linkedPatchId).toBeNull();
  });

  it('rejects a proposed patch without a reason', async () => {
    const playbook = await playbookManager.create({
      title: 'Test',
      body: '## Gotchas\n- Keep it short.\n',
      triggers: [],
    });
    const result = await patchManager.propose(
      {
        kind: 'update',
        playbook_id: playbook.id,
        ops: [{ op: 'add_item', section: 'Gotchas', text: 'Noisy lesson.' }],
        rationale: 'low quality',
      },
      'ide',
      null,
    );
    if (result.kind === 'signal_only') throw new Error('expected patch');

    const rejected = await patchManager.reject(result.patch.id);
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.rejectionReason).toBeNull();
  });

  it('signal_only logs open signal without a patch row', async () => {
    const playbook = await playbookManager.create({
      title: 'Test',
      body: '## Gotchas\n- Keep it short.\n',
      triggers: ['x'],
    });

    const result = await patchManager.propose(
      {
        kind: 'signal_only',
        playbook_id: playbook.id,
        rationale: 'Edge case — not ready to generalize',
        evidence: {
          failure_summary: 'One-off formatting quirk',
          user_feedback_excerpt: 'just note this for later',
        },
      },
      'ide',
      'session-2',
      deckId,
    );

    expect(result.kind).toBe('signal_only');
    if (result.kind !== 'signal_only') throw new Error('expected signal_only');
    expect(result.signal.status).toBe('open');
    expect(result.signal.linkedPatchId).toBeNull();
    expect(result.signal.candidatePlaybookId).toBe(playbook.id);
    expect(await db.listPlaybookPatches()).toHaveLength(0);
  });

  it('immediate propose writes open signal linked to the patch; accept marks actioned', async () => {
    const playbook = await playbookManager.create({
      title: 'Test',
      body: '## Gotchas\n- Keep it short.\n',
      triggers: [],
    });

    const result = await patchManager.propose(
      {
        kind: 'update',
        playbook_id: playbook.id,
        ops: [{ op: 'add_item', section: 'Gotchas', text: 'Always cite sources.' }],
        rationale: 'User correction',
        evidence: {
          failure_summary: 'Missed citation',
          user_feedback_excerpt: 'cite the source',
        },
      },
      'ide',
      null,
    );
    if (result.kind === 'signal_only') throw new Error('expected patch');
    expect(result.signal?.status).toBe('open');
    expect(result.signal?.linkedPatchId).toBe(result.patch.id);
    expect(result.signal?.failureSummary).toBe('Missed citation');

    await patchManager.accept(result.patch.id);
    expect((await db.getFeedbackSignal(result.signal!.id))?.status).toBe('actioned');
  });

  it('does not let a second curation submit steal a signal already parked in an open proposal', async () => {
    const playbook = await playbookManager.create({
      title: 'Test',
      body: '## Gotchas\n- Keep it short.\n',
      triggers: [],
    });
    const signal = await db.createFeedbackSignal({
      id: `fs_park_${Date.now()}`,
      source: 'ide',
      sourceRef: null,
      failureSummary: 'shared lesson',
      userFeedbackExcerpt: 'shared lesson',
      correctedOutputHint: null,
      candidatePlaybookId: playbook.id,
      candidateDeckId: null,
      linkedPatchId: null,
      status: 'open',
    });

    const first = await patchManager.propose(
      {
        kind: 'update',
        playbook_id: playbook.id,
        ops: [{ op: 'add_item', section: 'Gotchas', text: 'First take.' }],
        rationale: 'First curation pass',
        signal_ids: [signal.id],
      },
      'ide',
      null,
    );
    if (first.kind === 'signal_only') throw new Error('expected patch');
    expect((await db.getFeedbackSignal(signal.id))?.linkedPatchId).toBe(first.patch.id);

    // A second, unrelated curation submit tries to consume the same still-parked signal.
    const second = await patchManager.propose(
      {
        kind: 'update',
        playbook_id: playbook.id,
        ops: [{ op: 'add_item', section: 'Gotchas', text: 'Second take.' }],
        rationale: 'Second curation pass',
        signal_ids: [signal.id],
      },
      'ide',
      null,
    );
    if (second.kind === 'signal_only') throw new Error('expected patch');

    // Second patch is still created (unknown/non-linkable ids don't fail the propose),
    // but the signal stays parked under the first proposal — not stolen.
    const stillParked = await db.getFeedbackSignal(signal.id);
    expect(stillParked?.linkedPatchId).toBe(first.patch.id);
    expect(stillParked?.status).toBe('open');

    // Once the first proposal is rejected, the signal is free again for a future curation pass.
    await patchManager.reject(first.patch.id, 'superseded');
    const freed = await db.getFeedbackSignal(signal.id);
    expect(freed?.linkedPatchId).toBeNull();
    expect(freed?.status).toBe('open');
  });

  it('supersedes an open patch and re-links its signals to the successor', async () => {
    const playbook = await playbookManager.create({
      title: 'Test',
      body: '## Gotchas\n- Keep it short.\n',
      triggers: [],
    });

    const first = await patchManager.propose(
      {
        kind: 'update',
        playbook_id: playbook.id,
        ops: [{ op: 'add_item', section: 'Gotchas', text: 'Weak lesson.' }],
        rationale: 'First take',
        evidence: {
          failure_summary: 'Wrong generalization',
          user_feedback_excerpt: 'that does not make sense',
        },
      },
      'ide',
      null,
    );
    if (first.kind === 'signal_only') throw new Error('expected patch');
    const firstSignalId = first.signal!.id;

    const second = await patchManager.propose(
      {
        kind: 'update',
        playbook_id: playbook.id,
        ops: [{ op: 'add_item', section: 'Gotchas', text: 'Better lesson.' }],
        rationale: 'Revised take',
        evidence: {
          failure_summary: 'Wrong generalization',
          user_feedback_excerpt: 'change it to this instead',
        },
        supersedes: [first.patch.id],
      },
      'ide',
      null,
    );
    if (second.kind === 'signal_only') throw new Error('expected patch');

    expect(second.superseded).toEqual([first.patch.id]);
    const old = await db.getPlaybookPatch(first.patch.id);
    expect(old?.status).toBe('superseded');
    expect(old?.supersededBy).toBe(second.patch.id);

    const proposed = await db.listPlaybookPatches('proposed');
    expect(proposed.map((p) => p.id)).toEqual([second.patch.id]);

    const moved = await db.getFeedbackSignal(firstSignalId);
    expect(moved?.status).toBe('open');
    expect(moved?.linkedPatchId).toBe(second.patch.id);

    await patchManager.accept(second.patch.id);
    expect((await db.getFeedbackSignal(firstSignalId))?.status).toBe('actioned');
  });

  it('leaves independent open patches when supersedes is omitted', async () => {
    const playbook = await playbookManager.create({
      title: 'Test',
      body: '## Gotchas\n- Keep it short.\n',
      triggers: [],
    });

    const first = await patchManager.propose(
      {
        kind: 'update',
        playbook_id: playbook.id,
        ops: [{ op: 'add_item', section: 'Gotchas', text: 'Lesson A.' }],
        rationale: 'Problem A',
        evidence: {
          failure_summary: 'A',
          user_feedback_excerpt: 'fix A',
        },
      },
      'ide',
      null,
    );
    if (first.kind === 'signal_only') throw new Error('expected patch');

    const second = await patchManager.propose(
      {
        kind: 'update',
        playbook_id: playbook.id,
        ops: [{ op: 'add_item', section: 'Gotchas', text: 'Lesson B.' }],
        rationale: 'Problem B',
        evidence: {
          failure_summary: 'B',
          user_feedback_excerpt: 'fix B',
        },
      },
      'ide',
      null,
    );
    if (second.kind === 'signal_only') throw new Error('expected patch');

    expect(second.superseded).toEqual([]);
    const proposed = await db.listPlaybookPatches('proposed');
    expect(proposed.map((p) => p.id).sort()).toEqual(
      [first.patch.id, second.patch.id].sort(),
    );
  });

  it('rejects supersedes that are not proposed or for another playbook', async () => {
    const playbook = await playbookManager.create({
      title: 'Test',
      body: '## Gotchas\n- Keep it short.\n',
      triggers: [],
    });
    const other = await playbookManager.create({
      title: 'Other',
      body: '## Gotchas\n- Other.\n',
      triggers: [],
    });

    const first = await patchManager.propose(
      {
        kind: 'update',
        playbook_id: playbook.id,
        ops: [{ op: 'add_item', section: 'Gotchas', text: 'Lesson.' }],
        rationale: 'First',
      },
      'ide',
      null,
    );
    if (first.kind === 'signal_only') throw new Error('expected patch');
    await patchManager.reject(first.patch.id, 'nope');

    await expect(
      patchManager.propose(
        {
          kind: 'update',
          playbook_id: playbook.id,
          ops: [{ op: 'add_item', section: 'Gotchas', text: 'Retry.' }],
          rationale: 'Retry',
          supersedes: [first.patch.id],
        },
        'ide',
        null,
      ),
    ).rejects.toThrow(/not proposed/);

    const otherOpen = await patchManager.propose(
      {
        kind: 'update',
        playbook_id: other.id,
        ops: [{ op: 'add_item', section: 'Gotchas', text: 'Other lesson.' }],
        rationale: 'Other',
      },
      'ide',
      null,
    );
    if (otherOpen.kind === 'signal_only') throw new Error('expected patch');

    await expect(
      patchManager.propose(
        {
          kind: 'update',
          playbook_id: playbook.id,
          ops: [{ op: 'add_item', section: 'Gotchas', text: 'Cross.' }],
          rationale: 'Cross',
          supersedes: [otherOpen.patch.id],
        },
        'ide',
        null,
      ),
    ).rejects.toThrow(/same playbook/);
  });

  it('lists compact open patch summaries for a playbook', async () => {
    const playbook = await playbookManager.create({
      title: 'Test',
      body: '## Gotchas\n- Keep it short.\n',
      triggers: [],
    });

    const proposed = await patchManager.propose(
      {
        kind: 'update',
        playbook_id: playbook.id,
        ops: [{ op: 'add_item', section: 'Gotchas', text: 'Cite sources.' }],
        rationale: 'Citation rule',
        evidence: {
          failure_summary: 'Missed citation',
          user_feedback_excerpt: 'cite the source',
        },
      },
      'ide',
      null,
    );
    if (proposed.kind === 'signal_only') throw new Error('expected patch');

    const summaries = await patchManager.listOpenPatchSummaries(playbook.id);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: proposed.patch.id,
      kind: 'update',
      rationale: 'Citation rule',
      failureSummary: 'Missed citation',
      userFeedbackExcerpt: 'cite the source',
    });
  });

  it('human reject still unlinks signals (supersede path does not)', async () => {
    const playbook = await playbookManager.create({
      title: 'Test',
      body: '## Gotchas\n- Keep it short.\n',
      triggers: [],
    });

    const result = await patchManager.propose(
      {
        kind: 'update',
        playbook_id: playbook.id,
        ops: [{ op: 'add_item', section: 'Gotchas', text: 'Lesson.' }],
        rationale: 'Take',
        evidence: {
          failure_summary: 'x',
          user_feedback_excerpt: 'y',
        },
      },
      'ide',
      null,
    );
    if (result.kind === 'signal_only') throw new Error('expected patch');

    await patchManager.reject(result.patch.id, 'not useful');
    const signal = await db.getFeedbackSignal(result.signal!.id);
    expect(signal?.linkedPatchId).toBeNull();
    expect(signal?.status).toBe('open');
  });

  it('does not mutate immutable signal fields on status update', async () => {
    const created = await db.createFeedbackSignal({
      id: 'fs_immutability_test',
      source: 'ide',
      sourceRef: null,
      failureSummary: 'original summary',
      userFeedbackExcerpt: 'original excerpt',
      correctedOutputHint: null,
      candidatePlaybookId: null,
      candidateDeckId: deckId,
      linkedPatchId: null,
      status: 'open',
    });
    const updated = await db.updateFeedbackSignalStatus(created.id, 'discarded');
    expect(updated?.failureSummary).toBe('original summary');
    expect(updated?.userFeedbackExcerpt).toBe('original excerpt');
    expect(updated?.status).toBe('discarded');
  });

  it('persists trigger conflicts on genesis propose and syncs stubs on accept', async () => {
    const existing = await playbookManager.create({
      title: 'Existing',
      body: '## Gotchas\n- one\n',
      triggers: ['master-detail layout', 'human gate UI'],
    });
    await playbookManager.addToDeck({ deckId, playbookId: existing.id });

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-patch-stub-'));
    await db.upsertDeckWorkspace(workspace, deckId);

    const result = await patchManager.propose(
      {
        kind: 'create',
        new_playbook: {
          title: 'UI principle',
          body: '## Gotchas\n- split panes\n',
          triggers: ['master-detail layout', 'split-pane UI'],
          deck_id: deckId,
        },
        rationale: 'Genesis with overlapping triggers.',
      },
      'ide',
      null,
    );
    if (result.kind === 'signal_only') throw new Error('expected patch');
    const patch = result.patch;

    expect(patch.conflictsJson).toBeTruthy();
    const conflicts = JSON.parse(patch.conflictsJson!);
    expect(conflicts.length).toBeGreaterThan(0);

    await patchManager.accept(patch.id);

    const cursorStubDir = path.join(workspace, '.cursor', 'rules', 'agent-deck-stubs');
    expect(fs.existsSync(cursorStubDir)).toBe(true);
    fs.rmSync(workspace, { recursive: true, force: true });
  });
});
