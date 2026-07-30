import { z } from 'zod';
import { PlaybookIdSchema } from './playbook';
import { BundleServiceSchema } from './export-bundle';
import { normalizeTriggers } from '../utils/trigger-hygiene';

export const StoreManifestSchema = z
  .object({
    format: z.literal('agent-deck-store'),
    version: z.literal(1),
    migratedFrom: z.literal('sqlite').optional(),
  })
  .strict();

/**
 * Store files must round-trip legacy DB rows (including >16 triggers).
 * Create/update APIs still use PlaybookTriggersSchema (max 16).
 */
export const StorePlaybookTriggersSchema = z
  .array(z.string())
  .transform((triggers, ctx) => {
    try {
      return normalizeTriggers(triggers, { maxCount: null });
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'Invalid triggers',
      });
      return z.NEVER;
    }
  })
  .default([]);

export const StorePlaybookFileSchema = z
  .object({
    id: PlaybookIdSchema,
    title: z.string().min(1),
    body: z.string().default(''),
    triggers: StorePlaybookTriggersSchema,
    dependsOnCredentialIds: z.array(z.string()).default([]),
    dependsOnServiceIds: z.array(z.string()).default([]),
    exec: z.string().optional(),
    skill: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

/** Create-safe service file shape; credentialId is local SoT (not in shareable export bundles). */
export const StoreServiceSchema = BundleServiceSchema.extend({
  credentialId: z.string().min(1).optional(),
});

export const StoreDeckSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    serviceIds: z.array(z.string()).default([]),
    credentialIds: z.array(z.string()).default([]),
    playbookIds: z.array(z.string()).default([]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const StoreCredentialMetaSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    scheme: z.enum(['bearer', 'header', 'http_basic_user']),
    headerName: z.string().nullable().optional(),
    envName: z.string().min(1),
    tags: z.array(z.string()).default([]),
    docsUrl: z.string().nullable().optional(),
  })
  .strict();

export type StoreManifest = z.infer<typeof StoreManifestSchema>;
export type StorePlaybookFile = z.infer<typeof StorePlaybookFileSchema>;
export type StoreService = z.infer<typeof StoreServiceSchema>;
export type StoreDeck = z.infer<typeof StoreDeckSchema>;
export type StoreCredentialMeta = z.infer<typeof StoreCredentialMetaSchema>;
