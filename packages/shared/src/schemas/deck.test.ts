import { describe, expect, it } from 'vitest';
import {
  CreateDeckSchema,
  DeckSchema,
  normalizeOperatingInstructions,
  OPERATING_INSTRUCTIONS_MAX_LENGTH,
  OperatingInstructionsSchema,
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
    // Exactly at the bound, already in canonical form (trailing newline).
    expect(
      CreateDeckSchema.parse({
        name: 'dev',
        operatingInstructions: `${'x'.repeat(OPERATING_INSTRUCTIONS_MAX_LENGTH - 1)}\n`,
      }).operatingInstructions,
    ).toHaveLength(OPERATING_INSTRUCTIONS_MAX_LENGTH);
  });

  it('normalizes to a canonical trailing newline for non-empty bodies', () => {
    expect(normalizeOperatingInstructions('')).toBe('');
    expect(normalizeOperatingInstructions('\n')).toBe('');
    expect(normalizeOperatingInstructions('Prefer small PRs.')).toBe(
      'Prefer small PRs.\n',
    );
    expect(normalizeOperatingInstructions('Prefer small PRs.\n')).toBe(
      'Prefer small PRs.\n',
    );
    // Leading blank lines are preserved; normalization is idempotent.
    expect(normalizeOperatingInstructions('\nBody\n')).toBe('\nBody\n');
    expect(
      normalizeOperatingInstructions(
        normalizeOperatingInstructions('Body without newline'),
      ),
    ).toBe('Body without newline\n');
  });

  it('applies the bound to the normalized form', () => {
    // 16,000 chars without a trailing newline normalizes to 16,001 and fails.
    expect(
      OperatingInstructionsSchema.safeParse(
        'x'.repeat(OPERATING_INSTRUCTIONS_MAX_LENGTH),
      ).success,
    ).toBe(false);
    // 15,999 chars without a newline normalizes to exactly 16,000 and passes.
    expect(
      OperatingInstructionsSchema.parse(
        'x'.repeat(OPERATING_INSTRUCTIONS_MAX_LENGTH - 1),
      ),
    ).toHaveLength(OPERATING_INSTRUCTIONS_MAX_LENGTH);
    expect(
      OperatingInstructionsSchema.parse(
        `${'x'.repeat(OPERATING_INSTRUCTIONS_MAX_LENGTH - 1)}\n`,
      ),
    ).toHaveLength(OPERATING_INSTRUCTIONS_MAX_LENGTH);
  });
});
