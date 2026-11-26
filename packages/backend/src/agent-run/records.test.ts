import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendRunDenial,
  tryAppendRunDenial,
  readRunMeta,
  RunMetaLockTimeoutError,
  withRunMetaLock,
  writeRunMeta,
  type RunDenial,
  type RunMeta,
} from './index';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function testMeta(runId: string): RunMeta {
  return {
    runId,
    deck: 'deck-1',
    client: 'codex',
    tools: 'edit',
    cwd: makeDir('ad-lock-cwd-'),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    state: 'running',
  };
}

function denial(target: string, at = new Date().toISOString()): RunDenial {
  return {
    at,
    client: 'codex',
    profile: 'edit',
    source: 'agent-deck',
    kind: 'mcp_tool',
    target,
    reason: 'not allowed',
  };
}

describe('run record lock (NOT-669 repair)', () => {
  it('is reentrant within one process', () => {
    const metaPath = path.join(makeDir('ad-lock-'), 'meta.json');
    const seen: string[] = [];
    withRunMetaLock(metaPath, () => {
      seen.push('outer');
      withRunMetaLock(metaPath, () => {
        seen.push('inner');
      });
    });
    expect(seen).toEqual(['outer', 'inner']);
    expect(fs.existsSync(`${metaPath}.lock`)).toBe(false);
  });

  it('breaks a stale lock left by a crashed holder', () => {
    const dir = makeDir('ad-lock-');
    const metaPath = path.join(dir, 'meta.json');
    writeRunMeta(metaPath, testMeta('run-stale'));
    const lockDir = `${metaPath}.lock`;
    fs.mkdirSync(lockDir);
    const ancient = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, ancient, ancient);

    expect(appendRunDenial(metaPath, denial('stale-break'))).toBe(true);
    const read = readRunMeta(metaPath);
    if (!read.ok) throw new Error(read.reason);
    expect(read.meta.denials?.map((entry) => entry.target)).toEqual(['stale-break']);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('writeRunMeta unions disk denials chronologically, oldest first', () => {
    // The finding's interleave: an older server-side denial is already on
    // disk when the run service writes its in-memory meta holding a newer
    // client denial. The union must stay oldest-first, not in-memory-first.
    const dir = makeDir('ad-lock-');
    const metaPath = path.join(dir, 'meta.json');
    writeRunMeta(metaPath, testMeta('run-order'));
    const stale = readRunMeta(metaPath);
    if (!stale.ok) throw new Error(stale.reason);
    expect(appendRunDenial(metaPath, denial('server-tool', '2026-11-20T00:00:00.000Z'))).toBe(true);
    stale.meta.denials = [denial('client-tool', '2026-11-21T00:00:00.000Z')];
    writeRunMeta(metaPath, stale.meta);

    const final = readRunMeta(metaPath);
    if (!final.ok) throw new Error(final.reason);
    expect(final.meta.denials?.map((entry) => entry.target)).toEqual(['server-tool', 'client-tool']);
    expect(final.meta.denials?.map((entry) => entry.at)).toEqual([
      '2026-11-20T00:00:00.000Z',
      '2026-11-21T00:00:00.000Z',
    ]);
  });

  it('a record that stays locked: nothing runs unlocked, append reports false, write throws', () => {
    // A live holder in a child process keeps touching the lock so it never
    // goes stale — every wait below must time out rather than proceed.
    const dir = makeDir('ad-lock-');
    const metaPath = path.join(dir, 'meta.json');
    writeRunMeta(metaPath, testMeta('run-held'));
    const lockDir = `${metaPath}.lock`;
    fs.mkdirSync(lockDir);
    const holder = spawn(
      process.execPath,
      [
        '-e',
        'const fs = require("node:fs"); const lock = process.argv[1];' +
          ' const touch = () => { try { const now = new Date(); fs.utimesSync(lock, now, now); } catch {} };' +
          ' touch(); setInterval(touch, 500); setTimeout(() => {}, 120000);',
        lockDir,
      ],
      { stdio: 'ignore' },
    );
    holder.unref();
    try {
      let ran = false;
      expect(() =>
        withRunMetaLock(metaPath, () => {
          ran = true;
        }),
      ).toThrow(RunMetaLockTimeoutError);
      expect(ran).toBe(false);

      expect(appendRunDenial(metaPath, denial('held'))).toBe(false);

      const meta = testMeta('run-held');
      meta.sessionId = 'ses-held';
      meta.denials = [denial('held-write')];
      expect(() => writeRunMeta(metaPath, meta)).toThrow(RunMetaLockTimeoutError);
    } finally {
      holder.kill();
    }

    // Nothing landed while the lock was held, and the holder's lock is
    // untouched (never broken, never adopted).
    expect(fs.existsSync(lockDir)).toBe(true);
    fs.rmdirSync(lockDir);
    const final = readRunMeta(metaPath);
    if (!final.ok) throw new Error(final.reason);
    expect(final.meta.denials ?? []).toEqual([]);
    expect(final.meta.sessionId).toBeUndefined();
  }, 120_000);

  it('concurrent processes appending denials lose none', async () => {
    // The children run the real records module: transpile it to plain JS
    // (type-only imports erase; runtime imports are node built-ins) and
    // spawn plain node — no tsx listener, so this also runs sandboxed.
    const { transpileModule, ModuleKind, ScriptTarget } = await import('typescript');
    const dir = makeDir('ad-lock-');
    const metaPath = path.join(dir, 'meta.json');
    writeRunMeta(metaPath, testMeta('run-hammer'));

    const transpiled = transpileModule(fs.readFileSync(path.join(__dirname, 'records.ts'), 'utf8'), {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const recordsJs = path.join(dir, 'records.cjs');
    fs.writeFileSync(recordsJs, transpiled);
    const childScript = path.join(dir, 'hammer.cjs');
    fs.writeFileSync(
      childScript,
      [
        `const { appendRunDenial } = require(${JSON.stringify(recordsJs)});`,
        'const [, , metaPath, childId, countRaw] = process.argv;',
        'for (let i = 0; i < Number(countRaw); i += 1) {',
        '  const ok = appendRunDenial(metaPath, {',
        '    at: new Date().toISOString(),',
        "    client: 'codex',",
        "    profile: 'edit',",
        "    source: 'agent-deck',",
        "    kind: 'mcp_tool',",
        '    target: `hammer-${childId}-${i}`,',
        "    reason: 'hammer',",
        '  });',
        '  if (!ok) { console.error(`append failed ${childId}/${i}`); process.exit(1); }',
        '}',
        '',
      ].join('\n'),
    );

    const children = 4;
    const perChild = 10;
    const procs = Array.from({ length: children }, (_, childId) => {
      const child = spawn(process.execPath, [childScript, metaPath, String(childId), String(perChild)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return new Promise<void>((resolve, reject) => {
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`hammer child ${childId} exited ${code}: ${stderr}`));
          }
        });
      });
    });

    // The run-service side writes state concurrently from this process while
    // the children append — the finding's lost-update interleaving.
    for (let i = 0; i < 40; i += 1) {
      const read = readRunMeta(metaPath);
      if (!read.ok) throw new Error(read.reason);
      read.meta.sessionId = `ses-${i}`;
      writeRunMeta(metaPath, read.meta);
    }
    await Promise.all(procs);

    const final = readRunMeta(metaPath);
    if (!final.ok) throw new Error(final.reason);
    expect(final.meta.denials).toHaveLength(children * perChild);
    expect(new Set((final.meta.denials ?? []).map((entry) => entry.target)).size).toBe(
      children * perChild,
    );
    expect(final.meta.sessionId).toMatch(/^ses-\d+$/);
    expect(fs.existsSync(`${metaPath}.lock`)).toBe(false);
    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
  }, 120_000);
});

