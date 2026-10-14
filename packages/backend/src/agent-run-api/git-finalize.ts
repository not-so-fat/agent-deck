import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { FinalizationFileMode, FinalizationManifestEntry } from '@agent-deck/shared';

/**
 * NOT-486: the Git mechanism behind run finalization.
 *
 * Policy (who may finalize which run, idempotency, audit) lives in the route;
 * this module only proves a reviewed manifest against the repository and
 * turns it into one local commit. It runs a fixed set of plumbing commands —
 * never a caller-supplied argument list — with repository hooks and fsmonitor
 * disabled, and it never checks out, resets, cleans, pushes, or deletes a
 * working-tree file.
 *
 * Staging happens in a private index file. The real index is locked
 * (`index.lock`, Git's own protocol) for the whole operation and replaced
 * only after the ref moved, so a failure or cancellation before the commit
 * leaves the real index, the ref, and every working-tree file untouched.
 */

/** Paths Agent Deck owns in a workspace (the folder binding); never candidates, never committable. */
const RESERVED_PREFIX = '.agent-deck/';

export type FinalizationFailureCode =
  | 'finalization_invalid'
  | 'index_dirty'
  | 'base_mismatch'
  | 'baseline_mismatch'
  | 'path_invalid'
  | 'path_unexpected'
  | 'digest_mismatch'
  | 'git_lock_conflict'
  | 'ref_race'
  | 'finalization_canceled'
  | 'finalization_failed';

/** A stable failure; `message` never carries a host path or file content. */
export class FinalizationError extends Error {
  constructor(
    readonly code: FinalizationFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'FinalizationError';
  }
}

/** Private pre-launch baseline. Holds host paths, so it is never returned to a caller. */
export type GitBaseline = {
  version: 1;
  repoRoot: string;
  gitDir: string;
  commonDir: string;
  indexPath: string;
  /** `refs/heads/<branch>`, or `HEAD` when detached. */
  headRef: string;
  baseCommit: string;
  /** Pre-existing dirty paths and their content state, sorted by path. */
  dirty: Array<{ path: string; state: string }>;
  digest: string;
};

export type CandidateSnapshot = {
  baseCommit: string;
  files: FinalizationManifestEntry[];
  manifestDigest: string;
};

export type FinalizeInput = {
  runId: string;
  baselineDigest: string;
  expectedBaseCommit: string;
  commitMessage: string;
  files: FinalizationManifestEntry[];
};

export type FinalizeResult = {
  commit: string;
  tree: string;
  parent: string;
  manifestDigest: string;
  fileCount: number;
};

/** Points where a finalization may be observed (tests) and where cancellation is honored. */
export type FinalizeStage = 'locked' | 'validated' | 'staged' | 'commit-object' | 'ref-updated';

export type FinalizeOptions = {
  /** Aborted = cancel. Honored up to `commit-object`; after the ref moves it is ignored. */
  signal?: AbortSignal;
  /** Persist crash-recovery facts before the ref moves. */
  onLocked?: (lockIno: number) => void;
  onCommitObject?: (commit: string, tree: string) => void;
};

export type GitResult = { code: number; stdout: Buffer; stderr: string };
export type GitRunner = (
  args: string[],
  options: { cwd: string; env?: Record<string, string>; input?: Buffer | string },
) => Promise<GitResult>;

export type GitFinalizerDeps = {
  runGit?: GitRunner;
  /** Test seam: awaited at each stage before the cancellation check. */
  pause?: (stage: FinalizeStage, runId: string) => Promise<void>;
};

/** Inherited variables that would redirect Git away from the captured workspace. */
const BLOCKED_GIT_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_EXEC_PATH',
];

