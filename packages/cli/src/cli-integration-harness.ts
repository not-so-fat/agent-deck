import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { CLI_DEFAULT_BACKEND_PORT, CLI_DEFAULT_MCP_PORT } from './defaults';
import type { DaemonLogName } from './daemon-logs';

/**
 * Shared rig for the suites that drive the *built* CLI as a real operator would.
 * NOT-135's acceptance criteria are about what survives in `~/.agent-deck` after
 * a process is gone, so those tests spawn `agent-deck` and read the files it
 * leaves behind instead of re-stating the supervisor's decisions in TypeScript.
 */
export const CLI_PACKAGE = path.resolve(__dirname, '..');
export const BACKEND_PACKAGE = path.resolve(CLI_PACKAGE, '..', 'backend');
export const CLI_ENTRY = path.join(CLI_PACKAGE, 'dist', 'bin.js');

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
 * These suites spawn the built CLI and the built backend, so a stale dist would
 * silently test the previous build. Turbo runs `build` before `test`; a bare
 * `vitest` inside the package does not.
 */
export function assertFreshBuild(packageDir: string): void {
  const dist = newestMtime(path.join(packageDir, 'dist'));
  if (dist === null) {
    throw new Error(`${packageDir}/dist is missing — run npm run build before this suite.`);
  }
  const src = newestMtime(path.join(packageDir, 'src'), (file) => file.endsWith('.test.ts'));
  if (src !== null && src > dist) {
    throw new Error(`${packageDir}/dist is older than its sources — run npm run build before this suite.`);
  }
}

/** Both halves of a run: the CLI that supervises and the backend it spawns. */
export function assertFreshCliAndBackendBuild(): void {
  assertFreshBuild(CLI_PACKAGE);
  assertFreshBuild(BACKEND_PACKAGE);
}

/**
 * A store *and* a pair of ports, because `agent-deck stop` and `agent-deck
 * status` take their ports from the environment, not from run.json: a suite that
 * isolated only the home would send `stop` at whatever is listening on the
 * defaults — i.e. the developer's own deck. Every CLI call here goes through
 * this object so that cannot happen.
 */
export interface IsolatedDeck {
  home: string;
  backendPort: number;
  mcpPort: number;
}

export async function createIsolatedDeck(prefix: string): Promise<IsolatedDeck> {
  const backendPort = await reserveFreePort();
  let mcpPort = await reserveFreePort();
  // Both come from the ephemeral range; the second must not repeat the first.
  while (mcpPort === backendPort) {
    mcpPort = await reserveFreePort();
  }
  return { home: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), backendPort, mcpPort };
}

/**
 * Teardown runs even when setup threw, and `fs.rmSync(undefined)` there would
 * replace the real failure (a stale dist, say) with an ERR_INVALID_ARG_TYPE.
 */
export function removeIsolatedDeck(deck: IsolatedDeck | undefined): void {
  if (deck) {
    fs.rmSync(deck.home, { recursive: true, force: true });
  }
}

/** A port nothing is listening on — released before it is handed back. */
export function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * A port held open for the length of the test, to trip a port-conflict check.
 *
 * The accepted sockets are tracked and destroyed on release: the CLI's port
 * probe connects here, and a socket nothing ever reads stays paused — so it
 * never emits 'end', is never destroyed, and `server.close()` would wait on it
 * for the rest of the test.
 */
export function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const sockets = new Set<net.Socket>();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      // Nothing here speaks a protocol; a probe only needs the accept.
      socket.on('error', () => socket.destroy());
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        port,
        release: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * `agent-deck stop` kills whatever holds the configured ports, so a test that
 * ran on the defaults would stop the developer's deck — and a `status` on them
 * would report it. Nothing in these suites may use the shipped defaults.
 */
function assertIsolatedPorts(deck: IsolatedDeck): void {
  for (const [port, label] of [
    [deck.backendPort, 'backend'],
    [deck.mcpPort, 'MCP'],
  ] as const) {
    if (port === CLI_DEFAULT_BACKEND_PORT || port === CLI_DEFAULT_MCP_PORT) {
      throw new Error(
        `refusing to run the CLI with the default ${label} port ${port}: that is the developer's own deck`,
      );
    }
  }
}

