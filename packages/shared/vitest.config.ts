import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { useIsolatedAgentDeckHome, useUnreachableDeckPorts } from '../../scripts/vitest/test-home.mjs';

// Fresh store root per run — tests must never write into the real ~/.agent-deck.
const agentDeckHome = useIsolatedAgentDeckHome('shared');
// No test may reach the developer's own deck through a default port.
const deckPorts = useUnreachableDeckPorts();

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: [path.resolve(__dirname, '../../scripts/vitest/global-setup.mjs')],
    env: {
      AGENT_DECK_HOME: agentDeckHome,
      ...deckPorts,
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
