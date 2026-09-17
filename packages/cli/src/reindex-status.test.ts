import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createStore, readLastReindex } from './backend-runtime';
import { formatLastReindex, formatReindexWarnings } from './store';
import { runStatus } from './status';
import { runDoctor } from './start';

const tempDirs: string[] = [];
const restoreEnv: Array<() => void> = [];

function setEnv(name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  restoreEnv.push(() => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  });
}

async function createStoreHome(manifestVersion: number): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-cli-reindex-'));
  tempDirs.push(home);
  await fs.writeFile(
    path.join(home, 'manifest.json'),
    `{"format":"agent-deck-store","version":${manifestVersion}}\n`,
  );
  setEnv('AGENT_DECK_HOME', home);
  setEnv('AGENT_DECK_DB_PATH', path.join(home, 'agent_deck.db'));
  return home;
}

/** A store whose manifest the backend refuses — the cheapest way to fail a reindex for real. */
async function createFailedReindex(): Promise<{ error: string }> {
  await createStoreHome(2);
  const result = await createStore().reindex();
  if (result.ok) {
    throw new Error('Expected the reindex to fail');
  }
  return { error: result.error };
}

async function writeDeck(home: string, id: string, name: string): Promise<void> {
  await fs.mkdir(path.join(home, 'decks'), { recursive: true });
  await fs.writeFile(
    path.join(home, 'decks', `${id}.json`),
    JSON.stringify({
      id,
      name,
      serviceIds: [],
      credentialIds: [],
      playbookIds: [],
      createdAt: '2026-09-15T10:00:00.000Z',
      updatedAt: '2026-09-15T10:00:00.000Z',
    }),
  );
}

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(record),
    vi.spyOn(console, 'warn').mockImplementation(record),
    vi.spyOn(console, 'error').mockImplementation(record),
  ];
  return {
    lines,
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

afterEach(async () => {
  restoreEnv.splice(0).reverse().forEach((restore) => restore());
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('reindex reporting', () => {
  it('formats warnings as their own visible block', () => {
    expect(formatReindexWarnings([])).toEqual([]);
    expect(formatReindexWarnings(['a', 'b'])).toEqual([
      'WARN: reindex imported the store with 2 warnings:',
      '  - a',
      '  - b',
    ]);
  });

  it('formats a failed reindex with its timestamp and error', () => {
    expect(
      formatLastReindex({
        at: '2026-09-15T10:00:00.000Z',
        ok: false,
        error: 'Duplicate ids found in store files',
        warnings: [],
      })[0],
    ).toBe(
      'Last reindex FAILED 2026-09-15T10:00:00.000Z: Duplicate ids found in store files',
    );
  });

  it('spells out warnings instead of only counting them', () => {
    expect(
      formatLastReindex({ at: '2026-09-15T10:00:00.000Z', ok: true, warnings: [] }),
    ).toEqual(['Last reindex OK 2026-09-15T10:00:00.000Z']);
    expect(
      formatLastReindex({
        at: '2026-09-15T10:00:00.000Z',
        ok: true,
        warnings: ['Duplicate deck name "Work" in 2 store files: a.json, b.json'],
      }),
    ).toEqual([
      'Last reindex OK 2026-09-15T10:00:00.000Z — 1 warning:',
      '- Duplicate deck name "Work" in 2 store files: a.json, b.json',
    ]);
    expect(formatLastReindex(null)).toEqual([]);
  });
});

describe('status and doctor after a failed reindex', () => {
  it('persists the failure so status reports it', async () => {
    const { error } = await createFailedReindex();
    expect(readLastReindex()).toMatchObject({ ok: false, error });

    const captured = captureConsole();
    try {
      await runStatus();
    } finally {
      captured.restore();
    }

    const output = captured.lines.join('\n');
    expect(output).toContain('Last reindex FAILED');
    expect(output).toContain(error);
  });

  it('names the duplicated deck and both files in status after a warned reindex', async () => {
    const home = await createStoreHome(1);
    await writeDeck(home, 'aaaaaaaa-1111-4111-8111-111111111111', 'Twin');
    await writeDeck(home, 'bbbbbbbb-2222-4222-8222-222222222222', 'Twin');

    const result = await createStore().reindex();
    expect(result).toMatchObject({ ok: true, counts: { decks: 2 } });

    const captured = captureConsole();
    try {
      await runStatus();
    } finally {
      captured.restore();
    }

    const output = captured.lines.join('\n');
    expect(output).toContain('Last reindex OK');
    expect(output).toContain('1 warning');
    expect(output).toContain('Duplicate deck name "Twin"');
    expect(output).toContain('aaaaaaaa-1111-4111-8111-111111111111.json');
    expect(output).toContain('bbbbbbbb-2222-4222-8222-222222222222.json');
  });

  it('reads the record without creating or migrating a database', async () => {
    const home = await createStoreHome(1);
    expect(readLastReindex()).toBeNull();
    await expect(fs.access(path.join(home, 'agent_deck.db'))).rejects.toThrow();
  });

  it('fails doctor and reports the error text', async () => {
    const { error } = await createFailedReindex();

    const captured = captureConsole();
    let code: number;
    try {
      code = await runDoctor();
    } finally {
      captured.restore();
    }

    const output = captured.lines.join('\n');
    expect(output).toContain('FAIL: Last reindex FAILED');
    expect(output).toContain(error);
    expect(code).toBe(1);
  });
});
