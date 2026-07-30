import {
  CreatePlaybookPatchFieldsSchema,
  PatchOpSchema,
  ProposePlaybookPatchInput,
  ProposePlaybookPatchSchema,
  type FeedbackSignal,
  type FeedbackSignalSource,
  type PatchOp,
  type PatchPreview,
  type PlaybookPatch,
  type PlaybookPatchListItem,
  type PlaybookPatchSource,
  type ProposePlaybookPatchResult,
  assertTriggerCountPolicy,
  generateShortId,
  derivePlaybookDefaults,
  generateId,
} from '@agent-deck/shared';
import { DatabaseManager } from '../models/database';
import { PlaybookManager } from './playbook-manager';
import { applyPatchOps } from './apply-patch-ops';
import {
  parseTriggerConflicts,
  patchTouchesStubSurface,
  syncStubsForDeck,
  triggerWarningsForPlaybookDecks,
} from './stub-workspace-sync';

export class PatchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchConflictError';
  }
}

export class PatchNoChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchNoChangeError';
  }
}

function toSignalSource(source: PlaybookPatchSource): FeedbackSignalSource {
  return source === 'dealer' ? 'dealer' : 'ide';
}

export class PatchManager {
  constructor(
    private db: DatabaseManager,
    private playbookManager: PlaybookManager,
  ) {}

  private newPatchId(): string {
    return `pp_${generateShortId()}`;
  }

  private newSignalId(): string {
    return `fs_${generateShortId()}`;
  }

  private async writeSignal(input: {
    source: PlaybookPatchSource;
    sourceRef: string | null;
    failureSummary: string;
    userFeedbackExcerpt: string;
    correctedOutputHint: string | null;
    candidatePlaybookId: string | null;
    candidateDeckId: string | null;
    linkedPatchId: string | null;
    status: FeedbackSignal['status'];
  }): Promise<FeedbackSignal> {
    return this.db.createFeedbackSignal({
      id: this.newSignalId(),
      source: toSignalSource(input.source),
      sourceRef: input.sourceRef,
      failureSummary: input.failureSummary,
      userFeedbackExcerpt: input.userFeedbackExcerpt,
      correctedOutputHint: input.correctedOutputHint,
      candidatePlaybookId: input.candidatePlaybookId,
      candidateDeckId: input.candidateDeckId,
      linkedPatchId: input.linkedPatchId,
      status: input.status,
    });
  }

  private async linkCuratedSignals(
    signalIds: string[] | undefined,
    patchId: string,
  ): Promise<void> {
    if (!signalIds || signalIds.length === 0) return;
    for (const id of signalIds) {
      const existing = await this.db.getFeedbackSignal(id);
      if (!existing || existing.status !== 'open') continue;
      if (await this.db.isSignalLinkedToProposedPatch(existing)) continue;
      // Park only — actioned on accept.
      await this.db.updateFeedbackSignalStatus(id, 'open', patchId);
    }
  }