export const defaultGitRunner: GitRunner = (args, options) =>
  new Promise((resolve) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !BLOCKED_GIT_ENV.includes(key)) {
        env[key] = value;
      }
    }
    const child = spawn(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...args],
      {
        cwd: options.cwd,
        env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(error) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Order-independent digest of a manifest (sorted by path). */
export function manifestDigestOf(files: FinalizationManifestEntry[]): string {
  const sorted = [...files].sort(byPath).map((file) => [file.path, file.sha256, file.mode]);
  return sha256Hex(JSON.stringify(sorted));
}

function baselineDigestOf(baseline: Omit<GitBaseline, 'digest'>): string {
  return sha256Hex(
    JSON.stringify({
      version: baseline.version,
      headRef: baseline.headRef,
      baseCommit: baseline.baseCommit,
      dirty: baseline.dirty.map((entry) => [entry.path, entry.state]),
    }),
  );
}

/** Opaque repository identity for audit: never the host path itself. */
export function repositoryIdOf(baseline: Pick<GitBaseline, 'commonDir'>): string {
  return `repo_${sha256Hex(`agent-deck-repository\u0000${baseline.commonDir}`).slice(0, 24)}`;
}

/**
 * Repository-relative POSIX path that names a regular location inside the
 * worktree: not absolute, no `.`/`..`/empty segment, no `.git` segment, no
 * backslash or control character, outside Agent Deck's reserved folder.
 */
export function isValidManifestPath(value: string): boolean {
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  if (/[\u0000-\u001f\u007f\\]/.test(value)) {
    return false;
  }
  if (value === '.agent-deck' || value.startsWith(RESERVED_PREFIX)) {
    return false;
  }
  return value
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git');
}

type PathState =
  | { kind: 'absent' }
  | { kind: 'file'; mode: FinalizationFileMode; sha256: string }
  | { kind: 'symlink'; sha256: string }
  | { kind: 'directory' }
  | { kind: 'other' };

function encodeState(state: PathState): string {
  switch (state.kind) {
    case 'file':
      return `file:${state.mode}:${state.sha256}`;
    case 'symlink':
      return `symlink:${state.sha256}`;
    default:
      return state.kind;
  }
}

/**
 * True when some parent segment of `rel` is a symlink, or is not a directory.
 * Reading through such a path could leave the worktree.
 */
function hasUnsafeParent(root: string, rel: string): boolean {
  const segments = rel.split('/');
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return false; // A missing parent: the path itself is absent.
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return true;
    }
    if (fs.existsSync(path.join(current, '.git'))) {
      return true; // Inside a nested repository or submodule checkout.
    }
  }
  return false;
}

function readState(root: string, rel: string): PathState {
  if (hasUnsafeParent(root, rel)) {
    return { kind: 'other' };
  }
  const full = path.join(root, rel);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(full);
  } catch {
    return { kind: 'absent' };
  }
  if (stat.isSymbolicLink()) {
    return { kind: 'symlink', sha256: sha256Hex(fs.readlinkSync(full)) };
  }
  if (stat.isDirectory()) {
    return { kind: 'directory' };
  }
  if (!stat.isFile()) {
    return { kind: 'other' };
  }
  return {
    kind: 'file',
    mode: (stat.mode & 0o111) !== 0 ? '100755' : '100644',
    sha256: sha256Hex(fs.readFileSync(full)),
  };
}

function decodePath(raw: Buffer): string | null {
  const text = raw.toString('utf8');
  return Buffer.from(text, 'utf8').equals(raw) ? text : null;
}

function splitNul(buffer: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0) {
      parts.push(buffer.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buffer.length) {
    parts.push(buffer.subarray(start));
  }
  return parts;
}

