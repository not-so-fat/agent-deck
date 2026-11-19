#!/usr/bin/env node
/**
 * Publish the release to npm in dependency order, skipping anything already live.
 *
 * Order: @agent-deck/shared -> @agent-deck/backend -> @agent-deck/cli.
 * A package whose root version is already on npm is skipped, so re-running
 * after a partial publish finishes the rest instead of failing.
 *
 * Authentication is npm trusted publishing (OIDC): this script refuses to run
 * when NODE_AUTH_TOKEN is set, so no static npm credential can sneak in.
 * Provenance is attached explicitly with --provenance.
 *
 * Usage:
 *   node scripts/release-publish.mjs [--root DIR] [--dry-run]
 *
 * --dry-run performs the real `npm view` checks and reports what it would
 * publish, without publishing anything.
 */
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.join(scriptDir, '..');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const rootFlagIndex = args.indexOf('--root');
const root =
  rootFlagIndex >= 0 && args[rootFlagIndex + 1]
    ? path.resolve(args[rootFlagIndex + 1])
    : defaultRoot;

const PACKAGES = ['@agent-deck/shared', '@agent-deck/backend', '@agent-deck/cli'];

if (process.env.NODE_AUTH_TOKEN) {
  console.error(
    '[release-publish] Refusing to publish: NODE_AUTH_TOKEN is set. Releases publish via npm trusted publishing (OIDC) with no static token.',
  );
  process.exit(1);
}

const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = rootPkg.version;
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`[release-publish] Invalid root package.json version: ${JSON.stringify(version)}`);
  process.exit(1);
}

/**
 * True when `name@version` is already on the registry, false when the
 * registry answers "not found". Any other failure (network, auth, bad
 * output) throws — publishing blind would be wrong.
 */
function isVersionPublished(name, wanted) {
  try {
    const output = execFileSync('npm', ['view', `${name}@${wanted}`, 'version', '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    // `npm view pkg@version version --json` prints e.g. "2.5.4".
    return output.replace(/"/g, '').split('\n').some((line) => line.trim() === wanted);
  } catch (error) {
    const detail = `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message ?? ''}`;
    if (/\bE404\b|\b404\b|Not Found/i.test(detail)) {
      return false;
    }
    throw new Error(`[release-publish] Could not check ${name}@${wanted} on npm: ${detail.trim().split('\n').at(-1)}`);
  }
}

function publish(name) {
  console.log(`[release-publish] Publishing ${name}@${version} ...`);
  execSync(`npm publish -w ${name} --access public --provenance`, { cwd: root, stdio: 'inherit' });
  console.log(`[release-publish] Published ${name}@${version}.`);
}

const published = [];
const skipped = [];

for (const name of PACKAGES) {
  let live;
  try {
    live = isVersionPublished(name, version);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (live) {
    console.log(`[release-publish] Skip ${name}@${version} — already on npm.`);
    skipped.push(name);
    continue;
  }
  if (dryRun) {
    console.log(`[release-publish] Would publish ${name}@${version} (dry run).`);
    published.push(name);
    continue;
  }
  publish(name);
  published.push(name);
}

console.log(
  `[release-publish] Done (${dryRun ? 'dry run' : 'live'}): ` +
    `${published.length} published${dryRun ? '/would publish' : ''}, ${skipped.length} skipped.`,
);
