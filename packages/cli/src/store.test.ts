import { describe, expect, it } from 'vitest';
import { parseReindexArgs, parseStoreArgs } from './store';

describe('store CLI args', () => {
  it('parses store migrate', () => {
    expect(parseStoreArgs(['migrate'])).toEqual({
      ok: true,
      command: 'migrate',
      dryRun: false,
    });
  });

  it('parses store migrate --dry-run', () => {
    expect(parseStoreArgs(['migrate', '--dry-run'])).toEqual({
      ok: true,
      command: 'migrate',
      dryRun: true,
    });
  });

  it('rejects unknown store arguments', () => {
    expect(parseStoreArgs(['migrate', '--force'])).toEqual({
      ok: false,
      error: 'Unknown argument: --force',
    });
  });

  it('accepts reindex without arguments', () => {
    expect(parseReindexArgs([])).toEqual({ ok: true });
  });

  it('rejects reindex arguments', () => {
    expect(parseReindexArgs(['--dry-run'])).toEqual({
      ok: false,
      error: 'Unknown argument: --dry-run',
    });
  });
});
