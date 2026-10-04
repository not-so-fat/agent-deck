import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli, suggestTopLevelCommand } from './index';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('top-level command errors', () => {
  it('suggests setup for the transposed steup typo', () => {
    expect(suggestTopLevelCommand('steup')).toBe('setup');
  });

  it('prints a corrected invocation without dumping the full usage page', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
      errors.push(String(message));
    });
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runCli(['node', 'agent-deck', 'steup', '--client', 'cursor']);

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('Unknown command: steup');
    expect(errors.join('\n')).toContain('Did you mean: agent-deck setup --client cursor');
    expect(errors.join('\n')).toContain('Run agent-deck --help');
    expect(logs).not.toHaveBeenCalled();
  });

  it('quotes suggestion arguments that are not safe as bare shell words', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
      errors.push(String(message));
    });

    await runCli(['node', 'agent-deck', 'steup', '--label', 'My Svc', "it's-ready"]);

    expect(errors.join('\n')).toContain(
      "Did you mean: agent-deck setup --label 'My Svc' 'it'\\''s-ready'",
    );
  });

  it('does not suggest a distant command for a short unknown input', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
      errors.push(String(message));
    });

    await expect(runCli(['node', 'agent-deck', 'ls'])).resolves.toBe(1);
    expect(errors.join('\n')).toContain('Unknown command: ls');
    expect(errors.join('\n')).not.toContain('Did you mean');
  });

  it.each(['--help', '-h', 'help'])('treats top-level %s as success', async (command) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runCli(['node', 'agent-deck', command])).resolves.toBe(0);
    expect(log).toHaveBeenCalled();
  });

  it('prints usage successfully when no command is provided', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runCli(['node', 'agent-deck'])).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });
});
