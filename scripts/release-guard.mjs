#!/usr/bin/env node
/**
 * Gate the npm release workflow before anything is published.
 *
 * Fails (exit 1) when ANY of these hold, so a mistagged or half-synced
 * release never reaches npm:
 *   1. The tag is not `v<root package.json version>`.
 *   2. Any publishable workspace version
 *      (@agent-deck/shared, @agent-deck/backend, @agent-deck/cli) or the
 *      dashboard workspace (apps/agent-deck) differs from the root version.
 *   3. server.json (top-level or any packages[].version) differs.
 *   4. The tagged commit is not an ancestor of main.
 *   5. CHANGELOG.md has no `## <version> — <date>` section.
 *
 * Usage:
 *   node scripts/release-guard.mjs v1.2.3 [--root DIR] [--main-ref REF]
 *
 * The tag defaults to $GITHUB_REF_NAME (set by the release workflow).
 * --main-ref defaults to origin/main when it exists, else main.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.join(scriptDir, '..');

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

const root = path.resolve(flagValue('--root') ?? defaultRoot);
const tag = positional[0] ?? process.env.GITHUB_REF_NAME ?? null;
const mainRefFlag = flagValue('--main-ref');

const failures = [];

function pass(message) {
  console.log(`[release-guard] ok: ${message}`);
}

function fail(message) {
  failures.push(message);
  console.error(`[release-guard] FAIL: ${message}`);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function refExists(ref) {
  try {
    execSync(`git rev-parse --verify --quiet ${ref}`, { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function resolveMainRef() {
  if (mainRefFlag) {
    return mainRefFlag;
  }
  if (refExists('origin/main')) {
    return 'origin/main';
  }
  return 'main';
}

// --- 0. Tag shape -----------------------------------------------------------
if (!tag) {
  console.error('[release-guard] Usage: node scripts/release-guard.mjs vX.Y.Z [--root DIR] [--main-ref REF]');
  process.exit(1);
}
const tagMatch = /^v(\d+\.\d+\.\d+(-[\w.]+)?)$/.exec(tag);
if (!tagMatch) {
  fail(`tag ${JSON.stringify(tag)} is not v<semver>`);
} else {
  pass(`tag ${tag} is v<semver>`);
}
const tagVersion = tagMatch ? tagMatch[1] : null;

// --- 1. Tag equals root package.json version --------------------------------
let rootVersion = null;
try {
  rootVersion = readJson('package.json').version;
} catch (error) {
  fail(`cannot read package.json version: ${error.message}`);
}
if (tagVersion && rootVersion) {
  if (tagVersion === rootVersion) {
    pass(`tag ${tag} matches root package.json version ${rootVersion}`);
  } else {
    fail(`tag ${tag} does not match root package.json version ${rootVersion}`);
  }
}

// --- 2. Workspace versions ---------------------------------------------------
const expected = rootVersion;
if (expected) {
  for (const manifest of [
    'packages/shared/package.json',
    'packages/backend/package.json',
    'packages/cli/package.json',
    'apps/agent-deck/package.json',
  ]) {
    let version = null;
    try {
      version = readJson(manifest).version;
    } catch {
      fail(`${manifest} is missing or unreadable`);
      continue;
    }
    if (version === expected) {
      pass(`${manifest} version ${version} matches`);
    } else {
      fail(`${manifest} version ${JSON.stringify(version)} differs from root ${expected} (run: npm run version:sync -- ${expected})`);
    }
  }
}

// --- 3. server.json ----------------------------------------------------------
if (expected) {
  let server = null;
  try {
    server = readJson('server.json');
  } catch {
    fail('server.json is missing or unreadable');
  }
  if (server) {
    if (server.version === expected) {
      pass(`server.json version ${server.version} matches`);
    } else {
      fail(`server.json version ${JSON.stringify(server.version)} differs from root ${expected} (run: npm run version:sync -- ${expected})`);
    }
    for (const pkg of Array.isArray(server.packages) ? server.packages : []) {
      if (pkg?.version === expected) {
        pass(`server.json package ${pkg.identifier ?? '(unknown)'} version ${pkg.version} matches`);
      } else {
        fail(
          `server.json package ${pkg?.identifier ?? '(unknown)'} version ${JSON.stringify(pkg?.version)} differs from root ${expected}`,
        );
      }
    }
  }
}

// --- 4. Tagged commit is on main ---------------------------------------------
const mainRef = resolveMainRef();
if (!refExists(`refs/tags/${tag}`)) {
  fail(`tag ${tag} does not exist in this clone`);
} else if (!refExists(mainRef)) {
  fail(`main ref ${JSON.stringify(mainRef)} does not exist in this clone (fetch origin/main first)`);
} else {
  try {
    execSync(`git merge-base --is-ancestor ${tag} ${mainRef}`, { cwd: root, stdio: 'ignore' });
    pass(`tag ${tag} is on ${mainRef}`);
  } catch {
    fail(`tag ${tag} is not on ${mainRef} — releases ship from main only`);
  }
}

// --- 5. CHANGELOG section ----------------------------------------------------
if (expected && tagVersion) {
  const changelogPath = path.join(root, 'CHANGELOG.md');
  let changelog = null;
  try {
    changelog = fs.readFileSync(changelogPath, 'utf8');
  } catch {
    fail('CHANGELOG.md is missing or unreadable');
  }
  if (changelog) {
    // Same `## <version> — <date>` shape release-tag.mjs extracts notes from.
    const escaped = tagVersion.replace(/\./g, '\\.');
    const section = new RegExp(`^## ${escaped} — [^\\n]+`, 'm');
    if (section.test(changelog)) {
      pass(`CHANGELOG.md has a ## ${tagVersion} section`);
    } else {
      fail(`CHANGELOG.md has no ## ${tagVersion} section`);
    }
  }
}

if (failures.length > 0) {
  console.error(`[release-guard] ${failures.length} check(s) failed — refusing to publish`);
  process.exit(1);
}
console.log('[release-guard] All checks passed.');
