#!/usr/bin/env node
/**
 * Gate npm publish — runs the monorepo test suite and exits non-zero on failure.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.join(scriptDir, '..');
const rootFlagIndex = process.argv.indexOf('--root');
const root =
  rootFlagIndex >= 0 && process.argv[rootFlagIndex + 1]
    ? path.resolve(process.argv[rootFlagIndex + 1])
    : defaultRoot;

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

/**
 * NOT-188: the Codex/Claude plugin manifests, workspace package versions, and
 * the bundled `.mcp.json` transport must stay synchronized with the release.
 * Fails fast with an actionable message before the slow rebuild/test gates.
 */
function checkReleaseSync() {
  const failures = [];
  const rootPkg = readJson('package.json');
  const expected = rootPkg.version;

  for (const manifest of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
    let manifestVersion = null;
    try {
      manifestVersion = readJson(manifest).version;
    } catch {
      failures.push(`${manifest} is missing or unreadable`);
      continue;
    }
    if (manifestVersion !== expected) {
      failures.push(
        `${manifest} version ${JSON.stringify(manifestVersion)} differs from root package version ${expected} (run: npm run version:sync -- ${expected})`,
      );
    }
  }

  for (const pkg of [
    'packages/shared/package.json',
    'packages/backend/package.json',
    'packages/cli/package.json',
    'apps/agent-deck/package.json',
  ]) {
    let pkgVersion = null;
    try {
      pkgVersion = readJson(pkg).version;
    } catch {
      continue;
    }
    if (pkgVersion !== expected) {
      failures.push(
        `${pkg} version ${JSON.stringify(pkgVersion)} differs from root package version ${expected} (run: npm run version:sync -- ${expected})`,
      );
    }
  }

  let transportOk = false;
  try {
    const mcp = readJson('.mcp.json');
    const entry = mcp?.mcpServers?.['agent-deck'];
    transportOk =
      !!entry &&
      entry.command === 'agent-deck' &&
      Array.isArray(entry.args) &&
      entry.args.includes('mcp-launch');
  } catch {
    transportOk = false;
  }
  if (!transportOk) {
    failures.push('.mcp.json does not invoke `agent-deck mcp-launch` for the agent-deck server (legacy direct-HTTP transport)');
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`[pre-publish] Release sync check failed: ${failure}`);
    }
    process.exit(1);
  }
  console.log('[pre-publish] Release sync check passed (plugin manifests, package versions, .mcp.json transport).');
}

checkReleaseSync();

if (process.argv.includes('--sync-only')) {
  process.exit(0);
}

console.log('[pre-publish] Rebuilding native modules for current Node...');
try {
  execSync('node scripts/rebuild-native.mjs', { cwd: root, stdio: 'inherit' });
} catch {
  console.error('[pre-publish] Native rebuild failed — publish aborted.');
  process.exit(1);
}

console.log('[pre-publish] Running publishable package tests (shared, backend, cli, frontend) ...');
try {
  execSync(
    'npx turbo run test --filter=@agent-deck/shared --filter=@agent-deck/backend --filter=@agent-deck/cli --filter=@agent-deck/frontend',
    { cwd: root, stdio: 'inherit' },
  );
} catch {
  console.error('[pre-publish] Tests failed — publish aborted.');
  process.exit(1);
}

console.log('[pre-publish] Tests passed.');
