import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A test run must never stop the developer's own Agent Deck. Home isolation is
 * not enough on its own: `stop`/`status` resolve ports from the environment and
 * fall back to killing whatever listens on 1111/1110, so a single unpinned env
 * var reaches the real daemon no matter which home the test used.
 *
 * This canary is deliberately independent of how any test is written — it
 * records the real deck's pids before the suite and fails the run if they are
 * gone afterwards, so a new test that bypasses the harness is caught too.
 */
export const REAL_AGENT_DECK_HOME = path.join(os.homedir(), '.agent-deck');

/**
 * Override for this guard's own self-test only: a canary nobody has watched
 * fail is not a guard. Never set it in a normal run.
 */
function canaryHome() {
  return process.env.AGENT_DECK_CANARY_HOME?.trim() || REAL_AGENT_DECK_HOME;
}

export function readRealDeckPids(home = canaryHome()) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(home, 'run.json'), 'utf8'));
    return [
      ['supervisor', state.cliPid],
      ['backend', state.backendPid],
      ['mcp', state.mcpPid],
    ].filter(([, pid]) => Number.isInteger(pid) && pid > 0);
  } catch {
    // No deck running, or no run.json — nothing to protect.
    return [];
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    return error?.code === 'EPERM';
  }
}

export function deadAmong(recorded) {
  return recorded.filter(([, pid]) => !isAlive(pid));
}

export function assertRealDeckSurvived(recorded) {
  const dead = deadAmong(recorded);
  if (dead.length === 0) {
    return;
  }
  const who = dead.map(([label, pid]) => `${label} (pid ${pid})`).join(', ');
  throw new Error(
    `This test run stopped the developer's real Agent Deck: ${who}.\n` +
      'A test must never reach ~/.agent-deck. Pin AGENT_DECK_HOME *and* both of\n' +
      'AGENT_DECK_BACKEND_PORT / AGENT_DECK_MCP_PORT to this run\'s own reserved ports,\n' +
      'and only signal pids the test itself spawned.',
  );
}
