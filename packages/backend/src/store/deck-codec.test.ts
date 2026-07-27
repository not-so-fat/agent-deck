import { describe, expect, it } from 'vitest';
import { parseDeckJson, serializeDeck } from './deck-codec';

describe('deck-codec', () => {
  it('round-trips deck with ordered ids', () => {
    const input = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'dev',
      serviceIds: ['svc-a', 'svc-b'],
      credentialIds: ['cred_x'],
      playbookIds: ['pb_demo', 'pb_other'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const raw = serializeDeck(input);
    expect(raw.endsWith('\n')).toBe(true);
    expect(parseDeckJson(raw)).toEqual(input);
  });
});