  async propose(
    input: ProposePlaybookPatchInput,
    source: PlaybookPatchSource,
    sourceRef: string | null,
    deckIdForCreate?: string,
  ): Promise<ProposePlaybookPatchResult> {
    const validated = ProposePlaybookPatchSchema.parse(input);

    const evidence = validated.evidence ?? {
      failure_summary: validated.rationale,
      user_feedback_excerpt: validated.rationale,
    };

    if (validated.kind === 'signal_only') {
      const signal = await this.writeSignal({
        source,
        sourceRef,
        failureSummary: evidence.failure_summary,
        userFeedbackExcerpt: evidence.user_feedback_excerpt,
        correctedOutputHint: evidence.corrected_output_hint ?? null,
        candidatePlaybookId: validated.playbook_id ?? null,
        candidateDeckId: deckIdForCreate ?? null,
        linkedPatchId: null,
        status: 'open',
      });
      return { kind: 'signal_only', signal };
    }

    const curationSubmit =
      Array.isArray(validated.signal_ids) && validated.signal_ids.length > 0;

    if (validated.kind === 'create') {
      const fieldsInput = validated.new_playbook;
      if (!fieldsInput) {
        throw new Error('new_playbook is required for create patches');
      }
      const fields = CreatePlaybookPatchFieldsSchema.parse({
        ...fieldsInput,
        deck_id: fieldsInput.deck_id ?? deckIdForCreate,
      });
      if (!fields.deck_id) {
        throw new Error('deck_id is required for create patches');
      }
      const conflicts = await triggerWarningsForPlaybookDecks(
        this.db,
        this.playbookManager,
        {
          id: '__new__',
          title: fields.title,
          triggers: fields.triggers,
        },
        [fields.deck_id],
      );

      const patch = await this.db.createPlaybookPatch({
        id: this.newPatchId(),
        kind: 'create',
        playbookId: null,
        opsJson: JSON.stringify(fields),
        rationale: validated.rationale,
        source,
        sourceRef,
        evidenceJson: validated.evidence ? JSON.stringify(validated.evidence) : null,
        conflictsJson: conflicts.length > 0 ? JSON.stringify(conflicts) : null,
      });

      if (curationSubmit) {
        await this.linkCuratedSignals(validated.signal_ids, patch.id);
        return { kind: 'create', patch, signal: null };
      }

      const signal = await this.writeSignal({
        source,
        sourceRef,
        failureSummary: evidence.failure_summary,
        userFeedbackExcerpt: evidence.user_feedback_excerpt,
        correctedOutputHint: evidence.corrected_output_hint ?? null,
        candidatePlaybookId: null,
        candidateDeckId: fields.deck_id,
        linkedPatchId: patch.id,
        status: 'open',
      });
      return { kind: 'create', patch, signal };
    }

    if (!validated.playbook_id) {
      throw new Error('playbook_id is required for update patches');
    }
    const playbook = await this.db.getPlaybook(validated.playbook_id);
    if (!playbook) {
      throw new Error(`Playbook not found: ${validated.playbook_id}`);
    }

    const ops = parseOps(validated.ops ?? []);
    if (ops.length === 0) {
      throw new Error('ops is required and must not be empty for update patches');
    }

    const dryRun = applyPatchOps(
      { body: playbook.body, triggers: playbook.triggers },
      ops,
    );
    if (!dryRun.ok) {
      throw new PatchConflictError(dryRun.conflict);
    }
    assertTriggerCountPolicy(dryRun.value.triggers.length, {
      mode: 'update',
      previousCount: playbook.triggers.length,
    });
    const bodyUnchanged = dryRun.value.body === playbook.body;
    const triggersUnchanged =
      JSON.stringify(dryRun.value.triggers) === JSON.stringify(playbook.triggers);
    if (bodyUnchanged && triggersUnchanged) {
      throw new PatchNoChangeError(
        'Patch ops resolve but produce no change. amend_item/remove_item anchors must match exact list lines; use rewrite_body for prose edits.',
      );
    }

    const conflicts = await triggerWarningsForPlaybookDecks(this.db, this.playbookManager, {
      id: playbook.id,
      title: playbook.title,
      triggers: dryRun.value.triggers,
    });

    const patch = await this.db.createPlaybookPatch({
      id: this.newPatchId(),
      kind: validated.kind,
      playbookId: validated.playbook_id,
      opsJson: JSON.stringify(ops),
      rationale: validated.rationale,
      source,
      sourceRef,
      evidenceJson: validated.evidence ? JSON.stringify(validated.evidence) : null,
      conflictsJson: conflicts.length > 0 ? JSON.stringify(conflicts) : null,
    });

    if (curationSubmit) {
      await this.linkCuratedSignals(validated.signal_ids, patch.id);
      return { kind: validated.kind, patch, signal: null };
    }

    const signal = await this.writeSignal({
      source,
      sourceRef,
      failureSummary: evidence.failure_summary,
      userFeedbackExcerpt: evidence.user_feedback_excerpt,
      correctedOutputHint: evidence.corrected_output_hint ?? null,
      candidatePlaybookId: validated.playbook_id,
      candidateDeckId: deckIdForCreate ?? null,
      linkedPatchId: patch.id,
      status: 'open',
    });
    return { kind: validated.kind, patch, signal };
  }

