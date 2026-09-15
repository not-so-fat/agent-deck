import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { useIsolatedAgentDeckHome } from '../../scripts/vitest/test-home.mjs';

// Fresh store root per run — tests must never write into the real ~/.agent-deck.
const agentDeckHome = useIsolatedAgentDeckHome('shared');

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: [path.resolve(__dirname, '../../scripts/vitest/global-setup.mjs')],
    env: {
      AGENT_DECK_HOME: agentDeckHome,
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
