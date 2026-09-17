import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { describeFatalError, fatalHint, formatFatalLines, logExit, logFatal, logProcessStart } from './fatal';

describe('fatal logging', () => {
  it('keeps the error name, code and stack', () => {
    const error = Object.assign(new Error('boom'), { code: 'ERR_DLOPEN_FAILED' });
    const described = describeFatalError(error);
    expect(described).toContain('Error [ERR_DLOPEN_FAILED]: boom');
    expect(described).toContain('fatal.test.ts');
  });

  it('describes a thrown non-error', () => {
    expect(describeFatalError('just a string')).toBe('just a string');
  });

  /** The real NOT-135 exit-1: better-sqlite3 built against a different Node. */
  it('explains a native module ABI mismatch', () => {
    const error = new Error(
      "The module '/x/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 147.",
    );
    const hint = fatalHint(error);
    expect(hint).toContain('native module was built for a different Node.js version');
    expect(hint).toContain('npm rebuild better-sqlite3');
    expect(hint).toContain(process.version);
  });

  it('explains a taken port', () => {
    expect(fatalHint(Object.assign(new Error('listen EADDRINUSE :::1111'), { code: 'EADDRINUSE' }))).toContain(
      'agent-deck stop',
    );
  });

  it('has no hint for an unrecognised failure', () => {
    expect(fatalHint(new Error('something new'))).toBeNull();
  });

  it('names the process, the phase and the running Node in the exit lines', () => {
    const lines = formatFatalLines('backend', 'startup failed before listening on 127.0.0.1:1111', new Error('boom'));
    expect(lines[0]).toBe('[agent-deck] backend exiting (code 1): startup failed before listening on 127.0.0.1:1111');
    expect(lines[1]).toContain(`node ${process.version}`);
    expect(lines[2]).toContain('cause: Error: boom');
  });

  /**
   * The child's stdio is a plain file (backend.log), so a synchronous write is
   * what makes the reason survive the process.exit(1) on the next line.
   */
  it('writes the reason synchronously, the way the redirected child log receives it', () => {
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-fatal-')), 'backend.log');
    const fd = fs.openSync(logPath, 'a');
    try {
      logProcessStart('backend', { host: '127.0.0.1', port: 1111 }, fd);
      logFatal('backend', 'startup failed before listening on 127.0.0.1:1111', new Error('database is locked'), fd);
      logExit('backend', 0, 'signal SIGTERM', fd);
      // No flush, no close: the bytes are already on disk.
      const written = fs.readFileSync(logPath, 'utf8');
      expect(written).toContain('[agent-deck] backend starting pid=');
      expect(written).toContain('[agent-deck] backend exiting (code 1): startup failed before listening');
      expect(written).toContain('database is locked');
      expect(written).toContain('[agent-deck] backend exiting (code 0): signal SIGTERM');
    } finally {
      fs.closeSync(fd);
      fs.rmSync(path.dirname(logPath), { recursive: true, force: true });
    }
  });
});