export type GitFinalizer = {
  /** Capture the private baseline for `cwd`; fails closed for a non-Git cwd or a dirty index. */
  captureBaseline(cwd: string): Promise<GitBaseline>;
  /** The run-produced candidate manifest against `baseline`, after every precondition. */
  candidate(baseline: GitBaseline): Promise<CandidateSnapshot>;
  /** Prove `input` against `baseline` and create exactly one commit on the captured ref. */
  finalize(baseline: GitBaseline, input: FinalizeInput, options?: FinalizeOptions): Promise<FinalizeResult>;
  /**
   * Crash recovery for a finalization that never recorded its outcome: true
   * when the captured ref already points at `pendingCommit`. Removes only
   * the private index and the `index.lock` this operation created.
   */
  recover(baseline: GitBaseline, runId: string, pending: { commit: string | null; lockIno: number | null }): Promise<boolean>;
};

export function createGitFinalizer(deps: GitFinalizerDeps = {}): GitFinalizer {
  const runGit = deps.runGit ?? defaultGitRunner;
  /** Serialization per repository + ref inside this process; a busy key fails closed. */
  const busy = new Set<string>();

  const git = async (
    cwd: string,
    args: string[],
    options: { indexFile?: string; input?: Buffer | string; allow?: number[] } = {},
  ): Promise<GitResult> => {
    const result = await runGit(args, {
      cwd,
      ...(options.indexFile ? { env: { GIT_INDEX_FILE: options.indexFile } } : {}),
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
    if (result.code !== 0 && !(options.allow ?? []).includes(result.code)) {
      throw new FinalizationError('finalization_failed', `git ${args[0]} failed`);
    }
    return result;
  };
  const text = (result: GitResult): string => result.stdout.toString('utf8').trim();

  const locate = async (cwd: string) => {
    const result = await runGit(
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--git-path', 'index'],
      { cwd },
    );
    const lines = result.stdout.toString('utf8').split('\n').filter(Boolean);
    if (result.code !== 0 || lines.length !== 4) {
      throw new FinalizationError('finalization_invalid', 'cwd is not inside a Git worktree');
    }
    const real = (value: string) => {
      try {
        return fs.realpathSync(value);
      } catch {
        return value;
      }
    };
    return {
      repoRoot: real(lines[0]),
      gitDir: real(lines[1]),
      commonDir: real(lines[2]),
      indexPath: path.join(real(path.dirname(lines[3])), path.basename(lines[3])),
    };
  };

  const readHead = async (root: string): Promise<{ headRef: string; commit: string | null }> => {
    const symbolic = await git(root, ['symbolic-ref', '-q', 'HEAD'], { allow: [1] });
    const headRef = symbolic.code === 0 ? text(symbolic) : 'HEAD';
    const commit = await git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { allow: [1, 128] });
    return { headRef, commit: commit.code === 0 ? text(commit) : null };
  };

  const indexIsClean = async (root: string, indexFile?: string): Promise<boolean> => {
    const diff = await git(root, ['diff-index', '--cached', '--quiet', 'HEAD', '--'], {
      allow: [1],
      ...(indexFile ? { indexFile } : {}),
    });
    if (diff.code !== 0) {
      return false;
    }
    const unmerged = await git(root, ['ls-files', '-u', '-z'], indexFile ? { indexFile } : {});
    return unmerged.stdout.length === 0;
  };

  /** Dirty paths (tracked changes and untracked files), excluding Agent Deck's reserved folder. */
  const dirtyPaths = async (root: string, indexFile?: string): Promise<string[]> => {
    const status = await git(
      root,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=none'],
      indexFile ? { indexFile } : {},
    );
    const paths: string[] = [];
    for (const record of splitNul(status.stdout)) {
      if (record.length < 4) {
        continue;
      }
      const decoded = decodePath(record.subarray(3));
      if (decoded === null) {
        throw new FinalizationError('path_invalid', 'A changed path is not valid UTF-8');
      }
      const rel = decoded.endsWith('/') ? decoded.slice(0, -1) : decoded;
      if (rel === '.agent-deck' || rel.startsWith(RESERVED_PREFIX)) {
        continue;
      }
      paths.push(decoded);
    }
    return [...new Set(paths)].sort();
  };

  /** Paths that are, or sit inside, a submodule (gitlink) in `commit`. */
  const gitlinksAmong = async (root: string, commit: string, paths: string[]): Promise<Set<string>> => {
    if (paths.length === 0) {
      return new Set();
    }
    const names = new Set<string>();
    for (const p of paths) {
      const segments = p.split('/');
      for (let i = 1; i <= segments.length; i += 1) {
        names.add(segments.slice(0, i).join('/'));
      }
    }
    // Non-recursive: each named entry itself (a directory shows as one tree entry).
    const listed = await git(root, ['ls-tree', '-z', commit, '--', ...names]);
    const links = new Set<string>();
    for (const record of splitNul(listed.stdout)) {
      const line = record.toString('utf8');
      const tab = line.indexOf('\t');
      if (tab > 0 && line.startsWith('160000 ') && names.has(line.slice(tab + 1))) {
        links.add(line.slice(tab + 1));
      }
    }
    const hits = new Set<string>();
    for (const p of paths) {
      for (const link of links) {
        if (p === link || p.startsWith(`${link}/`)) {
          hits.add(p);
        }
      }
    }
    return hits;
  };

  const assertWorkspace = async (baseline: GitBaseline): Promise<void> => {
    let located: Awaited<ReturnType<typeof locate>>;
    try {
      located = await locate(baseline.repoRoot);
    } catch {
      throw new FinalizationError('finalization_invalid', 'The run workspace is no longer a Git worktree');
    }
    if (located.repoRoot !== baseline.repoRoot || located.gitDir !== baseline.gitDir) {
      throw new FinalizationError('finalization_invalid', 'The run workspace no longer matches its baseline');
    }
  };

  const assertHead = async (baseline: GitBaseline): Promise<void> => {
    const head = await readHead(baseline.repoRoot);
    if (head.headRef !== baseline.headRef || head.commit !== baseline.baseCommit) {
      throw new FinalizationError('base_mismatch', 'HEAD no longer matches the run baseline commit');
    }
  };

  const candidate = async (baseline: GitBaseline, indexFile?: string): Promise<CandidateSnapshot> => {
    await assertWorkspace(baseline);
    await assertHead(baseline);
    if (!(await indexIsClean(baseline.repoRoot, indexFile))) {
      throw new FinalizationError('index_dirty', 'The Git index has staged or unmerged changes');
    }
    const root = baseline.repoRoot;
    const current = await dirtyPaths(root, indexFile);
    const recorded = new Map(baseline.dirty.map((entry) => [entry.path, entry.state]));
    for (const [rel, state] of recorded) {
      if (encodeState(readState(root, rel)) !== state) {
        throw new FinalizationError('baseline_mismatch', 'A path that was dirty before the run has changed');
      }
    }
    const produced = current.filter((rel) => !recorded.has(rel));
    const links = await gitlinksAmong(root, baseline.baseCommit, produced.map((rel) => rel.replace(/\/$/, '')));
    const files: FinalizationManifestEntry[] = [];
    for (const raw of produced) {
      const rel = raw.replace(/\/$/, '');
      if (raw.endsWith('/') || !isValidManifestPath(rel) || links.has(rel)) {
        throw new FinalizationError('path_invalid', 'The run changed a submodule, nested repository, or invalid path');
      }
      const state = readState(root, rel);
      if (state.kind === 'file') {
        files.push({ path: rel, sha256: state.sha256, mode: state.mode });
      } else if (state.kind === 'absent') {
        files.push({ path: rel, sha256: null, mode: null });
      } else {
        throw new FinalizationError('path_invalid', 'The run produced a symlink or non-regular path');
      }
    }
    files.sort(byPath);
    return { baseCommit: baseline.baseCommit, files, manifestDigest: manifestDigestOf(files) };
  };

  const recover: GitFinalizer['recover'] = async (baseline, runId, pending) => {
    try {
      for (const name of fs.readdirSync(baseline.gitDir)) {
        if (name.startsWith(`agent-deck-finalize-${runId}-`)) {
          fs.rmSync(path.join(baseline.gitDir, name), { force: true });
        }
      }
    } catch {
      // Workspace gone: nothing of ours remains to remove.
    }
    const lockPath = `${baseline.indexPath}.lock`;
    if (pending.lockIno !== null) {
      try {
        if (fs.lstatSync(lockPath).ino === pending.lockIno) {
          fs.rmSync(lockPath, { force: true });
        }
      } catch {
        // No lock left behind.
      }
    }
    if (!pending.commit) {
      return false;
    }
    const ref = await runGit(['rev-parse', '--verify', '-q', baseline.headRef], { cwd: baseline.repoRoot });
    return ref.code === 0 && ref.stdout.toString('utf8').trim() === pending.commit;
  };

  return {
    async captureBaseline(cwd) {
      const located = await locate(cwd);
      const head = await readHead(located.repoRoot);
      if (!head.commit) {
        throw new FinalizationError('finalization_invalid', 'The Git worktree has no commit at HEAD');
      }
      if (head.headRef !== 'HEAD' && !head.headRef.startsWith('refs/heads/')) {
        throw new FinalizationError('finalization_invalid', 'HEAD must be a local branch or detached');
      }
      if (!(await indexIsClean(located.repoRoot))) {
        throw new FinalizationError('index_dirty', 'The Git index has staged or unmerged changes');
      }
      const dirty = (await dirtyPaths(located.repoRoot)).map((raw) => {
        const rel = raw.replace(/\/$/, '');
        return { path: rel, state: encodeState(readState(located.repoRoot, rel)) };
      });
      const unsigned: Omit<GitBaseline, 'digest'> = {
        version: 1,
        ...located,
        headRef: head.headRef,
        baseCommit: head.commit,
        dirty,
      };
      return { ...unsigned, digest: baselineDigestOf(unsigned) };
    },

    candidate: (baseline) => candidate(baseline),

    async finalize(baseline, input, options = {}) {
      const root = baseline.repoRoot;
      const checkpoint = async (stage: FinalizeStage): Promise<void> => {
        if (stage === 'ref-updated') {
          // History already moved: nothing after this point may report failure.
          await Promise.resolve(deps.pause?.(stage, input.runId)).catch(() => {});
          return;
        }
        await deps.pause?.(stage, input.runId);
        if (options.signal?.aborted) {
          throw new FinalizationError('finalization_canceled', 'Finalization was canceled before the commit');
        }
      };

      // Syntactic and baseline gates: nothing touched yet.
      const seen = new Set<string>();
      for (const file of input.files) {
        if (!isValidManifestPath(file.path) || seen.has(file.path)) {
          throw new FinalizationError('path_invalid', 'The manifest has an invalid or duplicate path');
        }
        seen.add(file.path);
      }
      if (input.baselineDigest !== baseline.digest) {
        throw new FinalizationError('baseline_mismatch', 'baselineDigest does not match the run baseline');
      }
      if (input.expectedBaseCommit !== baseline.baseCommit) {
        throw new FinalizationError('base_mismatch', 'expectedBaseCommit does not match the run baseline commit');
      }

      const key = `${baseline.commonDir}\u0000${baseline.headRef}`;
      if (busy.has(key)) {
        throw new FinalizationError('git_lock_conflict', 'Another finalization holds this repository ref');
      }
      busy.add(key);
      const lockPath = `${baseline.indexPath}.lock`;
      const privateIndex = path.join(
        baseline.gitDir,
        `agent-deck-finalize-${input.runId}-${randomBytes(4).toString('hex')}.index`,
      );
      let lockFd: number | null = null;
      let committed = false;
      try {
        const refLock =
          baseline.headRef === 'HEAD'
            ? path.join(baseline.gitDir, 'HEAD.lock')
            : path.join(baseline.commonDir, `${baseline.headRef}.lock`);
        if (fs.existsSync(refLock)) {
          throw new FinalizationError('git_lock_conflict', 'The branch ref is locked by another Git process');
        }
        try {
          lockFd = fs.openSync(lockPath, 'wx');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new FinalizationError('git_lock_conflict', 'The Git index is locked by another Git process');
          }
          throw new FinalizationError('finalization_failed', 'Could not lock the Git index');
        }
        options.onLocked?.(fs.fstatSync(lockFd).ino);
        if (fs.existsSync(baseline.indexPath)) {
          fs.copyFileSync(baseline.indexPath, privateIndex);
        } else {
          await git(root, ['read-tree', baseline.baseCommit], { indexFile: privateIndex });
        }
        await checkpoint('locked');

        // Workspace, HEAD, index, baseline, then the exact manifest.
        for (const file of input.files) {
          if (hasUnsafeParent(root, file.path)) {
            throw new FinalizationError('path_invalid', 'A manifest path crosses a symlink or nested repository');
          }
          const state = readState(root, file.path);
          if (state.kind === 'symlink' || state.kind === 'directory' || state.kind === 'other') {
            throw new FinalizationError('path_invalid', 'A manifest path is a symlink, directory, or special file');
          }
        }
        if ((await gitlinksAmong(root, baseline.baseCommit, input.files.map((file) => file.path))).size > 0) {
          throw new FinalizationError('path_invalid', 'A manifest path is a submodule');
        }
        const snapshot = await candidate(baseline, privateIndex);
        const expected = new Map(snapshot.files.map((file) => [file.path, file]));
        for (const file of input.files) {
          if (!expected.has(file.path)) {
            throw new FinalizationError('path_unexpected', 'The manifest names a path the run did not change');
          }
        }
        for (const file of snapshot.files) {
          if (!seen.has(file.path)) {
            throw new FinalizationError('path_unexpected', 'The run changed a path that is absent from the manifest');
          }
        }
        for (const file of input.files) {
          const current = expected.get(file.path)!;
          if (current.sha256 !== file.sha256 || current.mode !== file.mode) {
            throw new FinalizationError('digest_mismatch', 'A manifest digest or mode differs from the working tree');
          }
        }
        await checkpoint('validated');

        // Stage exactly the manifest into the private index, from verified bytes.
        const zero = '0'.repeat(baseline.baseCommit.length);
        const blobs = new Map<string, string>();
        const lines: string[] = [];
        for (const file of [...input.files].sort(byPath)) {
          if (file.sha256 === null) {
            if (readState(root, file.path).kind !== 'absent') {
              throw new FinalizationError('digest_mismatch', 'A path the manifest deletes exists again');
            }
            lines.push(`0 ${zero}\t${file.path}`);
            continue;
          }
          const bytes = fs.readFileSync(path.join(root, file.path));
          if (sha256Hex(bytes) !== file.sha256) {
            throw new FinalizationError('digest_mismatch', 'A file changed after the manifest was checked');
          }
          const oid = text(await git(root, ['hash-object', '-w', '--no-filters', '--stdin'], { input: bytes }));
          blobs.set(file.path, oid);
          lines.push(`${file.mode} ${oid}\t${file.path}`);
        }
        await git(root, ['update-index', '-z', '--index-info'], {
          indexFile: privateIndex,
          input: Buffer.from(lines.map((line) => `${line}\u0000`).join(''), 'utf8'),
        });

        // Re-read the staged set and blob digests: exactly the manifest, nothing else.
        const staged = await git(root, ['diff-index', '--cached', '-z', '--raw', '--no-abbrev', '--no-renames', 'HEAD', '--'], {
          indexFile: privateIndex,
        });
        const records = splitNul(staged.stdout).map((part) => part.toString('utf8'));
        const mismatch = new FinalizationError('digest_mismatch', 'The staged set differs from the manifest');
        const stagedPaths = new Map<string, { mode: string; oid: string; status: string }>();
        for (let i = 0; i + 1 < records.length; i += 2) {
          // `:<src mode> <dst mode> <src oid> <dst oid> <status>` then the path.
          const match = /^:\d+ (\d+) [0-9a-f]+ ([0-9a-f]+) ([A-Z])/.exec(records[i]);
          if (!match) {
            throw mismatch;
          }
          stagedPaths.set(records[i + 1], { mode: match[1], oid: match[2], status: match[3] });
        }
        if (stagedPaths.size !== input.files.length) {
          throw mismatch;
        }
        for (const file of input.files) {
          const entry = stagedPaths.get(file.path);
          if (!entry) {
            throw mismatch;
          }
          if (file.sha256 === null) {
            if (entry.status !== 'D') {
              throw mismatch;
            }
            continue;
          }
          if (entry.mode !== file.mode || entry.oid !== blobs.get(file.path)) {
            throw mismatch;
          }
          const blob = await git(root, ['cat-file', 'blob', entry.oid]);
          if (sha256Hex(blob.stdout) !== file.sha256) {
            throw mismatch;
          }
        }
        await checkpoint('staged');

        const tree = text(await git(root, ['write-tree'], { indexFile: privateIndex }));
        const commit = text(
          await git(root, ['commit-tree', tree, '-p', input.expectedBaseCommit, '-F', '-'], {
            input: input.commitMessage,
          }),
        );
        options.onCommitObject?.(commit, tree);
        await checkpoint('commit-object');

        // Compare-and-swap: the ref moves only from expectedBaseCommit.
        const updateArgs =
          baseline.headRef === 'HEAD'
            ? ['update-ref', '--no-deref', '-m', `agent-deck finalize ${input.runId}`, 'HEAD', commit, input.expectedBaseCommit]
            : ['update-ref', '-m', `agent-deck finalize ${input.runId}`, baseline.headRef, commit, input.expectedBaseCommit];
        const updated = await runGit(updateArgs, { cwd: root });
        if (updated.code !== 0) {
          const now = await runGit(['rev-parse', '--verify', '-q', baseline.headRef], { cwd: root });
          if (now.stdout.toString('utf8').trim() !== input.expectedBaseCommit) {
            throw new FinalizationError('ref_race', 'The branch moved before the commit could be recorded');
          }
          if (fs.existsSync(refLock)) {
            throw new FinalizationError('git_lock_conflict', 'The branch ref is locked by another Git process');
          }
          throw new FinalizationError('finalization_failed', 'git update-ref failed');
        }
        committed = true;
        await checkpoint('ref-updated');

        // The real index adopts the private one (Git's lock-and-rename), so it matches the new HEAD.
        try {
          fs.writeSync(lockFd, fs.readFileSync(privateIndex));
          fs.fsyncSync(lockFd);
          fs.closeSync(lockFd);
          lockFd = null;
          fs.renameSync(lockPath, baseline.indexPath);
        } catch {
          // History is already correct; a stale index refreshes on the next Git command.
        }
        return {
          commit,
          tree,
          parent: input.expectedBaseCommit,
          manifestDigest: manifestDigestOf(input.files),
          fileCount: input.files.length,
        };
      } catch (error) {
        if (committed) {
          throw error;
        }
        if (error instanceof FinalizationError) {
          throw error;
        }
        throw new FinalizationError('finalization_failed', 'Finalization failed before the commit');
      } finally {
        if (lockFd !== null) {
          try {
            fs.closeSync(lockFd);
          } catch {
            // Already closed.
          }
          fs.rmSync(lockPath, { force: true });
        }
        fs.rmSync(privateIndex, { force: true });
        fs.rmSync(`${privateIndex}.lock`, { force: true });
        busy.delete(key);
      }
    },

    recover,
  };
}