  async preview(patchId: string): Promise<PatchPreview | null> {
    const patch = await this.db.getPlaybookPatch(patchId);
    if (!patch) return null;

    if (patch.kind === 'create') {
      const fields = CreatePlaybookPatchFieldsSchema.parse(JSON.parse(patch.opsJson));
      const triggerConflicts = await triggerWarningsForPlaybookDecks(
        this.db,
        this.playbookManager,
        {
          id: '__new__',
          title: fields.title,
          triggers: fields.triggers,
        },
        [fields.deck_id],
      );
      return {
        before: { title: '', body: '', triggers: [] },
        after: {
          title: fields.title,
          body: fields.body,
          triggers: fields.triggers,
        },
        trigger_conflicts: triggerConflicts,
      };
    }

    if (!patch.playbookId) return null;
    const playbook = await this.db.getPlaybook(patch.playbookId);
    if (!playbook) return null;

    const ops = parseOps(JSON.parse(patch.opsJson));
    const result = applyPatchOps(
      { body: playbook.body, triggers: playbook.triggers },
      ops,
    );
    if (!result.ok) {
      throw new PatchConflictError(result.conflict);
    }

    const triggerConflicts = await triggerWarningsForPlaybookDecks(this.db, this.playbookManager, {
      id: playbook.id,
      title: playbook.title,
      triggers: result.value.triggers,
    });

    return {
      before: {
        title: playbook.title,
        body: playbook.body,
        triggers: playbook.triggers,
      },
      after: {
        title: playbook.title,
        body: result.value.body,
        triggers: result.value.triggers,
      },
      trigger_conflicts: triggerConflicts,
    };
  }

  private async syncStubSurfaceForPatch(patch: PlaybookPatch): Promise<void> {
    if (!patchTouchesStubSurface(patch)) {
      return;
    }

    const deckIds = new Set<string>();
    if (patch.kind === 'create') {
      const fields = CreatePlaybookPatchFieldsSchema.parse(JSON.parse(patch.opsJson));
      deckIds.add(fields.deck_id);
    } else if (patch.playbookId) {
      for (const deckId of await this.db.listDeckIdsForPlaybook(patch.playbookId)) {
        deckIds.add(deckId);
      }
    }

    for (const deckId of deckIds) {
      await syncStubsForDeck(this.db, this.playbookManager, deckId);
    }
  }

