import { describe, expect, it } from 'vitest';

import { CLI_DEFAULT_BACKEND_PORT, CLI_DEFAULT_MCP_PORT } from './defaults';
import {
  CLI_DEFAULT_BACKEND_PORT as MIRRORED_BACKEND_PORT,
  CLI_DEFAULT_MCP_PORT as MIRRORED_MCP_PORT,
} from '../../../scripts/vitest/deck-default-ports.mjs';
import { UNREACHABLE_DECK_PORTS } from '../../../scripts/vitest/test-home.mjs';

/**
 * `stop`/`status` resolve ports from the environment and `runStop` kills
 * whatever listens on them, so port isolation — not home isolation — is what
 * keeps a test run off the developer's own deck (NOT-135).
 */
describe('no test run can reach the real deck', () => {
  it('keeps the mirrored vitest constants in step with the CLI defaults', () => {
    // The vitest setup is plain ESM and cannot import this module, so the
    // values are duplicated. This test is what makes that duplication safe.
    expect(MIRRORED_BACKEND_PORT).toBe(CLI_DEFAULT_BACKEND_PORT);
    expect(MIRRORED_MCP_PORT).toBe(CLI_DEFAULT_MCP_PORT);
  });

  it('never defaults a test process to the real deck ports', () => {
    expect(Number(UNREACHABLE_DECK_PORTS.AGENT_DECK_BACKEND_PORT)).not.toBe(
      CLI_DEFAULT_BACKEND_PORT,
    );
    expect(Number(UNREACHABLE_DECK_PORTS.AGENT_DECK_MCP_PORT)).not.toBe(CLI_DEFAULT_MCP_PORT);
  });

  it('is actually wired into the environment this test is running in', () => {
    // The live assertion: if a vitest.config stops applying the pins, this
    // fails here rather than the next test silently stopping the real deck.
    expect(Number(process.env.AGENT_DECK_BACKEND_PORT)).not.toBe(CLI_DEFAULT_BACKEND_PORT);
    expect(Number(process.env.AGENT_DECK_MCP_PORT)).not.toBe(CLI_DEFAULT_MCP_PORT);
  });
});
