import { z } from 'zod';
import { normalizeTriggers } from '../utils/trigger-hygiene';

function makeTriggersSchema(maxCount: number | null | undefined) {
  return z
    .array(z.string())
    .transform((triggers, ctx) => {
      try {
        // undefined → default create cap (16); null → no count cap
        return maxCount === undefined
          ? normalizeTriggers(triggers)
          : normalizeTriggers(triggers, { maxCount });
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : 'Invalid triggers',
        });
        return z.NEVER;
      }
    })
    .default([]);
}

/** Create / genesis — hard max 16. */
export const PlaybookTriggersSchema = makeTriggersSchema(undefined);

/**
 * Update / set_triggers — normalize without count cap.
 * Count policy (grandfather) is enforced in PlaybookManager / PatchManager.
 */
export const PlaybookTriggersUpdateSchema = makeTriggersSchema(null);

export const PlaybookIdSchema = z
  .string()
  .regex(/^pb_[a-z0-9_]+$/, 'Playbook id must match pb_<slug>');

export const PlaybookSchema = z.object({
  id: PlaybookIdSchema,
  title: z.string().min(1, 'Title is required'),
  body: z.string().default(''),
  triggers: PlaybookTriggersUpdateSchema,
  dependsOnCredentialIds: z.array(z.string()).default([]),
  dependsOnServiceIds: z.array(z.string()).default([]),
  exec: z.string().optional(),
  skill: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const CreatePlaybookSchema = z.object({
  id: PlaybookIdSchema.optional(),
  title: z.string().min(1, 'Title is required'),
  body: z.string().default(''),
  triggers: PlaybookTriggersSchema,
  dependsOnCredentialIds: z.array(z.string()).default([]),
  dependsOnServiceIds: z.array(z.string()).default([]),
  exec: z.string().optional(),
  skill: z.string().optional(),
});

export const UpdatePlaybookSchema = z.object({
  title: z.string().min(1, 'Title is required').optional(),
  body: z.string().optional(),
  triggers: PlaybookTriggersUpdateSchema.optional(),
  dependsOnCredentialIds: z.array(z.string()).optional(),
  dependsOnServiceIds: z.array(z.string()).optional(),
  exec: z.string().optional(),
  skill: z.string().optional(),
});

export const DashboardRegisterPlaybookSchema = CreatePlaybookSchema.extend({
  autoDetectDependencies: z.boolean().default(true),
});

export const DashboardUpdatePlaybookSchema = UpdatePlaybookSchema.extend({
  autoDetectDependencies: z.boolean().default(true),
});

export const AgentRegisterPlaybookSchema = CreatePlaybookSchema.extend({
  addToBoundDeck: z.boolean().default(true),
  autoDetectDependencies: z.boolean().default(true),
});

export const AgentUpdatePlaybookSchema = UpdatePlaybookSchema.extend({
  autoDetectDependencies: z.boolean().default(true),
});

export const DeckPlaybookSchema = z.object({
  deckId: z.string().uuid('Valid deck ID required'),
  playbookId: PlaybookIdSchema,
  position: z.number().int().min(0, 'Position must be non-negative'),
});

export const AddPlaybookToDeckSchema = DeckPlaybookSchema.omit({
  position: true,
}).extend({
  position: z.number().int().min(0).optional(),
});

export const RemovePlaybookFromDeckSchema = z.object({
  deckId: z.string().uuid('Valid deck ID required'),
  playbookId: PlaybookIdSchema,
});

export type Playbook = z.infer<typeof PlaybookSchema>;
export type CreatePlaybookInput = z.infer<typeof CreatePlaybookSchema>;
export type UpdatePlaybookInput = z.infer<typeof UpdatePlaybookSchema>;
export type AgentRegisterPlaybookInput = z.infer<typeof AgentRegisterPlaybookSchema>;
export type AgentUpdatePlaybookInput = z.infer<typeof AgentUpdatePlaybookSchema>;
export type DashboardRegisterPlaybookInput = z.infer<typeof DashboardRegisterPlaybookSchema>;
export type DashboardUpdatePlaybookInput = z.infer<typeof DashboardUpdatePlaybookSchema>;
export type DeckPlaybook = z.infer<typeof DeckPlaybookSchema>;
export type AddPlaybookToDeckInput = z.infer<typeof AddPlaybookToDeckSchema>;
export type RemovePlaybookFromDeckInput = z.infer<typeof RemovePlaybookFromDeckSchema>;

export type PlaybookSummary = Pick<Playbook, 'id' | 'title' | 'triggers'>;

export type PlaybookDependencyRef = {
  id: string;
  label: string;
};

export type PlaybookDependencies = {
  credentials: PlaybookDependencyRef[];
  services: PlaybookDependencyRef[];
  missingCredentialIds: string[];
  missingServiceIds: string[];
};

export type PlaybookWithDependencies = Playbook & {
  dependencies: PlaybookDependencies;
};

export type PlaybookDependent = {
  id: string;
  title: string;
};
