import { describe, expect, it } from 'vitest';

import {
  UNASSIGNED_DECK_MESSAGE,
  unassignedDeckBinding,
  unassignedDeckMessage,
} from './mcp-unassigned';

describe('unassigned deck message (NOT-604, NOT-606)', () => {
  it('is the plain message with no reasons', () => {
    expect(unassignedDeckMessage()).toBe(UNASSIGNED_DECK_MESSAGE);
    expect(unassignedDeckMessage(undefined, undefined)).toBe(UNASSIGNED_DECK_MESSAGE);
    expect(unassignedDeckBinding()).toEqual({
      deck: null,
      error_code: 'GRANT_REQUIRED',
      message: UNASSIGNED_DECK_MESSAGE,
    });
  });

  it('names the deleted folder deck (NOT-604)', () => {
    expect(unassignedDeckMessage('gone')).toBe(
      `The folder was assigned to deck "gone", which no longer exists. ${UNASSIGNED_DECK_MESSAGE}`,
    );
    expect(unassignedDeckMessage('  ')).toBe(UNASSIGNED_DECK_MESSAGE);
  });

  it('names a deleted default deck (NOT-606)', () => {
    expect(unassignedDeckMessage(undefined, { kind: 'missing', deckName: 'alpha' })).toBe(
      `The default deck "alpha" no longer exists. ${UNASSIGNED_DECK_MESSAGE}`,
    );
    expect(
      unassignedDeckBinding(undefined, { kind: 'missing', deckName: 'alpha' }),
    ).toMatchObject({ deck: null, error_code: 'GRANT_REQUIRED' });
    // Blank names are dropped, never rendered.
    expect(unassignedDeckMessage(undefined, { kind: 'missing', deckName: '  ' })).toBe(
      UNASSIGNED_DECK_MESSAGE,
    );
  });

  it('names an unreadable default-deck.json (NOT-606)', () => {
    const path = '/home/user/.agent-deck/default-deck.json';
    expect(unassignedDeckMessage(undefined, { kind: 'unreadable', path })).toBe(
      `The default deck file is unreadable: ${path}. ${UNASSIGNED_DECK_MESSAGE}`,
    );
  });

  it('names both the folder deck and the default when both are broken (NOT-606)', () => {
    expect(
      unassignedDeckMessage('gone', { kind: 'missing', deckName: 'alpha' }),
    ).toBe(
      'The folder was assigned to deck "gone", which no longer exists. ' +
        `The default deck "alpha" no longer exists. ${UNASSIGNED_DECK_MESSAGE}`,
    );
  });
});
