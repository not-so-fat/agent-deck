#!/usr/bin/env node
/**
 * Create and optionally push Git tags (v{semver}) for npm releases.
 *
 * Usage:
 *   node scripts/release-tag.mjs              # tag HEAD with root package.json version
 *   node scripts/release-tag.mjs 1.2.1        # tag HEAD as v1.2.1
 *   node scripts/release-tag.mjs --push       # tag HEAD and push to origin
 *   node scripts/release-tag.mjs --backfill   # tag historical "Ship X.Y.Z" commits
 *   node scripts/release-tag.mjs --backfill --push --github-release
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const push = flags.has('--push');
const backfill = flags.has('--backfill');
const githubRelease = flags.has('--github-release');
const force = flags.has('--force');

/** Commits without an explicit semver in the Ship subject. */
const BACKFILL_OVERRIDES = {
  '1.0.0': '58f47a8',
  // 1.9.0 shipped from release/1.9.0; PR #76's squash-merge dropped the Ship
  // commit, so main carries the release as the squash itself.
  '1.9.0': '4e223a3',
};

function readRootVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return pkg.version;
}

function tagName(version) {
  return `v${version}`;
}

function tagExists(name) {
  try {
    execSync(`git rev-parse --verify refs/tags/${name}`, { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function createTag(version, commit = 'HEAD') {
  const name = tagName(version);
  if (tagExists(name) && !force) {
    console.log(`[release-tag] Skip ${name} — already exists (use --force to move)`);
    return false;
  }
  if (tagExists(name) && force) {
    execSync(`git tag -d ${name}`, { cwd: root, stdio: 'inherit' });
  }
  const message = `Agent Deck ${version}`;
  execSync(`git tag -a ${name} ${commit} -m ${JSON.stringify(message)}`, {
    cwd: root,
    stdio: 'inherit',
  });
  console.log(`[release-tag] Tagged ${name} at ${commit}`);
  return true;
}

function pushTag(version) {
  const name = tagName(version);
  execSync(`git push origin ${name}`, { cwd: root, stdio: 'inherit' });
  console.log(`[release-tag] Pushed ${name}`);
}

function extractChangelogSection(version) {
  const changelogPath = path.join(root, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    return `Release ${version}`;
  }
  const changelog = fs.readFileSync(changelogPath, 'utf8');
  const escaped = version.replace(/\./g, '\\.');
  const match = changelog.match(
    new RegExp(`## ${escaped} — [^\\n]+\\n([\\s\\S]*?)(?=\\n## |$)`),
  );
  return match ? match[1].trim() : `Release ${version}`;
}

function createGithubRelease(version) {
  const name = tagName(version);
  if (!tagExists(name)) {
    console.error(`[release-tag] Cannot create GitHub release — ${name} does not exist locally`);
    process.exit(1);
  }
  try {
    execSync('gh --version', { stdio: 'ignore' });
  } catch {
    console.error('[release-tag] gh CLI not found — skip GitHub release or install gh');
    process.exit(1);
  }

  const notes = extractChangelogSection(version);
  const notesPath = path.join(root, '.temporal', 'logs', `release-notes-${version}.md`);
  fs.mkdirSync(path.dirname(notesPath), { recursive: true });
  fs.writeFileSync(notesPath, notes);

  try {
    execSync(`gh release view ${name}`, { cwd: root, stdio: 'ignore' });
    if (!force) {
      console.log(`[release-tag] GitHub release ${name} already exists (use --force to recreate)`);
      return;
    }
    execSync(`gh release delete ${name} --yes`, { cwd: root, stdio: 'inherit' });
  } catch {
    // release does not exist
  }

  execSync(
    `gh release create ${name} --title ${JSON.stringify(version)} --notes-file ${JSON.stringify(notesPath)}`,
    { cwd: root, stdio: 'inherit' },
  );
  console.log(`[release-tag] GitHub release ${name} created`);
}

function parseVersionFromShipSubject(subject) {
  const explicit = subject.match(/^Ship (\d+\.\d+\.\d+):/);
  if (explicit) {
    return explicit[1];
  }
  const trailing = subject.match(/(?:at|for) (\d+\.\d+\.\d+)\.?$/);
  if (trailing) {
    return trailing[1];
  }
  return null;
}

function discoverShipReleases() {
  const log = execSync('git log --format=%H%x09%s', { cwd: root, encoding: 'utf8' });
  const byVersion = new Map();

  for (const line of log.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const tab = line.indexOf('\t');
    const hash = line.slice(0, tab);
    const subject = line.slice(tab + 1);
    const version = parseVersionFromShipSubject(subject);
    if (version && !byVersion.has(version)) {
      byVersion.set(version, hash);
    }
  }

  for (const [version, commit] of Object.entries(BACKFILL_OVERRIDES)) {
    if (!byVersion.has(version)) {
      byVersion.set(version, commit);
    }
  }

  return [...byVersion.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
}

function runBackfill() {
  const releases = discoverShipReleases();
  if (releases.length === 0) {
    console.log('[release-tag] No Ship releases found to backfill');
    return;
  }

  console.log(`[release-tag] Backfilling ${releases.length} tag(s)…`);
  for (const [version, commit] of releases) {
    const created = createTag(version, commit);
    if (created && push) {
      pushTag(version);
    }
    if (created && githubRelease) {
      createGithubRelease(version);
    }
  }
}

function runSingle() {
  const version = positional[0] ?? readRootVersion();
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    console.error(`[release-tag] Invalid semver: ${version}`);
    process.exit(1);
  }

  const created = createTag(version, 'HEAD');
  if (created && push) {
    pushTag(version);
  }
  if (githubRelease) {
    createGithubRelease(version);
  }
}

if (backfill) {
  runBackfill();
} else {
  runSingle();
}
