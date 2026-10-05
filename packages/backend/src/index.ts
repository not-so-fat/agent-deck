import { createServer } from './server';
import { installFatalHandlers, logFatalAndExit, logProcessStart } from './lib/fatal';
import { installGracefulShutdown, trackInFlightRequests } from './lib/graceful-shutdown';
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

    await server.listen({ port, host });

    console.log(`🚀 Agent Deck Backend server running on http://${host}:${port}`);
    console.log(`📊 Health check: http://${host}:${port}/health`);

    // Tracked drain shared with the shutdown test fixture: server.close()
    // stops accepting and releases the listener, and the tracked in-flight
    // request is additionally awaited so process exit cannot precede the
    // response even if server.close() resolves early.
    const waitForDrain = trackInFlightRequests(server);
    installGracefulShutdown({
      label: 'backend',
      close: async () => {
        const closing = server.close();
        await waitForDrain();
        await closing;
      },
    });
  } catch (error) {
    // logFatalAndExit writes the message, the cause and a hint, synchronously.
    logFatalAndExit('backend', `startup failed before listening on ${host}:${port}`, error);
  }
}

start();
