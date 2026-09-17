import fs from 'node:fs';

/**
 * A child that dies during startup must say why *before* it exits: the
 * supervisor only ever sees an exit code, so an unexplained `process.exit(1)`
 * leaves no diagnostic anywhere. Writes go straight to fd 2 (synchronously) so
 * they survive the immediate exit.
 */
export type FatalLabel = 'backend' | 'mcp';

export function describeFatalError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const head = code ? `${error.name} [${code}]: ${error.message}` : `${error.name}: ${error.message}`;
    return error.stack ? `${head}\n${error.stack}` : head;
  }
  return String(error);
}

/** Actionable hints for the failures that actually take this process down. */
export function fatalHint(error: unknown): string | null {
  const detail = error instanceof Error ? `${error.message} ${(error as NodeJS.ErrnoException).code ?? ''}` : String(error);

  if (detail.includes('NODE_MODULE_VERSION') || detail.includes('ERR_DLOPEN_FAILED')) {
    return [
      'A native module was built for a different Node.js version than the one running this process.',
      `  running node ${process.version} (NODE_MODULE_VERSION ${process.versions.modules})`,
      '  Fix: run agent-deck with the Node version you installed it under, or rebuild:',
      '    npm rebuild better-sqlite3',
      '    agent-deck doctor',
    ].join('\n');
  }
  if (detail.includes('EADDRINUSE')) {
    return [
      'The configured port is already taken by another process.',
      '  Fix: agent-deck stop  (or free the port: lsof -ti :<port> -sTCP:LISTEN | xargs kill)',
    ].join('\n');
  }
  if (detail.includes('SQLITE_') || detail.includes('database is locked')) {
    return 'The Agent Deck database could not be opened. Check ~/.agent-deck/agent_deck.db permissions and that no other instance holds it.';
  }
  if (detail.includes('EACCES') || detail.includes('EPERM')) {
    return 'Permission denied on a file or port Agent Deck needs. Check ownership of ~/.agent-deck.';
  }
  return null;
}

export function formatFatalLines(label: FatalLabel, phase: string, error: unknown): string[] {
  const lines = [
    `[agent-deck] ${label} exiting (code 1): ${phase}`,
    `[agent-deck] ${label} pid ${process.pid} node ${process.version} (NODE_MODULE_VERSION ${process.versions.modules})`,
    `[agent-deck] ${label} cause: ${describeFatalError(error)}`,
  ];
  const hint = fatalHint(error);
  if (hint) {
    lines.push(...hint.split('\n').map((line) => `[agent-deck] ${label} hint: ${line}`));
  }
  return lines;
}

/**
 * Synchronous write to fd 2 — process.exit() must not be able to drop it.
 * `fd` is a seam for tests; production always writes to stderr.
 */
export function writeLogSync(text: string, fd = 2): void {
  const buffer = Buffer.from(text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') {
        continue;
      }
      // Nothing left to try — never let logging mask the original failure.
      return;
    }
  }
}

export function logFatal(label: FatalLabel, phase: string, error: unknown, fd = 2): void {
  const timestamp = new Date().toISOString();
  writeLogSync(
    formatFatalLines(label, phase, error)
      .map((line) => `${timestamp} ${line}`)
      .join('\n'),
    fd,
  );
}

export function logFatalAndExit(label: FatalLabel, phase: string, error: unknown): never {
  logFatal(label, phase, error);
  process.exit(1);
}

/** Startup fingerprint — makes "which Node ran this?" answerable after the fact. */
export function logProcessStart(
  label: FatalLabel,
  fields: Record<string, string | number>,
  fd = 2,
): void {
  const detail = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  writeLogSync(
    `${new Date().toISOString()} [agent-deck] ${label} starting pid=${process.pid} node=${process.version} modules=${process.versions.modules} ${detail}`,
    fd,
  );
}

export function logExit(label: FatalLabel, exitCode: number, reason: string, fd = 2): void {
  writeLogSync(
    `${new Date().toISOString()} [agent-deck] ${label} exiting (code ${exitCode}): ${reason}`,
    fd,
  );
}

/**
 * Crashes outside the startup try/catch (a rejected background promise, a throw
 * from a route) otherwise exit non-zero with only Node's default trace — and
 * nothing that names Agent Deck to grep for.
 */
export function installFatalHandlers(label: FatalLabel): void {
  process.on('uncaughtException', (error) => {
    logFatalAndExit(label, 'uncaught exception', error);
  });
  process.on('unhandledRejection', (reason) => {
    logFatalAndExit(label, 'unhandled promise rejection', reason);
  });
}
