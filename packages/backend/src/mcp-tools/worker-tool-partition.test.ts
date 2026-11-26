import { describe, expect, it } from 'vitest';

import { WORKER_PROFILES, type RunToolsProfile } from '../agent-run';
import { listToolNamesForProfile } from './register';

/**
 * NOT-669 repair: every registered Agent Deck MCP tool is classified in the
 * shared profile definition. Enforcement fails closed at runtime (an
 * unlisted tool is denied), and this test fails at authoring time —
 * registering a new tool without adding it to the allow or deny sets of
 * both profiles breaks the suite until it is classified.
 */
describe('worker tool partition (NOT-669 repair)', () => {
  it('every registered tool is allowed xor denied in both profiles', () => {
    // The legacy profile lists everything registered on an assigned
    // session; request_deck_assignment only exists on unassigned ones.
    const names = new Set([...listToolNamesForProfile('legacy'), 'request_deck_assignment']);
    expect(names.size).toBeGreaterThan(30);
    for (const profile of ['readonly', 'edit'] satisfies RunToolsProfile[]) {
      const { mcpAllowTools, mcpDenyTools } = WORKER_PROFILES[profile];
      for (const name of names) {
        const allowed = mcpAllowTools.includes(name);
        const denied = mcpDenyTools.includes(name);
        expect(
          allowed !== denied,
          `${profile} ${name}: allow=${allowed} deny=${denied} (classify it in profiles.ts)`,
        ).toBe(true);
      }
    }
  });
});
