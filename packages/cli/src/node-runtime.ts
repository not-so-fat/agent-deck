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

export function assertSupportedNodeVersion(): number | null {
  const major = getNodeMajor();
  if ((SUPPORTED_NODE_MAJORS as readonly number[]).includes(major)) {
    return null;
  }
  console.error(formatNodeVersionError());
  return 1;
}

/** Load better-sqlite3 from the CLI's backend dependency tree (catches ABI / cache mismatches). */
export function verifySqliteNative(): { ok: true } | { ok: false; message: string } {
  try {
    const sqlitePath = require.resolve('better-sqlite3', {
      paths: [resolveBackendRoot(), getCliPackageRoot()],
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(sqlitePath);
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes('NODE_MODULE_VERSION')) {
      return {
        ok: false,
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
    return { ok: false, message: detail };
  }
}

export function assertSqliteNative(): number | null {
  const result = verifySqliteNative();
  if (result.ok) {
    return null;
  }
  console.error(result.message);
  return 1;
}
