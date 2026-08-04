import { z } from 'zod';
import { PlaybookIdSchema, PlaybookTriggersSchema, PlaybookTriggersUpdateSchema } from './playbook';
import type { TriggerConflict } from '../utils/trigger-hygiene';

export const PlaybookPatchIdSchema = z
  .string()
  .regex(/^pp_[a-z0-9_]+$/, 'Patch id must match pp_<slug>');

/** Stored on `playbook_patches` rows — never includes signal_only. */
export const PlaybookPatchKindSchema = z.enum(['create', 'update', 'merge', 'retire']);

/** Propose MCP/API kinds — includes signal_only (no patch row). */
export const ProposePlaybookPatchKindSchema = z.enum([
  'create',
  'update',
  'merge',
  'retire',
  'signal_only',
]);

export const PlaybookPatchStatusSchema = z.enum([
  'proposed',
  'accepted',
  'rejected',
  'stale',
  'superseded',
]);

export const PlaybookPatchSourceSchema = z.enum(['ide', 'dealer', 'hook', 'harvester']);

export type PlaybookPatchSource = z.infer<typeof PlaybookPatchSourceSchema>;
export type ProposePlaybookPatchKind = z.infer<typeof ProposePlaybookPatchKindSchema>;

export const PatchEvidenceSchema = z.object({
  failure_summary: z.string().min(1),
  user_feedback_excerpt: z.string().min(1),
  corrected_output_hint: z.string().optional(),
});

export const AddItemOpSchema = z.object({
  op: z.literal('add_item').describe('Append a bullet to a ## section (creates the section if missing)'),
  section: z.string().min(1).describe('## heading name, e.g. Gotchas or Checklist'),
  text: z.string().min(1).describe('Bullet text; a leading "- " is added when omitted'),
});

export const AmendItemOpSchema = z.object({
  op: z.literal('amend_item').describe('Replace one existing list item line (not prose paragraphs)'),
  section: z.string().min(1).describe('## heading that contains the anchor line'),
  anchor: z.string().min(1).describe('Exact list line to replace, including "- " prefix'),
  text: z.string().min(1).describe('Replacement bullet text; leading "- " optional'),
});

export const RemoveItemOpSchema = z.object({
  op: z.literal('remove_item').describe('Delete one existing list item line (not prose paragraphs)'),
  section: z.string().min(1).describe('## heading that contains the anchor line'),
  anchor: z.string().min(1).describe('Exact list line to delete, including "- " prefix'),
});

export const SetTriggersOpSchema = z.object({
  op: z.literal('set_triggers').describe('Replace the playbook trigger phrases'),
  triggers: PlaybookTriggersUpdateSchema.describe(
    'New trigger list (count policy enforced against the current playbook)',
  ),
});

export const RewriteBodyOpSchema = z.object({
  op: z.literal('rewrite_body').describe('Replace the entire playbook body — use only when item ops cannot reach the edit'),
  text: z.string().describe('Full new markdown body'),
});

export const BodyPatchOpSchema = z.discriminatedUnion('op', [
  AddItemOpSchema,
  AmendItemOpSchema,
  RemoveItemOpSchema,
  RewriteBodyOpSchema,
]);

export const PatchOpSchema = z.discriminatedUnion('op', [
  AddItemOpSchema,
  AmendItemOpSchema,
  RemoveItemOpSchema,
  SetTriggersOpSchema,
  RewriteBodyOpSchema,
]);

export const CreatePlaybookPatchFieldsSchema = z.object({
  title: z.string().min(1),
  body: z.string().default(''),
  triggers: PlaybookTriggersSchema.refine((triggers) => triggers.length > 0, {
    message: 'Genesis playbooks need at least one trigger',
  }),
  deck_id: z.string().uuid(),
  exec: z.string().optional(),
  skill: z.string().optional(),
});

