import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * NOT-135: the acceptance criteria are about what an operator can read *after*
 * the fact, so these drive the real `agent-deck start` / `agent-deck status`
 * processes and assert the files they leave behind. Nothing here reimplements
 * the supervisor's decisions.
 */
const CLI_PACKAGE = path.resolve(__dirname, '..');
const BACKEND_PACKAGE = path.resolve(CLI_PACKAGE, '..', 'backend');
const CLI_ENTRY = path.join(CLI_PACKAGE, 'dist', 'bin.js');

/** Newest mtime under `dir`, or null when it is missing or empty. */
function newestMtime(dir: string, isIgnored: (file: string) => boolean = () => false): number | null {
  let newest: number | null = null;
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') {
          walk(full);
        }
        continue;
      }
      if (!entry.isFile() || isIgnored(full)) {
        continue;
      }
      const { mtimeMs } = fs.statSync(full);
      if (newest === null || mtimeMs > newest) {
        newest = mtimeMs;
      }
    }
  };
  walk(dir);
  return newest;
}

/**
 * These tests spawn the built CLI and the built backend, so a stale dist would
 * silently test the previous build. Turbo runs `build` before `test`; a bare
 * `vitest` inside the package does not.
 */
function assertFreshBuild(packageDir: string): void {
  const dist = newestMtime(path.join(packageDir, 'dist'));
  if (dist === null) {
    throw new Error(`${packageDir}/dist is missing — run npm run build before this suite.`);
  }
  const src = newestMtime(path.join(packageDir, 'src'), (file) => file.endsWith('.test.ts'));
  if (src !== null && src > dist) {
    throw new Error(`${packageDir}/dist is older than its sources — run npm run build before this suite.`);
  }
}

function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        port,
        release: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe('NOT-135 — a failed start is recoverable from the logs it leaves', () => {
  let home: string;

  beforeEach(() => {
    assertFreshBuild(CLI_PACKAGE);
    assertFreshBuild(BACKEND_PACKAGE);
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-start-fail-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
      encoding: 'utf8',
      timeout: 90_000,
      env: {
        ...process.env,
        AGENT_DECK_HOME: home,
        AGENT_DECK_HOST: '127.0.0.1',
        // Keep the run off the network; an update check is not under test.
        AGENT_DECK_NO_UPDATE_CHECK: '1',
      },
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  function readLog(name: 'supervisor' | 'backend'): string {
    try {
      return fs.readFileSync(path.join(home, 'logs', `${name}.log`), 'utf8');
    } catch {
      return '';
    }
  }

  it('a backend that dies during startup writes its reason to backend.log, supervisor.log and status', async () => {
    // A directory where SQLite expects a file: the backend throws while opening
    // the store, before it ever listens — the shape of the 10:43:41 exit 1.
    fs.mkdirSync(path.join(home, 'agent_deck.db'));

    const backendPort = await reserveFreePort();
    const mcpPort = await reserveFreePort();
    const start = runCli([
      'start',
      '--daemon',
      '--no-ui',
      '--no-open',
      '--port',
      String(backendPort),
      '--mcp-port',
      String(mcpPort),
    ]);

    expect(start.status).toBe(1);

    // 1. The child says why before it exits.
    const backendLog = readLog('backend');
    expect(backendLog).toContain('[agent-deck] backend exiting (code 1)');
    expect(backendLog).toContain('[agent-deck] backend cause:');

    // 2. The supervisor brings that reason to the operator's file.
    const supervisorLog = readLog('supervisor');
    expect(supervisorLog).toContain('[agent-deck] backend exited (code 1)');
    expect(supervisorLog).toContain('backend.log| ');
    expect(supervisorLog).toContain('[agent-deck] backend cause:');
    expect(supervisorLog).toMatch(/supervisor shutting down \(exit 1, reason: backend exited \(code 1\)\)/);

    // 3. `agent-deck status` answers "why did it stop?" without opening a log.
    const status = runCli(['status']);
    expect(status.stdout).toContain('Last stop');
    expect(status.stdout).toContain('backend exited (code 1)');
  }, 120_000);

  it('a port conflict recorded before anything spawns still reaches supervisor.log and status', async () => {
    const taken = await occupyPort();
    const mcpPort = await reserveFreePort();

    try {
      const start = runCli([
        'start',
        '--daemon',
        '--no-ui',
        '--no-open',
        '--port',
        String(taken.port),
        '--mcp-port',
        String(mcpPort),
      ]);

      expect(start.status).toBe(1);
      expect(start.stderr).toContain(`Port ${taken.port} (API/dashboard) is in use`);

      const supervisorLog = readLog('supervisor');
      expect(supervisorLog).toContain(
        `[agent-deck] start failed: port ${taken.port} (API/dashboard) is held by another program`,
      );

      const status = runCli(['status']);
      expect(status.stdout).toContain('Last failed start:');
      expect(status.stdout).toContain(`port ${taken.port} (API/dashboard) is held by another program`);
    } finally {
      await taken.release();
    }
  }, 120_000);
});
