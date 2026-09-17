import { afterEach, describe, expect, it } from 'vitest';

import { resolveStopSource } from './stop';

describe('stop source attribution', () => {
  afterEach(() => {
    delete process.env.AGENT_DECK_STOP_SOURCE;
    delete process.env.AGENT_DECK_STOP_DETAIL;
  });

  it('defaults to the CLI command', () => {
    expect(resolveStopSource()).toEqual({ source: 'agent-deck stop', detail: undefined });
  });

  it('takes the caller-supplied source', () => {
    expect(resolveStopSource({ source: 'api', detail: 'dashboard restart' })).toEqual({
      source: 'api',
      detail: 'dashboard restart',
    });
  });

  it('lets a wrapper (menubar, launchd) identify itself through the environment', () => {
    process.env.AGENT_DECK_STOP_SOURCE = 'menubar';
    process.env.AGENT_DECK_STOP_DETAIL = 'Quit Agent Deck';
    expect(resolveStopSource()).toEqual({ source: 'menubar', detail: 'Quit Agent Deck' });
  });

  it('ignores a blank environment override', () => {
    process.env.AGENT_DECK_STOP_SOURCE = '   ';
    expect(resolveStopSource().source).toBe('agent-deck stop');
  });
});
