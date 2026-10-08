import { describe, expect, it } from 'vitest';
import { OPERATING_INSTRUCTIONS_MAX_LENGTH } from '@agent-deck/shared';
import {
  parseDeckJson,
  parseDeckMarkdown,
  serializeDeck,
} from './deck-codec';

const DECK = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'dev',
  serviceIds: ['svc-a', 'svc-b'],
  credentialIds: ['cred_x'],
  playbookIds: ['pb_demo', 'pb_other'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

describe('deck-codec', () => {
  it('round-trips frontmatter metadata with the instructions body', () => {
    const input = { ...DECK, operatingInstructions: '# Runbook\n\nShip it.\n' };
    const raw = serializeDeck(input);
    expect(raw.startsWith('---\n')).toBe(true);
    expect(raw).toContain('id: 11111111-1111-4111-8111-111111111111');
    expect(raw).toContain('# Runbook');
    expect(parseDeckMarkdown(raw)).toEqual(input);
  });

  it('round-trips ordered ids with an empty body', () => {
    const input = { ...DECK, operatingInstructions: '' };
    expect(parseDeckMarkdown(serializeDeck(input))).toEqual(input);
  });

  it('keeps instructions out of the frontmatter', () => {
    const raw = serializeDeck({ ...DECK, operatingInstructions: 'Body only' });
    const frontmatter = raw.split('---\n')[1];
    expect(frontmatter).not.toContain('Body only');
    expect(frontmatter).not.toMatch(/operatingInstructions:/);
  });

  it('rejects bodies over the shared bound on serialize and parse', () => {
    const over = 'x'.repeat(OPERATING_INSTRUCTIONS_MAX_LENGTH + 1);
    expect(() =>
      serializeDeck({ ...DECK, operatingInstructions: over }),
    ).toThrow(/operatingInstructions/);
    const raw = serializeDeck({
      ...DECK,
      operatingInstructions: 'x'.repeat(OPERATING_INSTRUCTIONS_MAX_LENGTH),
    });
    expect(() => parseDeckMarkdown(`${raw}y`)).toThrow(/operatingInstructions/);
  });

  it('fails closed on malformed frontmatter', () => {
    expect(() => parseDeckMarkdown('---\n: not yaml: [\n---\nbody\n')).toThrow();
    expect(() =>
      parseDeckMarkdown('no frontmatter here, just a body\n'),
    ).toThrow();
  });

  it('still parses legacy v1 JSON with an empty body', () => {
    const raw = `${JSON.stringify(DECK, null, 2)}\n`;
    expect(parseDeckJson(raw)).toEqual({ ...DECK, operatingInstructions: '' });
  });
});
