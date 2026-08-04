/**
 * Host-contract integration tests for `agent-deck statusline`.
 *
 * POC for how Claude Code / Cursor invoke the command: JSON on stdin, often without EOF.
 * The 1.2.3 regression hung forever on `for await (process.stdin)` — these tests spawn a
 * real child process and would fail (timeout) if that pattern returns.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installStatuslineScript } from './statusline-setup';

const CLI_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin.js');
const HOST_TIMEOUT_MS = 2000;
/** Soft budget — hang regression is HOST_TIMEOUT_MS; allow load under full suite. */
const HOST_BUDGET_MS = 1500;

function nodeOnlyPath(): string {
  return [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
}

type HostRunResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  ms: number;
};

function spawnStatuslineHost(
  stdinPayload: string,
  options: {
    closeStdin?: boolean;
    command?: string[];
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<HostRunResult> {
    const command = options.command ?? [process.execPath, CLI_BIN, 'statusline'];
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      env: {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        AGENT_DECK_PORT: '59999',
        AGENT_DECK_STATUSLINE_TIMEOUT_MS: '50',
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.stdin.write(stdinPayload);
    if (options.closeStdin !== false) {
      child.stdin.end();
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `statusline host subprocess hung (>${HOST_TIMEOUT_MS}ms) — likely waiting on stdin EOF`,
        ),
      );
    }, HOST_TIMEOUT_MS);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        code,
        ms: Date.now() - start,
      });
    });
  });
}

function assertHostContract(result: HostRunResult): void {
  expect(
    result.ms,
    `statusline too slow (${result.ms}ms). stderr=${JSON.stringify(result.stderr)}`,
  ).toBeLessThan(HOST_BUDGET_MS);
  expect(
    result.code,
    `statusline exit ${result.code}. stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
  ).toBe(0);

  const lines = result.stdout
    .trimEnd()
    .split('\n')
    .filter((line) => line.length > 0);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^◆/);
  expect(result.stdout).not.toMatch(/npm warn/i);
  expect(result.stderr).not.toMatch(/npm warn/i);
}

describe('statusline host contract (subprocess POC)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-statusline-host-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('Claude POC: JSON on stdin without EOF completes within budget', async () => {
    const payload = JSON.stringify({
      cwd: '/Users/dev/my-repo',
      workspace: { project_dir: '/Users/dev/my-repo', current_dir: '/Users/dev/my-repo' },
    });

    const result = await spawnStatuslineHost(payload, {
      closeStdin: false,
      env: { HOME: tmpHome },
    });

    assertHostContract(result);
  });

  it('traditional pipe with EOF still works', async () => {
    const payload = JSON.stringify({ cwd: '/Users/dev/my-repo' });
    const result = await spawnStatuslineHost(payload, {
      closeStdin: true,
      env: { HOME: tmpHome },
    });

    assertHostContract(result);
  });

  it('installed statusline.sh respects the same host contract', async () => {
    expect(fs.existsSync(CLI_BIN), `CLI dist missing at ${CLI_BIN} — build packages/cli first`).toBe(
      true,
    );
    // Prefer os.homedir mock (same as statusline-setup.test) over HOME races across files.
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    const { scriptPath } = installStatuslineScript();
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(fs.readFileSync(scriptPath, 'utf8')).toContain(CLI_BIN);

    const payload = JSON.stringify({ cwd: process.cwd() });
    const result = await spawnStatuslineHost(payload, {
      closeStdin: false,
      command: [scriptPath],
      env: {
        HOME: tmpHome,
        // Avoid PATH picking a global agent-deck / broken npm — exercise baked SETUP_CLI.
        PATH: nodeOnlyPath(),
        NODE_BIN: process.execPath,
      },
    });

    assertHostContract(result);
  });

  it('shows offline when API port is dead (no sidecar fallback)', async () => {
    const workspace = path.join(tmpHome, 'bound-repo');
    fs.mkdirSync(workspace, { recursive: true });

    const payload = JSON.stringify({
      session_id: 'claude-code-session-id',
      cwd: workspace,
    });
    const result = await spawnStatuslineHost(payload, {
      closeStdin: false,
      env: { HOME: tmpHome },
    });

    assertHostContract(result);
    expect(result.stdout).toContain('Agent Deck offline');
  });
});
