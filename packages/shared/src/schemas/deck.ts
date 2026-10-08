import { z } from 'zod';
import { CredentialSchema } from './credential';
import { PlaybookSchema } from './playbook';

/**
 * Single shared bound for deck operating instructions (NOT-374).
 *
 * Instructions live as the Markdown body of `decks/<id>.md` in the Git-synced
 * file store, with SQLite holding a rebuildable copy. Every entry point — the
 * deck API, the store codec, and reindex — enforces this same limit.
 */
export const OPERATING_INSTRUCTIONS_MAX_LENGTH = 16_000;

export const OperatingInstructionsSchema = z
  .string()
  .max(
    OPERATING_INSTRUCTIONS_MAX_LENGTH,
    `Deck operating instructions must be at most ${OPERATING_INSTRUCTIONS_MAX_LENGTH.toLocaleString('en-US')} characters`,
  );

export const DeckSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1, 'Deck name is required'),
  isActive: z.boolean().default(false),
  operatingInstructions: OperatingInstructionsSchema.default(''),
  services: z.array(z.any()).default([]), // Will be populated with Service objects
  credentials: z.array(CredentialSchema).default([]),
  playbooks: z.array(PlaybookSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const CreateDeckSchema = DeckSchema.omit({
  id: true,
  services: true,
  createdAt: true,
  updatedAt: true,
});

export const UpdateDeckSchema = CreateDeckSchema.partial();

export const DeckServiceSchema = z.object({
  deckId: z.string().uuid('Valid deck ID required'),
  serviceId: z.string().uuid('Valid service ID required'),
  position: z.number().int().min(0, 'Position must be non-negative'),
});

export const AddServiceToDeckSchema = DeckServiceSchema.omit({
  position: true,
}).extend({
  position: z.number().int().min(0).optional(),
});

export const RemoveServiceFromDeckSchema = z.object({
  deckId: z.string().uuid('Valid deck ID required'),
  serviceId: z.string().uuid('Valid service ID required'),
});

export const ReorderDeckServicesSchema = z.object({
  deckId: z.string().uuid('Valid deck ID required'),
  serviceIds: z.array(z.string().uuid('Valid service ID required')).min(1, 'At least one service ID required'),
});

export type Deck = z.infer<typeof DeckSchema>;
export type CreateDeckInput = z.infer<typeof CreateDeckSchema>;
export type UpdateDeckInput = z.infer<typeof UpdateDeckSchema>;
export type DeckService = z.infer<typeof DeckServiceSchema>;
export type AddServiceToDeckInput = z.infer<typeof AddServiceToDeckSchema>;
export type RemoveServiceFromDeckInput = z.infer<typeof RemoveServiceFromDeckSchema>;
export type ReorderDeckServicesInput = z.infer<typeof ReorderDeckServicesSchema>;
