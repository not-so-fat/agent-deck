import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A stale better-sqlite3 prebuild after a Node major upgrade is not a real
 * Node-version limitation — `verifySqliteNative` must try one `npm rebuild`
 * before reporting a failure, and the fallback hint must not hardcode a
 * monorepo-only `-w @agent-deck/backend` flag that fails for every other
 * install (global npm, Homebrew, the managed installer).
 */
describe('verifySqliteNative', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  const abiMismatchError = () =>
    new Error(
      "The module '/some/path/better_sqlite3.node' was compiled against a different Node.js " +
        'version using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 147.',
    );

  class WorkingDatabase {
    close() {}
  }

  it('reports success without attempting a rebuild when the native module loads fine', async () => {
    const execSync = vi.fn();
    vi.doMock('node:child_process', () => ({ execSync }));

    const { verifySqliteNative } = await import('./node-runtime');
    expect(verifySqliteNative(() => WorkingDatabase)).toEqual({ ok: true });
    expect(execSync).not.toHaveBeenCalled();
  });

  it('rebuilds once and succeeds when the retry loads cleanly', async () => {
    let attempt = 0;
    const execSync = vi.fn(() => {
      attempt += 1;
    });
    vi.doMock('node:child_process', () => ({ execSync }));

    class FlakyDatabase {
      constructor() {
        if (attempt === 0) throw abiMismatchError();
      }
      close() {}
    }

    const { verifySqliteNative } = await import('./node-runtime');
    expect(verifySqliteNative(() => FlakyDatabase)).toEqual({ ok: true });
    expect(execSync).toHaveBeenCalledTimes(1);
    expect(execSync.mock.calls[0][0]).toBe('npm rebuild better-sqlite3');
  });

  it('falls back to an accurate, install-agnostic hint when the rebuild does not fix it', async () => {
    const execSync = vi.fn(() => {
      throw new Error('npm rebuild failed');
    });
    vi.doMock('node:child_process', () => ({ execSync }));

    class BrokenDatabase {
      constructor() {
        throw abiMismatchError();
      }
      close() {}
    }

    const { verifySqliteNative } = await import('./node-runtime');
    const result = verifySqliteNative(() => BrokenDatabase);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain('-w @agent-deck/backend');
      expect(result.message).toContain('npm rebuild better-sqlite3');
    }
    expect(execSync).toHaveBeenCalledTimes(1);
  });

  it('does not attempt a rebuild for a failure unrelated to the native ABI', async () => {
    const execSync = vi.fn();
    vi.doMock('node:child_process', () => ({ execSync }));

    class UnrelatedFailureDatabase {
      constructor() {
        throw new Error('ENOENT: some other loader problem');
      }
      close() {}
    }

    const { verifySqliteNative } = await import('./node-runtime');
    const result = verifySqliteNative(() => UnrelatedFailureDatabase);
    expect(result.ok).toBe(false);
    expect(execSync).not.toHaveBeenCalled();
  });
});
