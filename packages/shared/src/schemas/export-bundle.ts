import { z } from 'zod';
import { OperatingInstructionsSchema } from './deck';
import { PlaybookIdSchema } from './playbook';

export const BundleFormatSchema = z.literal('agent-deck-bundle');
export const BundleVersionSchema = z.literal(1);
export const BundleV2VersionSchema = z.literal(2);
export const BundleScopeSchema = z.enum(['collection', 'deck']);

export const BundleServiceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(['mcp', 'a2a', 'local-mcp']),
    url: z.string().min(1),
    description: z.string().optional(),
    cardColor: z.string().optional(),
    iconUrl: z.string().optional(),
    disabledToolNames: z.array(z.string()).default([]),
    headers: z.record(z.string()).optional(),
    oauthClientId: z.string().optional(),
    oauthAuthorizationUrl: z.string().optional(),
    oauthTokenUrl: z.string().optional(),
    oauthRedirectUri: z.string().optional(),
    oauthScope: z.string().optional(),
    localCommand: z.string().optional(),
    localArgs: z.array(z.string()).optional(),
    localWorkingDir: z.string().optional(),
  })
  .strict();

export const BundlePlaybookSchema = z
  .object({
    id: PlaybookIdSchema,
    title: z.string().min(1),
    body: z.string().default(''),
    triggers: z.array(z.string()).default([]),
    dependsOnServiceIds: z.array(z.string()).default([]),
    exec: z.string().optional(),
    skill: z.string().optional(),
  })
  .strict();

export const BundleDeckSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    serviceIds: z.array(z.string()).default([]),
    playbookIds: z.array(z.string()).default([]),
  })
  // Ignore legacy `description` on older bundles.
  .strip();

export const BundleV1Schema = z
  .object({
    format: BundleFormatSchema,
    version: BundleVersionSchema,
    exportedAt: z.string().datetime(),
    exportedFrom: z.object({
      agentDeckVersion: z.string().min(1),
    }),
    scope: BundleScopeSchema,
    services: z.array(BundleServiceSchema).default([]),
    playbooks: z.array(BundlePlaybookSchema).default([]),
    decks: z.array(BundleDeckSchema).default([]),
  })
  .strict();

export const BundleDeckV2Schema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    operatingInstructions: OperatingInstructionsSchema.default(''),
    serviceIds: z.array(z.string()).default([]),
    playbookIds: z.array(z.string()).default([]),
  })
  // Ignore legacy `description` on older bundles.
  .strip();

export const BundleV2Schema = z
  .object({
    format: BundleFormatSchema,
    version: BundleV2VersionSchema,
    exportedAt: z.string().datetime(),
    exportedFrom: z.object({
      agentDeckVersion: z.string().min(1),
    }),
    scope: BundleScopeSchema,
    services: z.array(BundleServiceSchema).default([]),
    playbooks: z.array(BundlePlaybookSchema).default([]),
    decks: z.array(BundleDeckV2Schema).default([]),
  })
  .strict();

/**
 * Import-side parser: exports always emit v2, but v1 bundles stay readable.
 * Imported v1 decks receive empty instructions (see import-bundle.ts).
 */
export const BundleAnySchema = z.discriminatedUnion('version', [
  BundleV1Schema,
  BundleV2Schema,
]);

export const ImportEntityCountsSchema = z.object({
  created: z.number().int().min(0),
  reused: z.number().int().min(0),
});

export const ImportReportCountsSchema = z.object({
  services: ImportEntityCountsSchema,
  playbooks: ImportEntityCountsSchema,
  decks: ImportEntityCountsSchema,
});

export const ImportReportSchema = z.object({
  status: z.enum(['completed', 'failed', 'partial']),
  counts: ImportReportCountsSchema,
  servicesNeedingOauth: z.array(z.string()),
  warnings: z.array(z.string()),
  idMap: z.record(z.string()),
});

export const ExportRequestSchema = z
  .object({
    scope: BundleScopeSchema.default('collection'),
    deckId: z.string().uuid().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.scope === 'deck' && !data.deckId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'deckId is required when scope is deck',
        path: ['deckId'],
      });
    }
  });

export type BundleService = z.infer<typeof BundleServiceSchema>;
export type BundlePlaybook = z.infer<typeof BundlePlaybookSchema>;
export type BundleDeck = z.infer<typeof BundleDeckSchema>;
export type BundleV1 = z.infer<typeof BundleV1Schema>;
export type BundleDeckV2 = z.infer<typeof BundleDeckV2Schema>;
export type BundleV2 = z.infer<typeof BundleV2Schema>;
export type BundleAny = z.infer<typeof BundleAnySchema>;
export type BundleScope = z.infer<typeof BundleScopeSchema>;
export type ImportReport = z.infer<typeof ImportReportSchema>;
export type ExportRequest = z.infer<typeof ExportRequestSchema>;
