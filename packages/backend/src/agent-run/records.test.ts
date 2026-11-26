import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendRunDenial,
  findLiveWorkerRunsForWorkspace,
  findRunMetaByTokenHash,
  hashRunToken,
  mintRunToken,
  readRunMeta,
  runPaths,
  runTokenPointerPath,
  withRunMetaLock,
  writeRunMeta,
  writeRunTokenPointer,
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

function denial(target: string): RunDenial {
  return {
    at: new Date().toISOString(),
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

describe('worker workspace hold (NOT-669 repair)', () => {
  function writeLiveRun(
    home: string,
    runId: string,
    cwd: string,
    overrides: Partial<RunMeta> = {},
  ): { metaPath: string; token: string } {
    const token = mintRunToken();
    const { metaPath } = runPaths(home, runId);
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    const meta: RunMeta = {
      runId,
      deck: 'deck-1',
      client: 'codex',
      tools: 'edit',
      cwd,
      canonicalCwd: fs.realpathSync(cwd),
      pid: process.pid,
      startedAt: new Date().toISOString(),
      state: 'running',
      runTokenHash: hashRunToken(token),
      ...overrides,
    };
    writeRunMeta(metaPath, meta);
    writeRunTokenPointer(home, hashRunToken(token), runId, metaPath);
    return { metaPath, token };
  }

  it('finds the live run holding a workspace, by pointer and by scan', () => {
    const home = makeDir('ad-hold-home-');
    const held = makeDir('ad-hold-wt-');
    const other = makeDir('ad-hold-other-');
    const { metaPath, token } = writeLiveRun(home, 'run-hold-1', held);

    const found = findLiveWorkerRunsForWorkspace(home, held);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ runId: 'run-hold-1', metaPath, client: 'codex', profile: 'edit' });
    expect(findLiveWorkerRunsForWorkspace(home, other)).toEqual([]);

    // The token resolves to the same record.
    const resolved = findRunMetaByTokenHash(home, hashRunToken(token));
    expect(resolved?.metaPath).toBe(metaPath);
  });

  it('covers custom-log runs through the pointer', () => {
    const home = makeDir('ad-hold-home-');
    const held = makeDir('ad-hold-wt-');
    const customDir = makeDir('ad-hold-custom-');
    const token = mintRunToken();
    const metaPath = path.join(customDir, 'meta.json');
    writeRunMeta(metaPath, {
      runId: 'run-custom-1',
      deck: 'deck-1',
      client: 'claude',
      tools: 'readonly',
      cwd: held,
      canonicalCwd: fs.realpathSync(held),
      pid: process.pid,
      startedAt: new Date().toISOString(),
      state: 'running',
      runTokenHash: hashRunToken(token),
    });
    writeRunTokenPointer(home, hashRunToken(token), 'run-custom-1', metaPath);

    const found = findLiveWorkerRunsForWorkspace(home, held);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ runId: 'run-custom-1', profile: 'readonly' });
    expect(findRunMetaByTokenHash(home, hashRunToken(token))?.metaPath).toBe(metaPath);
    expect(fs.readFileSync(runTokenPointerPath(home, hashRunToken(token)), 'utf8')).not.toContain(token);
  });

  it('ignores terminal runs, dead owners, and tokenless records', () => {
    const home = makeDir('ad-hold-home-');
    const held = makeDir('ad-hold-wt-');
    writeLiveRun(home, 'run-ended', held, { state: 'ended' });
    writeLiveRun(home, 'run-dead', held, { pid: 2147483647 });
    const tokenless = writeLiveRun(home, 'run-untokened', held);
    const read = readRunMeta(tokenless.metaPath);
    if (!read.ok) throw new Error(read.reason);
    delete read.meta.runTokenHash;
    writeRunMeta(tokenless.metaPath, read.meta);

    expect(findLiveWorkerRunsForWorkspace(home, held)).toEqual([]);
  });

  it('never throws on a missing or corrupt store', () => {
    expect(findLiveWorkerRunsForWorkspace(makeDir('ad-hold-empty-'), makeDir('ad-hold-wt-'))).toEqual([]);
    expect(findLiveWorkerRunsForWorkspace('/nonexistent-home-xyz', '/tmp')).toEqual([]);
  });
});
