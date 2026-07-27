import { z } from 'zod';
import { PlaybookIdSchema, PlaybookTriggersSchema } from './playbook';
import { BundleServiceSchema } from './export-bundle';

export const StoreManifestSchema = z
  .object({
    format: z.literal('agent-deck-store'),
    version: z.literal(1),
    migratedFrom: z.literal('sqlite').optional(),
  })
  .strict();

export const StorePlaybookFileSchema = z
  .object({
    id: PlaybookIdSchema,
    title: z.string().min(1),
    body: z.string().default(''),
    triggers: PlaybookTriggersSchema,
    dependsOnCredentialIds: z.array(z.string()).default([]),
    dependsOnServiceIds: z.array(z.string()).default([]),
    exec: z.string().optional(),
    skill: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

// Reuse bundle service shape (already create-safe)
export const StoreServiceSchema = BundleServiceSchema;

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
