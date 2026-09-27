import { execSync } from 'node:child_process';
import path from 'node:path';
import { getCliPackageRoot, resolveBackendRoot } from './paths';

/** Node majors we test against. 24 is the default target; 20+ remains supported. */
const SUPPORTED_NODE_MAJORS = [20, 22, 23, 24, 25, 26] as const;
const PREFERRED_NODE_MAJOR = 24;

export function getNodeMajor(): number {
  return Number.parseInt(process.versions.node.split('.')[0], 10);
}

export function formatNodeVersionError(): string {
  const major = getNodeMajor();
  return [
    `Agent Deck requires Node.js 20+ (you are on ${process.version}).`,
    `Default / recommended: Node ${PREFERRED_NODE_MAJOR} (current OS standard).`,
    '',
    `  node -v`,
    `  nvm install ${PREFERRED_NODE_MAJOR} && nvm use ${PREFERRED_NODE_MAJOR}   # optional`,
    '  rm -rf ~/.npm/_npx   # clear npx cache if you switched Node versions',
    '  npx @agent-deck/cli@latest doctor',
    '  npx @agent-deck/cli@latest start',
    '',
    `Unsupported major: ${major}. Native SQLite bindings (better-sqlite3) must match your Node version.`,
  ].join('\n');
}

export function isSupportedNodeMajor(major = getNodeMajor()): boolean {
  return (SUPPORTED_NODE_MAJORS as readonly number[]).includes(major);
}

/**
 * Directory to run `npm rebuild` from: the ancestor of wherever npm actually
 * hoisted better-sqlite3's node_modules entry. That differs by install kind
 * (global npm/Homebrew, the managed installer, or a monorepo workspace), so
 * `-w @agent-deck/backend` — correct only inside this monorepo — used to be
 * hardcoded into the operator-facing hint and failed for every other install.
 */
function resolveSqliteRebuildCwd(): string | null {
  try {
    const pkgJsonPath = require.resolve('better-sqlite3/package.json', {
      paths: [resolveBackendRoot(), getCliPackageRoot()],
    });
    const nodeModulesDir = path.dirname(path.dirname(pkgJsonPath));
    return path.dirname(nodeModulesDir);
  } catch {
    return null;
  }
}

function sqliteRebuildHint(): string {
  const cwd = resolveSqliteRebuildCwd();
  return cwd ? `  (cd "${cwd}" && npm rebuild better-sqlite3)` : '  npm rebuild better-sqlite3';
}

/**
 * A stale prebuild (installed under one Node major, then run under another
 * after an upgrade) is self-inflicted, not a real Node-version limitation —
 * try to fix it in place before telling the operator to. `npm rebuild` reruns
 * better-sqlite3's own install step (`prebuild-install`), which fetches a
 * precompiled binary matching the running Node's ABI and only falls back to
 * a from-source node-gyp build when no prebuild matches.
 */
function attemptSqliteRebuild(): boolean {
  const cwd = resolveSqliteRebuildCwd();
  if (!cwd) return false;
  try {
    console.error(
      `[agent-deck] better-sqlite3 native module is stale for node ${process.version} — rebuilding...`,
    );
    execSync('npm rebuild better-sqlite3', { cwd, stdio: 'ignore', timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

interface SqliteFailure {
  ok: false;
  reason: string;
  message: string;
}

type DatabaseCtor = new (filename: string) => { close(): void };

/** Resolved from the CLI's backend dependency tree — real callers never override this. */
function loadSqliteDatabaseCtor(): DatabaseCtor {
  const sqlitePath = require.resolve('better-sqlite3', {
    paths: [resolveBackendRoot(), getCliPackageRoot()],
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(sqlitePath);
}

/**
 * Catches ABI / cache mismatches in better-sqlite3. `loadDatabaseCtor` is a
 * test seam (real resolution goes through `require.resolve` with custom
 * search paths, which module-mocking tools can't intercept); production
 * always uses the default.
 */
function probeSqliteNative(
  loadDatabaseCtor: () => DatabaseCtor = loadSqliteDatabaseCtor,
): { ok: true } | (SqliteFailure & { abiMismatch: boolean }) {
  try {
    const Database = loadDatabaseCtor();
    // `require` alone proves nothing: better-sqlite3 dlopens its .node binding
    // lazily, on first Database construction. Without this probe an ABI
    // mismatch passes preflight and only surfaces as the backend exiting 1.
    const probe = new Database(':memory:');
    probe.close();
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Node reports a failed dlopen as `code`, not in the message, and an
    // arch mismatch ("incompatible architecture") never says NODE_MODULE_VERSION.
    const code = (error as NodeJS.ErrnoException)?.code ?? '';
    if (detail.includes('NODE_MODULE_VERSION') || code === 'ERR_DLOPEN_FAILED') {
      return {
        ok: false,
        abiMismatch: true,
        reason:
          `better-sqlite3 native module does not match node ${process.version} ` +
          `(NODE_MODULE_VERSION ${process.versions.modules}): ${firstLine(detail)}`,
        message: [
          'better-sqlite3 native module does not match this Node.js version.',
          '',
          sqliteRebuildHint(),
          '  rm -rf ~/.npm/_npx',
          '  npx @agent-deck/cli@latest doctor',
          '',
          detail,
        ].join('\n'),
      };
    }
    return {
      ok: false,
      abiMismatch: false,
      reason: `better-sqlite3 could not be loaded: ${firstLine(detail)}`,
      message: detail,
    };
  }
}

/**
 * Same probe as `probeSqliteNative`, but an ABI mismatch gets one automatic
 * `npm rebuild` before being reported as a failure — see `attemptSqliteRebuild`.
 * `loadDatabaseCtor` is a test seam; production callers never pass it.
 */
export function verifySqliteNative(
  loadDatabaseCtor: () => DatabaseCtor = loadSqliteDatabaseCtor,
): { ok: true } | SqliteFailure {
  const first = probeSqliteNative(loadDatabaseCtor);
  if (first.ok || !first.abiMismatch || !attemptSqliteRebuild()) {
    return first;
  }
  return probeSqliteNative(loadDatabaseCtor);
}

function firstLine(text: string): string {
  return text.split('\n')[0].trim();
}

export interface PreflightFailure {
  /** One line, for supervisor.log and `agent-deck status`. */
  reason: string;
  /** The full operator-facing explanation, already formatted for a terminal. */
  message: string;
}

/**
 * Runtime checks that must pass before anything is spawned. Returns the failure
 * rather than printing it: a start that dies here has to end up in supervisor.log
 * and `agent-deck status` too, not only on the terminal that invoked it.
 */
export function checkStartPreflight(): PreflightFailure | null {
  const major = getNodeMajor();
  if (!isSupportedNodeMajor(major)) {
    return {
      reason: `unsupported Node.js major ${major} (${process.version})`,
      message: formatNodeVersionError(),
    };
  }

  const sqlite = verifySqliteNative();
  if (!sqlite.ok) {
    return { reason: sqlite.reason, message: sqlite.message };
  }

  return null;
}
