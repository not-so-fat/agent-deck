import { describe, expect, it } from 'vitest';

import { DECK_SWITCH_ELICITATION_TIMEOUT_MS } from './elicitation';

describe('DECK_SWITCH_ELICITATION_TIMEOUT_MS (NOT-636)', () => {
  it('gives the human 5 minutes to answer the switch_deck approval form', () => {
    expect(DECK_SWITCH_ELICITATION_TIMEOUT_MS).toBe(300_000);
  });
});
