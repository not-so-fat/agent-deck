import { describe, expect, it } from 'vitest';
import { parseReindexArgs, parseStoreArgs } from './store';

describe('store CLI args', () => {
  it('parses store migrate', () => {
    expect(parseStoreArgs(['migrate'])).toEqual({
      ok: true,
      command: 'migrate',
      dryRun: false,
      force: false,
    });
  });

  it('parses store migrate --dry-run', () => {
    expect(parseStoreArgs(['migrate', '--dry-run'])).toEqual({
      ok: true,
      command: 'migrate',
      dryRun: true,
      force: false,
    });
  });

  it('parses store migrate --force', () => {
    expect(parseStoreArgs(['migrate', '--force'])).toEqual({
      ok: true,
      command: 'migrate',
      dryRun: false,
      force: true,
    });
  });

  it('rejects unknown store arguments', () => {
    expect(parseStoreArgs(['migrate', '--wat'])).toEqual({
      ok: false,
      error: 'Unknown argument: --wat',
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