export const ProposePlaybookPatchSchema = z
  .object({
    kind: ProposePlaybookPatchKindSchema,
    playbook_id: PlaybookIdSchema.optional(),
    ops: z.array(PatchOpSchema).optional(),
    new_playbook: CreatePlaybookPatchFieldsSchema.optional(),
    rationale: z.string().min(1),
    evidence: PatchEvidenceSchema.optional(),
    /** When submitting a curated revision, link these open signals to the new patch (actioned on accept). */
    signal_ids: z.array(z.string().regex(/^fs_[a-z0-9_]+$/)).optional(),
    /** Proposed patch ids this proposal replaces (same playbook / same lesson). */
    supersedes: z.array(PlaybookPatchIdSchema).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.kind === 'signal_only') {
      if (!val.evidence) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'evidence is required for signal_only',
          path: ['evidence'],
        });
      }
      if (val.ops !== undefined && val.ops.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'ops must not be set for signal_only',
          path: ['ops'],
        });
      }
      if (val.new_playbook !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'new_playbook must not be set for signal_only',
          path: ['new_playbook'],
        });
      }
      if (val.signal_ids !== undefined && val.signal_ids.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'signal_ids must not be set for signal_only',
          path: ['signal_ids'],
        });
      }
      if (val.supersedes !== undefined && val.supersedes.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'supersedes must not be set for signal_only',
          path: ['supersedes'],
        });
      }
    }
  });

export const RejectPlaybookPatchSchema = z.object({
  /** Optional — empty/omitted is fine for bulk triage. */
  reason: z.string().optional(),
});

export type PatchEvidence = z.infer<typeof PatchEvidenceSchema>;
export type PatchOp = z.infer<typeof PatchOpSchema>;
export type BodyPatchOp = z.infer<typeof BodyPatchOpSchema>;
export type CreatePlaybookPatchFields = z.infer<typeof CreatePlaybookPatchFieldsSchema>;
export type ProposePlaybookPatchInput = z.infer<typeof ProposePlaybookPatchSchema>;

export type PlaybookPatch = {
  id: string;
  kind: z.infer<typeof PlaybookPatchKindSchema>;
  playbookId: string | null;
  opsJson: string;
  rationale: string;
  source: z.infer<typeof PlaybookPatchSourceSchema>;
  sourceRef: string | null;
  evidenceJson: string | null;
  conflictsJson: string | null;
  status: z.infer<typeof PlaybookPatchStatusSchema>;
  rejectionReason: string | null;
  /** Successor patch id when status is superseded. */
  supersededBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

/** Compact open proposal summary returned on get_playbook. */
export type OpenPlaybookPatchSummary = {
  id: string;
  kind: z.infer<typeof PlaybookPatchKindSchema>;
  rationale: string;
  failureSummary: string | null;
  userFeedbackExcerpt: string | null;
  createdAt: string;
};

/** Result of propose when kind is signal_only (no playbook_patches row). */
export type ProposeSignalOnlyResult = {
  kind: 'signal_only';
  signal: import('./feedback-signal').FeedbackSignal;
};

/** Result of propose when a patch row was created. */
export type ProposePatchResult = {
  kind: Exclude<ProposePlaybookPatchKind, 'signal_only'>;
  patch: PlaybookPatch;
  /** Null when curation submit (`signal_ids`); otherwise new signal still `open` + linked. */
  signal: import('./feedback-signal').FeedbackSignal | null;
  /** Patch ids marked superseded by this propose (empty when none). */
  superseded: string[];
};

export type ProposePlaybookPatchResult = ProposeSignalOnlyResult | ProposePatchResult;

/** Dashboard list row — human title + decks referencing the playbook. */
export type PlaybookPatchListItem = PlaybookPatch & {
  displayTitle: string;
  deckNames: string[];
};

export type PlaybookVersion = {
  id: string;
  playbookId: string;
  title: string;
  body: string;
  triggers: string[];
  patchId: string | null;
  actor: 'user' | 'agent';
  createdAt: string;
};

export type PlaybookEvent = {
  id: string;
  playbookId: string;
  event: 'fetched';
  source: string;
  createdAt: string;
};

export type PatchPreview = {
  before: { title: string; body: string; triggers: string[] };
  after: { title: string; body: string; triggers: string[] };
  trigger_conflicts?: TriggerConflict[];
};