describe('denial recording (NOT-669 repair round 4)', () => {
  it('records equal-valued denials once per call, never collapsing them', () => {
    const metaPath = path.join(makeDir('ad-dup-'), 'meta.json');
    writeRunMeta(metaPath, testMeta('run-dup'));
    const same = denial('switch_deck', '2026-11-26T00:00:00.000Z');
    expect(appendRunDenial(metaPath, { ...same })).toBe(true);
    expect(appendRunDenial(metaPath, { ...same })).toBe(true);
    const read = readRunMeta(metaPath);
    expect(read.ok && read.meta.denials).toEqual([same, same]);
  });

  it('a service write keeps every disk copy of equal-valued denials (multiset merge)', () => {
    const metaPath = path.join(makeDir('ad-multi-'), 'meta.json');
    const meta = testMeta('run-multi');
    const same = denial('start_run', '2026-11-26T00:00:01.000Z');
    meta.denials = [same];
    writeRunMeta(metaPath, meta);
    expect(appendRunDenial(metaPath, { ...same })).toBe(true);
    // The service still holds its single in-memory copy and writes again.
    meta.state = 'ended';
    writeRunMeta(metaPath, meta);
    const read = readRunMeta(metaPath);
    expect(read.ok && read.meta.denials).toEqual([same, same]);
  });

  it('a late append lands at its chronological position', () => {
    const metaPath = path.join(makeDir('ad-order-'), 'meta.json');
    writeRunMeta(metaPath, testMeta('run-order'));
    expect(appendRunDenial(metaPath, denial('later', '2026-11-26T00:00:02.000Z'))).toBe(true);
    expect(appendRunDenial(metaPath, denial('earlier', '2026-11-26T00:00:01.000Z'))).toBe(true);
    const read = readRunMeta(metaPath);
    expect(read.ok && read.meta.denials?.map((entry) => entry.target)).toEqual(['earlier', 'later']);
  });

  it('a non-blocking attempt on a held lock returns busy at once and writes nothing', () => {
    const metaPath = path.join(makeDir('ad-busy-'), 'meta.json');
    writeRunMeta(metaPath, testMeta('run-busy'));
    fs.mkdirSync(`${metaPath}.lock`);
    const started = Date.now();
    expect(tryAppendRunDenial(metaPath, denial('busy'), 0)).toBe('busy');
    expect(Date.now() - started).toBeLessThan(200);
    const before = readRunMeta(metaPath);
    expect(before.ok && (before.meta.denials ?? [])).toEqual([]);
    fs.rmdirSync(`${metaPath}.lock`);
    expect(tryAppendRunDenial(metaPath, denial('busy'), 0)).toBe('recorded');
    const after = readRunMeta(metaPath);
    expect(after.ok && after.meta.denials?.map((entry) => entry.target)).toEqual(['busy']);
  });
});