function cliEnv(deck: IsolatedDeck, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  assertIsolatedPorts(deck);
  return {
    ...process.env,
    AGENT_DECK_HOME: deck.home,
    AGENT_DECK_HOST: '127.0.0.1',
    // `stop` and `status` read the ports from here — pin them, or they act on
    // whatever is listening on 1111/1110.
    AGENT_DECK_BACKEND_PORT: String(deck.backendPort),
    AGENT_DECK_MCP_PORT: String(deck.mcpPort),
    // Keep the run off the network; an update check is not under test.
    AGENT_DECK_NO_UPDATE_CHECK: '1',
    // The spawned backend opens the secret store on startup, and the real one
    // is macOS-only — on Linux CI it throws VaultUnsupportedError and the deck
    // never becomes healthy. These tests are about stop origins, not secrets,
    // so use the in-memory store the rest of the suite already uses. It also
    // keeps the run out of the developer's keychain on macOS.
    AGENT_DECK_SECRET_STORE: 'memory',
    ...extra,
  };
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runCli(deck: IsolatedDeck, args: string[], env: NodeJS.ProcessEnv = {}): CliResult {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: 'utf8',
    timeout: 90_000,
    env: cliEnv(deck, env),
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Foreground `agent-deck start`: the inherit-mode run a Ctrl-C interrupts. */
export function spawnCli(
  deck: IsolatedDeck,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): ChildProcess {
  return spawn(process.execPath, [CLI_ENTRY, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cliEnv(deck, env),
  });
}

export function readDaemonLog(deck: IsolatedDeck, name: DaemonLogName): string {
  try {
    return fs.readFileSync(path.join(deck.home, 'logs', `${name}.log`), 'utf8');
  } catch {
    return '';
  }
}

/** Every `supervisor shutting down` line this deck has recorded, oldest first. */
export function shutdownLines(deck: IsolatedDeck): string[] {
  return readDaemonLog(deck, 'supervisor')
    .split('\n')
    .filter((line) => line.includes('supervisor shutting down'));
}

/** The record `agent-deck status` reads for "why did the deck stop?". */
export function readLastStopFile(deck: IsolatedDeck): { at: string; reason: string } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(deck.home, 'last-stop.json'), 'utf8')) as {
      at: string;
      reason: string;
    };
  } catch {
    return null;
  }
}

export interface RunStateFile {
  backendPid: number;
  mcpPid: number;
  cliPid: number;
}

export function readRunStateFile(deck: IsolatedDeck): RunStateFile | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(deck.home, 'run.json'), 'utf8')) as RunStateFile;
  } catch {
    return null;
  }
}

/**
 * run.json is the last thing a start writes — after the backend answers /health
 * and after MCP comes up — so a caller that waited only for health can still
 * find no pids to work with.
 */
export async function waitForRunState(
  deck: IsolatedDeck,
  timeoutMs = 30_000,
): Promise<RunStateFile> {
  await waitUntil(() => readRunStateFile(deck) !== null, timeoutMs);
  const state = readRunStateFile(deck);
  if (state === null) {
    throw new Error(`${deck.home}/run.json was never written`);
  }
  return state;
}

export function isAlive(pid: number): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function waitForHealthy(port: number, timeoutMs = 30_000): Promise<boolean> {
  return waitUntil(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {
      return false;
    }
  }, timeoutMs);
}

/**
 * Last resort between tests: a supervisor that survived its scenario would hold
 * the ports (and keep writing to a home the next test is about to delete).
 */
export function killLeftovers(
  deck: IsolatedDeck | undefined,
  extra: (ChildProcess | null)[] = [],
): void {
  const state = deck ? readRunStateFile(deck) : null;
  const pids = [state?.mcpPid, state?.backendPid, state?.cliPid, ...extra.map((child) => child?.pid)];
  for (const pid of pids) {
    if (pid && isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
}
