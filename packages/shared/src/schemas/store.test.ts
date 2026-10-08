import { describe, expect, it } from 'vitest';
import { OPERATING_INSTRUCTIONS_MAX_LENGTH } from './deck';
import { StoreManifestSchema, StorePlaybookFileSchema, StoreDeckSchema } from './store';

describe('store schemas', () => {
  it('accepts manifest v2', () => {
    expect(
      StoreManifestSchema.parse({
        format: 'agent-deck-store',
        version: 2,
        migratedFrom: 'sqlite',
      }),
    ).toMatchObject({ format: 'agent-deck-store', version: 2 });
  });

  it('still accepts manifest v1 so the automatic migration can detect it', () => {
    expect(
      StoreManifestSchema.parse({
        format: 'agent-deck-store',
        version: 1,
      }),
    ).toMatchObject({ format: 'agent-deck-store', version: 1 });
  });

  it('rejects unknown manifest versions', () => {
    expect(
      StoreManifestSchema.safeParse({ format: 'agent-deck-store', version: 3 })
        .success,
    ).toBe(false);
  });

  it('rejects unknown format', () => {
    expect(
      StoreManifestSchema.safeParse({ format: 'other', version: 2 }).success,
    ).toBe(false);
  });

  it('requires playbook timestamps', () => {
    const r = StorePlaybookFileSchema.safeParse({
      id: 'pb_x',
      title: 'X',
      body: '',
      triggers: [],
      dependsOnCredentialIds: [],
      dependsOnServiceIds: [],
    });
    expect(r.success).toBe(false);
  });

  it('accepts more than 16 triggers (legacy SQLite round-trip)', () => {
    const triggers = Array.from({ length: 20 }, (_, index) => `trigger ${index}`);
    const parsed = StorePlaybookFileSchema.parse({
      id: 'pb_legacy',
      title: 'Legacy',
      body: '',
      triggers,
      dependsOnCredentialIds: [],
      dependsOnServiceIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(parsed.triggers).toHaveLength(20);
  });

  it('parses deck with ordered ids', () => {
    const deck = StoreDeckSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'dev',
      serviceIds: [],
      credentialIds: [],
      playbookIds: ['pb_x'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(deck.playbookIds).toEqual(['pb_x']);
  });

  it('defaults missing deck instructions to an empty string (legacy v1 JSON)', () => {
    const deck = StoreDeckSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'dev',
      serviceIds: [],
      credentialIds: [],
      playbookIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(deck.operatingInstructions).toBe('');
  });

  it('accepts empty deck instructions and rejects bodies over the shared bound', () => {
    const base = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'dev',
      serviceIds: [] as string[],
      credentialIds: [] as string[],
      playbookIds: [] as string[],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(
      StoreDeckSchema.parse({ ...base, operatingInstructions: '' })
        .operatingInstructions,
    ).toBe('');
    expect(
      StoreDeckSchema.parse({
        ...base,
        operatingInstructions: 'x'.repeat(OPERATING_INSTRUCTIONS_MAX_LENGTH),
      }).operatingInstructions,
    ).toHaveLength(OPERATING_INSTRUCTIONS_MAX_LENGTH);

    const over = StoreDeckSchema.safeParse({
      ...base,
      operatingInstructions: 'x'.repeat(OPERATING_INSTRUCTIONS_MAX_LENGTH + 1),
    });
    expect(over.success).toBe(false);
    if (!over.success) {
      expect(over.error.issues[0].path).toEqual(['operatingInstructions']);
      expect(over.error.issues[0].message).toMatch(/16,000/);
    }
  });
});
