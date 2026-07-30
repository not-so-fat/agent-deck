import { describe, expect, it } from 'vitest';
import { StoreManifestSchema, StorePlaybookFileSchema, StoreDeckSchema } from './store';

describe('store schemas', () => {
  it('accepts manifest v1', () => {
    expect(
      StoreManifestSchema.parse({
        format: 'agent-deck-store',
        version: 1,
        migratedFrom: 'sqlite',
      }),
    ).toMatchObject({ format: 'agent-deck-store', version: 1 });
  });

  it('rejects unknown format', () => {
    expect(
      StoreManifestSchema.safeParse({ format: 'other', version: 1 }).success,
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
});
