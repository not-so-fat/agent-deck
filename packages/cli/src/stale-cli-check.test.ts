import { describe, expect, it, vi } from 'vitest';

import {
  checkPathForStaleCli,
  evaluateInvokerVersion,
  evaluatePathCandidates,
  formatMcpLaunchStaleLine,
  formatStaleDoctorWarning,
  resolveAgentDeckOnPath,
  warnIfInvokerStale,
} from './stale-cli-check';

const CURRENT = { dir: '/Users/test/.agent-deck/versions/1.11.1', version: '1.11.1' };

describe('stale CLI PATH check (NOT-236)', () => {
  it('warns when the first PATH binary is older than the managed current', () => {
    const line = checkPathForStaleCli({
      candidates: ['/opt/homebrew/bin/agent-deck', '/Users/test/.local/bin/agent-deck'],
      currentDir: CURRENT.dir,
      currentVersion: CURRENT.version,
      probeVersion: (binary) =>
        binary === '/opt/homebrew/bin/agent-deck' ? '1.10.5' : '1.11.1',
    });

    expect(line).not.toBeNull();
    // Names both paths and both versions.
    expect(line).toContain('/opt/homebrew/bin/agent-deck');
    expect(line).toContain('1.10.5');
    expect(line).toContain(CURRENT.dir);
    expect(line).toContain('1.11.1');
    // States the remedy.
    expect(line).toContain('brew uninstall');
  });

  it('stays silent when the first PATH binary is the current version', () => {
    const line = checkPathForStaleCli({
      candidates: ['/Users/test/.local/bin/agent-deck', '/opt/homebrew/bin/agent-deck'],
      currentDir: CURRENT.dir,
      currentVersion: CURRENT.version,
      probeVersion: (binary) =>
        binary === '/opt/homebrew/bin/agent-deck' ? '1.10.5' : '1.11.1',
    });

    expect(line).toBeNull();
  });

  it('stays silent without a managed current install or resolvable versions', () => {
    expect(
      checkPathForStaleCli({
        candidates: ['/opt/homebrew/bin/agent-deck'],
        currentDir: null,
        currentVersion: null,
        probeVersion: () => '1.10.5',
      }),
    ).toBeNull();

    expect(
      checkPathForStaleCli({
        candidates: [],
        currentDir: CURRENT.dir,
        currentVersion: CURRENT.version,
        probeVersion: () => '1.10.5',
      }),
    ).toBeNull();

    // Unparseable/unrunnable binary version is not evidence of a gap.
    expect(
      evaluatePathCandidates(
        [{ path: '/opt/homebrew/bin/agent-deck', version: null }],
        CURRENT,
      ),
    ).toBeNull();
  });

  it('resolves candidates in PATH order without touching the real PATH', () => {
    const resolved = resolveAgentDeckOnPath({
      pathEnv: ['/opt/homebrew/bin', '/usr/bin', '/Users/test/.local/bin'].join(':'),
      delimiter: ':',
      isExecutable: (candidate) =>
        candidate === '/opt/homebrew/bin/agent-deck' ||
        candidate === '/Users/test/.local/bin/agent-deck',
    });

    expect(resolved).toEqual([
      '/opt/homebrew/bin/agent-deck',
      '/Users/test/.local/bin/agent-deck',
    ]);
  });

  it('formats the doctor warning with both paths, both versions, and a remedy', () => {
    const line = formatStaleDoctorWarning({
      firstPath: '/opt/homebrew/bin/agent-deck',
      firstVersion: '1.10.5',
      currentDir: CURRENT.dir,
      currentVersion: CURRENT.version,
      otherPaths: ['/Users/test/.local/bin/agent-deck'],
    });

    expect(line).toContain('/opt/homebrew/bin/agent-deck');
    expect(line).toContain('1.10.5');
    expect(line).toContain('1.11.1');
    expect(line).toContain(CURRENT.dir);
    expect(line).toMatch(/PATH|brew uninstall/);
  });
});

describe('mcp-launch stale invoker check (NOT-236)', () => {
  it('detects an invoker older than the managed current', () => {
    const gap = evaluateInvokerVersion('1.10.5', '1.11.1');
    expect(gap).toEqual({ invokerVersion: '1.10.5', currentVersion: '1.11.1' });
    expect(evaluateInvokerVersion('1.11.1', '1.11.1')).toBeNull();
  });

  it('logs one stderr line naming the gap and still proceeds', () => {
    const log = vi.fn();
    const line = warnIfInvokerStale({
      invokerVersion: '1.10.5',
      invokerPath: '/opt/homebrew/bin/agent-deck',
      currentVersion: '1.11.1',
      log,
    });

    expect(line).not.toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    const logged = String(log.mock.calls[0]?.[0] ?? line);
    expect(logged).toContain('1.10.5');
    expect(logged).toContain('1.11.1');
  });

  it('stays silent when the invoker matches current or current is unknown', () => {
    const log = vi.fn();
    expect(
      warnIfInvokerStale({
        invokerVersion: '1.11.1',
        currentVersion: '1.11.1',
        log,
      }),
    ).toBeNull();
    expect(
      warnIfInvokerStale({
        invokerVersion: '1.10.5',
        currentVersion: null,
        log,
      }),
    ).toBeNull();
    expect(log).not.toHaveBeenCalled();

    expect(
      formatMcpLaunchStaleLine(
        { invokerVersion: '1.10.5', currentVersion: '1.11.1' },
        '/opt/homebrew/bin/agent-deck',
      ),
    ).toContain('Continuing launch');
  });
});
