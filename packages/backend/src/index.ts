import { createServer } from './server';
import { installFatalHandlers, logFatalAndExit, logProcessStart } from './lib/fatal';
import { createTrackedClose, installGracefulShutdown } from './lib/graceful-shutdown';
import { createStorageFailureServer, shouldServeStorageFailure } from './server/degraded';

// The supervisor only sees this process's exit code, so every way out of here
// has to name itself in the log first.
installFatalHandlers('backend');

async function start() {
  const port = process.env.PORT ? parseInt(process.env.PORT) : 8000;
  const host = process.env.HOST || '127.0.0.1';

  logProcessStart('backend', { host, port });

  try {
    let server;
    try {
      server = await createServer();
    } catch (error) {
      if (!shouldServeStorageFailure(error)) throw error;
      server = createStorageFailureServer(error);
    }

    // Fastify refuses addHook once listening, so the in-flight tracking hooks
    // must be registered before listen().
    const close = createTrackedClose(server);

    await server.listen({ port, host });

    console.log(`🚀 Agent Deck Backend server running on http://${host}:${port}`);
    console.log(`📊 Health check: http://${host}:${port}/health`);

    // Production close shared with the shutdown test fixture
    // (createTrackedClose): stop accepting, drain the tracked in-flight
    // request, then release the listener.
    installGracefulShutdown({ label: 'backend', close });
  } catch (error) {
    // logFatalAndExit writes the message, the cause and a hint, synchronously.
    logFatalAndExit('backend', `startup failed before listening on ${host}:${port}`, error);
  }
}

start();
