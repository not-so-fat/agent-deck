import path from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { useIsolatedAgentDeckHome, useUnreachableDeckPorts } from '../../scripts/vitest/test-home.mjs'

// Fresh store root per run — tests must never write into the real ~/.agent-deck.
const agentDeckHome = useIsolatedAgentDeckHome('web')
// No test may reach the developer's own deck through a default port.
const deckPorts = useUnreachableDeckPorts()

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom"],
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globalSetup: [path.resolve(__dirname, '../../scripts/vitest/global-setup.mjs')],
    env: {
      AGENT_DECK_HOME: agentDeckHome,
      ...deckPorts,
    },
    globals: true,
  },
})
