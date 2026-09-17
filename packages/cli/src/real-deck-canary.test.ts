import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  assertRealDeckSurvived,
  deadAmong,
  isAlive,
  readRealDeckPids,
} from '../../../scripts/vitest/real-deck-canary.mjs';

/** A pid that certainly exited: spawn something trivial and reuse its pid. */
function deadPid(): number {
  const done = spawnSync(process.execPath, ['-e', '0']);
  return done.pid as number;
}

describe('real-deck canary', () => {
  it('treats this process as alive and an exited child as dead', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(deadPid())).toBe(false);
  });

  it('passes silently when every recorded pid is still alive', () => {
    expect(() => assertRealDeckSurvived([['supervisor', process.pid]])).not.toThrow();
  });

  it('names what died, so the failure points at the cause', () => {
    const gone = deadPid();
    expect(() => assertRealDeckSurvived([['backend', gone]])).toThrow(
      new RegExp(`stopped the developer's real Agent Deck: backend \\(pid ${gone}\\)`),
    );
  });

  it('reports every dead pid, not just the first', () => {
    expect(deadAmong([['backend', deadPid()], ['mcp', deadPid()], ['supervisor', process.pid]])).toHaveLength(2);
  });

  it('protects nothing when no deck is running', () => {
    expect(readRealDeckPids('/nonexistent-agent-deck-home')).toEqual([]);
    expect(() => assertRealDeckSurvived([])).not.toThrow();
  });
});
