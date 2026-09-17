import { createServer } from './server';
import { installFatalHandlers, logExit, logFatalAndExit, logProcessStart } from './lib/fatal';

// The supervisor only sees this process's exit code, so every way out of here
// has to name itself in the log first.
installFatalHandlers('backend');

async function start() {
  const port = process.env.PORT ? parseInt(process.env.PORT) : 8000;
  const host = process.env.HOST || '127.0.0.1';

  logProcessStart('backend', { host, port });

  try {
    const server = await createServer();

    await server.listen({ port, host });

    console.log(`🚀 Agent Deck Backend server running on http://${host}:${port}`);
    console.log(`📊 Health check: http://${host}:${port}/health`);

    // Graceful shutdown
    const shutdown = async (signal: NodeJS.Signals) => {
      logExit('backend', 0, `signal ${signal}`);
      console.log('\n🛑 Shutting down server...');
      try {
        await server.close();
      } catch (error) {
        logFatalAndExit('backend', `shutdown after ${signal} failed`, error);
      }
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    // logFatalAndExit writes the message, the cause and a hint, synchronously.
    logFatalAndExit('backend', `startup failed before listening on ${host}:${port}`, error);
  }
}

start();
