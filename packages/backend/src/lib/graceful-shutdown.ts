import type { FastifyInstance } from 'fastify';

import type { FatalLabel } from './fatal';

type ShutdownProcess = Pick<NodeJS.Process, 'once' | 'removeListener' | 'exit'>;

export type GracefulShutdownOptions = {
  label: FatalLabel;
  close: () => Promise<void>;
  timeoutMs?: number;
  processRef?: ShutdownProcess;
};

function writeJsonLog(
  level: 'info' | 'error',
  event: string,
  fields: Record<string, unknown>,
): void {
  process.stdout.write(`${JSON.stringify({ level, time: new Date().toISOString(), event, ...fields })}\n`);
}

/**
 * Count live HTTP requests so the shutdown close can wait for the tracked
 * in-flight request to respond before the process exits. server.close()
 * alone stops accepting and releases the listener but CI showed it can
 * resolve while a live handler is still running (client ECONNRESET,
 * shutdown_complete ~1ms after shutdown_started), so production and the
 * shutdown test share this instead of each open-coding its own counter.
 */
export function trackInFlightRequests(server: FastifyInstance): () => Promise<void> {
  let inFlight = 0;
  let notifyDrained: (() => void) | null = null;
  server.addHook('onRequest', async () => {
    inFlight += 1;
  });
  server.addHook('onResponse', async () => {
    inFlight -= 1;
    if (inFlight === 0) {
      const notify = notifyDrained;
      notifyDrained = null;
      notify?.();
    }
  });
  return () => {
    if (inFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      notifyDrained = resolve;
    });
  };
}

/** Stop accepting work, drain active requests, and exit before the deadline. */
export function installGracefulShutdown(options: GracefulShutdownOptions): () => void {
  const processRef = options.processRef ?? process;
  // Leave one second for the container runtime to reap the process before a
  // ten-second stop grace period expires.
  const timeoutMs = options.timeoutMs ?? 9_000;
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    writeJsonLog('info', 'shutdown_started', { service: options.label, signal });

    const deadline = setTimeout(() => {
      writeJsonLog('error', 'shutdown_timeout', { service: options.label, signal, timeoutMs });
      processRef.exit(1);
    }, timeoutMs);
    deadline.unref?.();

    try {
      await options.close();
      clearTimeout(deadline);
      writeJsonLog('info', 'shutdown_complete', { service: options.label, signal, exitCode: 0 });
      processRef.exit(0);
    } catch (error) {
      clearTimeout(deadline);
      writeJsonLog('error', 'shutdown_failed', {
        service: options.label,
        signal,
        message: error instanceof Error ? error.message : String(error),
      });
      processRef.exit(1);
    }
  };

  const onSigint = () => void shutdown('SIGINT');
  const onSigterm = () => void shutdown('SIGTERM');
  processRef.once('SIGINT', onSigint);
  processRef.once('SIGTERM', onSigterm);

  return () => {
    processRef.removeListener('SIGINT', onSigint);
    processRef.removeListener('SIGTERM', onSigterm);
  };
}
