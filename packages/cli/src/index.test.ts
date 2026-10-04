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

  it('treats explicit top-level help as success', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runCli(['node', 'agent-deck', '--help'])).resolves.toBe(0);
  });
});
