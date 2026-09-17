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

/** Load better-sqlite3 from the CLI's backend dependency tree (catches ABI / cache mismatches). */
export function verifySqliteNative(): { ok: true } | { ok: false; reason: string; message: string } {
  try {
    const sqlitePath = require.resolve('better-sqlite3', {
      paths: [resolveBackendRoot(), getCliPackageRoot()],
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(sqlitePath);
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
        reason:
          `better-sqlite3 native module does not match node ${process.version} ` +
          `(NODE_MODULE_VERSION ${process.versions.modules}): ${firstLine(detail)}`,
        message: [
          'better-sqlite3 native module does not match this Node.js version.',
          '',
          '  npm rebuild better-sqlite3 -w @agent-deck/backend',
          '  rm -rf ~/.npm/_npx',
          '  npx @agent-deck/cli@latest doctor',
          '',
          detail,
        ].join('\n'),
      };
    }
    return { ok: false, reason: `better-sqlite3 could not be loaded: ${firstLine(detail)}`, message: detail };
  }
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
