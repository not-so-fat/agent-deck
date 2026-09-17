import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { useIsolatedAgentDeckHome, useUnreachableDeckPorts } from '../../scripts/vitest/test-home.mjs';

// Fresh store root per run — tests must never write into the real ~/.agent-deck.
const agentDeckHome = useIsolatedAgentDeckHome('backend');
// No test may reach the developer's own deck through a default port.
const deckPorts = useUnreachableDeckPorts();

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // These are integration-weight tests — real SQLite files, real store
    // writes, real HTTP servers — not unit tests. vitest's 5s default is
    // calibrated for the latter and leaves no headroom on a 2-core CI runner
    // that runs this suite ~10x slower than a dev laptop.
    testTimeout: 20000,
    hookTimeout: 20000,
    globalSetup: [path.resolve(__dirname, '../../scripts/vitest/global-setup.mjs')],
    env: {
      AGENT_DECK_HOME: agentDeckHome,
      ...deckPorts,
      AGENT_DECK_MCP_SKIP_GRANT_AUTH: '1',
      AGENT_DECK_MCP_SKIP_ADMIN_CHECK: '1',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
      ],
    },
  },
});
