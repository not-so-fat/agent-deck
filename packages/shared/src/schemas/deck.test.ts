import { describe, expect, it } from 'vitest';
import {
  CreateDeckSchema,
  DeckSchema,
  OPERATING_INSTRUCTIONS_MAX_LENGTH,
  UpdateDeckSchema,
} from './deck';

describe('deck operating instructions contract', () => {
  it('defaults read-model instructions to an empty string', () => {
    const deck = DeckSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'dev',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(deck.operatingInstructions).toBe('');
  });

  it('accepts instructions on create and update', () => {
    expect(
      CreateDeckSchema.parse({ name: 'dev', operatingInstructions: '# Runbook\n' })
        .operatingInstructions,
    ).toBe('# Runbook\n');
    expect(
      UpdateDeckSchema.parse({ operatingInstructions: '' }).operatingInstructions,
    ).toBe('');
    expect(UpdateDeckSchema.parse({}).operatingInstructions).toBeUndefined();
  });

  it('rejects instructions over the shared bound with the field path', () => {
    const over = 'x'.repeat(OPERATING_INSTRUCTIONS_MAX_LENGTH + 1);
    for (const schema of [DeckSchema, CreateDeckSchema, UpdateDeckSchema]) {
      const parsed = schema.safeParse(
        schema === DeckSchema
          ? {
              id: '11111111-1111-4111-8111-111111111111',
              name: 'dev',
              operatingInstructions: over,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            }
          : { name: 'dev', operatingInstructions: over },
      );
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0].path).toEqual(['operatingInstructions']);
      }
    }
    expect(
      CreateDeckSchema.parse({
        name: 'dev',
        operatingInstructions: 'x'.repeat(OPERATING_INSTRUCTIONS_MAX_LENGTH),
      }).operatingInstructions,
    ).toHaveLength(OPERATING_INSTRUCTIONS_MAX_LENGTH);
  });
});