  async accept(patchId: string): Promise<PlaybookPatch> {
    const patch = await this.db.getPlaybookPatch(patchId);
    if (!patch) {
      throw new Error('Patch not found');
    }
    if (patch.status !== 'proposed') {
      throw new Error(`Patch is not proposed (status=${patch.status})`);
    }

    if (patch.kind === 'create') {
      const fields = CreatePlaybookPatchFieldsSchema.parse(JSON.parse(patch.opsJson));
      const defaults = derivePlaybookDefaults(fields.title);
      const created = await this.playbookManager.create({
        title: fields.title,
        body: fields.body,
        triggers: fields.triggers,
        exec: fields.exec,
        skill: fields.skill,
        id: defaults.id,
        dependsOnCredentialIds: [],
        dependsOnServiceIds: [],
      });
      await this.playbookManager.addToDeck({ deckId: fields.deck_id, playbookId: created.id });
      await this.snapshotVersion(created, patchId, 'agent');
      const updated = await this.db.updatePlaybookPatchStatus(patchId, 'accepted');
      await this.db.actionSignalsForPatch(patchId);
      await this.syncStubSurfaceForPatch(patch);
      return updated!;
    }

    if (!patch.playbookId) {
      throw new Error('Update patch missing playbook_id');
    }
    const playbook = await this.db.getPlaybook(patch.playbookId);
    if (!playbook) {
      await this.db.updatePlaybookPatchStatus(
        patchId,
        'rejected',
        'Target playbook was deleted',
      );
      await this.db.reopenSignalsForPatch(patchId);
      throw new Error('Target playbook was deleted');
    }

    const ops = parseOps(JSON.parse(patch.opsJson));
    const result = applyPatchOps(
      { body: playbook.body, triggers: playbook.triggers },
      ops,
    );
    if (!result.ok) {
      await this.db.updatePlaybookPatchStatus(patchId, 'stale');
      await this.db.reopenSignalsForPatch(patchId);
      throw new PatchConflictError(result.conflict);
    }

    const updatedPlaybook = await this.playbookManager.updateWithDependencies(patch.playbookId, {
      body: result.value.body,
      triggers: result.value.triggers,
      autoDetectDependencies: true,
    });
    if (!updatedPlaybook) {
      throw new Error('Failed to update playbook');
    }
    await this.snapshotVersion(updatedPlaybook, patchId, 'agent');
    const accepted = await this.db.updatePlaybookPatchStatus(patchId, 'accepted');
    await this.db.actionSignalsForPatch(patchId);
    await this.syncStubSurfaceForPatch(patch);
    return accepted!;
  }

  async reject(patchId: string, reason: string): Promise<PlaybookPatch | null> {
    const patch = await this.db.getPlaybookPatch(patchId);
    if (!patch) return null;
    if (patch.status !== 'proposed') {
      throw new Error(`Patch is not proposed (status=${patch.status})`);
    }
    const updated = await this.db.updatePlaybookPatchStatus(patchId, 'rejected', reason);
    await this.db.reopenSignalsForPatch(patchId);
    return updated;
  }

  async list(status?: PlaybookPatch['status']): Promise<PlaybookPatch[]> {
    return this.db.listPlaybookPatches(status);
  }

  async listForReview(status?: PlaybookPatch['status']): Promise<PlaybookPatchListItem[]> {
    const patches = await this.db.listPlaybookPatches(status);
    return Promise.all(patches.map((patch) => this.enrichListItem(patch)));
  }

  parseStoredTriggerConflicts(patch: PlaybookPatch) {
    return parseTriggerConflicts(patch.conflictsJson);
  }

  private async enrichListItem(patch: PlaybookPatch): Promise<PlaybookPatchListItem> {
    if (patch.kind === 'create') {
      const fields = CreatePlaybookPatchFieldsSchema.parse(JSON.parse(patch.opsJson));
      const deck = await this.db.getDeck(fields.deck_id);
      return {
        ...patch,
        displayTitle: fields.title,
        deckNames: deck ? [deck.name] : [],
      };
    }

    const playbook = patch.playbookId ? await this.db.getPlaybook(patch.playbookId) : null;
    const deckNames = patch.playbookId
      ? await this.db.listDeckNamesForPlaybook(patch.playbookId)
      : [];

    return {
      ...patch,
      displayTitle: playbook?.title ?? patch.playbookId ?? 'Unknown playbook',
      deckNames,
    };
  }

  async snapshotVersion(
    playbook: { id: string; title: string; body: string; triggers: string[] },
    patchId: string | null,
    actor: 'user' | 'agent',
  ): Promise<void> {
    await this.db.createPlaybookVersion({
      id: generateId(),
      playbookId: playbook.id,
      title: playbook.title,
      body: playbook.body,
      triggers: playbook.triggers,
      patchId,
      actor,
    });
  }
}

function parseOps(raw: unknown): PatchOp[] {
  if (!Array.isArray(raw)) {
    throw new Error('ops must be an array');
  }
  return raw.map((op) => PatchOpSchema.parse(op));
}
