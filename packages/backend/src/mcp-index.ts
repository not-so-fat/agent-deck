import { AgentDeckMCPServer } from './mcp-server';
import { installFatalHandlers, logExit, logFatalAndExit, logProcessStart } from './lib/fatal';

installFatalHandlers('mcp');

async function startMCPServer() {
  const port = process.env.AGENT_DECK_MCP_PORT
    ? Number.parseInt(process.env.AGENT_DECK_MCP_PORT, 10)
    : 3001;
  const host = process.env.AGENT_DECK_MCP_HOST ?? '127.0.0.1';
  const backendUrl = process.env.AGENT_DECK_BACKEND_URL ?? 'http://127.0.0.1:8000';

  logProcessStart('mcp', { host, port, backendUrl });

  try {
    console.log('🚀 Starting Agent Deck MCP Server...');

    const mcpServer = new AgentDeckMCPServer(port, backendUrl, undefined, host);
    await mcpServer.start();

    console.log('✅ Agent Deck MCP Server is ready to accept connections');

    // Keep the process alive
    const shutdown = async (signal: NodeJS.Signals) => {
      logExit('mcp', 0, `signal ${signal}`);
      console.log('\n🛑 Shutting down MCP server...');
      try {
        await mcpServer.stop();
      } catch (error) {
        logFatalAndExit('mcp', `shutdown after ${signal} failed`, error);
      }
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    // logFatalAndExit writes the message, the cause and a hint, synchronously.
    logFatalAndExit('mcp', `startup failed before listening on ${host}:${port}`, error);
  }
}

startMCPServer();
