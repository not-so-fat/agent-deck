import { describe, expect, it } from 'vitest';

import { AGENT_DECK_PLAYBOOK_PIN_HEADER } from '../constants/client-scope';
import {
  AGENT_DECK_PLAYBOOK_PIN_ENV,
  formatPlaybookPin,
  normalizePlaybookPin,
} from './playbook-pin';

const VERSION = '123e4567-e89b-42d3-a456-426614174000';

describe('playbook pin value (NOT-537)', () => {
  it('defines the launch header and env var names', () => {
    expect(AGENT_DECK_PLAYBOOK_PIN_HEADER).toBe('x-agent-deck-playbook-pin');
    expect(AGENT_DECK_PLAYBOOK_PIN_ENV).toBe('AGENT_DECK_PLAYBOOK_PIN');
  });

  it('parses a well-formed pin', () => {
    expect(normalizePlaybookPin(`pb_my_playbook=${VERSION}`)).toEqual({
      playbookId: 'pb_my_playbook',
      versionId: VERSION,
    });
  });

  it('trims surrounding whitespace', () => {
    expect(normalizePlaybookPin(`  pb_my_playbook=${VERSION}  `)).toEqual({
      playbookId: 'pb_my_playbook',
      versionId: VERSION,
    });
  });

  it('drops malformed values instead of coercing them', () => {
    expect(normalizePlaybookPin('just-a-string')).toBeNull();
    expect(normalizePlaybookPin(`pb_my_playbook=`)).toBeNull();
    expect(normalizePlaybookPin(`=${VERSION}`)).toBeNull();
    expect(normalizePlaybookPin(`pb_my_playbook=${VERSION}=extra`)).toBeNull();
    expect(normalizePlaybookPin('')).toBeNull();
    expect(normalizePlaybookPin('   ')).toBeNull();
    expect(normalizePlaybookPin(null)).toBeNull();
    expect(normalizePlaybookPin(undefined)).toBeNull();
    expect(normalizePlaybookPin(123)).toBeNull();
    // Free text and paths can never become a pin.
    expect(normalizePlaybookPin('Fix the login bug')).toBeNull();
    expect(normalizePlaybookPin('not-so-fat/agent_deck')).toBeNull();
  });

  it('rejects a playbook id outside pb_<slug> and a non-UUID version', () => {
    expect(normalizePlaybookPin(`My Playbook=${VERSION}`)).toBeNull();
    expect(normalizePlaybookPin(`other-id=${VERSION}`)).toBeNull();
    expect(normalizePlaybookPin('pb_my_playbook=not-a-uuid')).toBeNull();
    expect(normalizePlaybookPin('pb_my_playbook=123')).toBeNull();
  });

  it('formats the canonical header value', () => {
    expect(formatPlaybookPin({ playbookId: 'pb_my_playbook', versionId: VERSION })).toBe(
      `pb_my_playbook=${VERSION}`,
    );
  });
});
