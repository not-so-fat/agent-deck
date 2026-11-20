#!/usr/bin/env node
/**
 * The shared release commands: prepare / finish / check (NOT-646).
 *
 *   npm run release:prepare -- <patch|minor|major|X.Y.Z> --summary "<why>" [--dry]
 *   npm run release:finish
 *   npm run release:check [--root DIR]
 *
 * prepare cuts a release/X.Y.Z branch with one Ship commit: it syncs every
 * manifest, internal pin, server.json and lockfile entry, stubs the CHANGELOG
 * section from the commits since the previous tag, runs the release build
 * (tests + integration smoke), then pushes the branch and opens the PR.
 * finish merges that PR once CI is green, tags the merge commit vX.Y.Z and
 * pushes the tag. Everything after the tag push belongs to release.yml.
 * Re-running finish after the merge resumes at the tag step.
 * check fails on any version, pin, server.json, lockfile or changelog drift.
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(scriptDir, '..');

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(-[\w.]+)?$/;
const CHANGELOG_DASH = '—';

const WORKSPACE_MANIFESTS = [
  'packages/shared/package.json',
  'packages/backend/package.json',
  'packages/cli/package.json',
  'apps/agent-deck/package.json',
];
const WORKSPACE_DIRS = WORKSPACE_MANIFESTS.map((m) => path.dirname(m));

// [manifest, dependency] pairs pinned to ^<root version> by sync-versions.mjs.
const INTERNAL_PINS = [
  ['packages/cli/package.json', '@agent-deck/backend'],
  ['packages/cli/package.json', '@agent-deck/shared'],
  ['packages/backend/package.json', '@agent-deck/shared'],
];

const PLUGIN_MANIFESTS = [
  '.codex-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
];

// Files prepare stages into the Ship commit: everything sync-versions.mjs
// writes (keep in sync with scripts/sync-versions.mjs) plus the lockfile
// and the changelog.
const SHIP_FILES = [
  'package.json',
  ...WORKSPACE_MANIFESTS,
  'server.json',
  ...PLUGIN_MANIFESTS,
  '.claude-plugin/marketplace.json',
  'package-lock.json',
  'CHANGELOG.md',
];

function usage(exitCode = 1) {
  console.error(`Usage:
  npm run release:prepare -- <patch|minor|major|X.Y.Z> --summary "<why>" [--dry]
  npm run release:finish
  npm run release:check [--root DIR]

prepare cuts release/X.Y.Z from a clean, up-to-date main: versions, pins,
server.json, lockfile and CHANGELOG in one pass, then build:release, then a
Ship commit on a pushed branch with an open PR. --dry skips the push and the
PR creation and keeps the local commit.
finish merges the release PR after CI is green, tags the merge commit and
pushes the tag; release.yml takes it from there.
check fails on version, pin, server.json, lockfile or changelog drift.`);
  process.exit(exitCode);
}

function readJson(relativePath, base = root) {
  return JSON.parse(fs.readFileSync(path.join(base, relativePath), 'utf8'));
}

function parseSemver(version) {
  const match = SEMVER_RE.exec(version ?? '');
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? '' };
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) {
      return pa[key] - pb[key];
    }
  }
  if (pa.pre === pb.pre) {
    return 0;
  }
  if (pa.pre === '') {
    return 1;
  }
  if (pb.pre === '') {
    return -1;
  }
  return pa.pre < pb.pre ? -1 : 1;
}

function bumpVersion(current, level) {
  const p = parseSemver(current);
  if (level === 'major') {
    return `${p.major + 1}.0.0`;
  }
  if (level === 'minor') {
    return `${p.major}.${p.minor + 1}.0`;
  }
  return `${p.major}.${p.minor}.${p.patch + 1}`;
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function refExists(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function changelogHasSection(changelog, version) {
  const escaped = version.replace(/\./g, '\\.');
  return new RegExp(`^## ${escaped} ${CHANGELOG_DASH} [^\\n]+`, 'm').test(changelog);
}

function requireGh(command) {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
  } catch {
    console.error(`[${command}] gh CLI not found — install gh first.`);
    process.exit(1);
  }
}

function runCheck(checkRoot = root) {
  const failures = [];
  const ok = (message) => console.log(`[release:check] ok: ${message}`);
  const fail = (message) => {
    failures.push(message);
    console.error(`[release:check] FAIL: ${message}`);
  };
  const versionHint = 'keep-the-version rule: versions change only in a release:prepare Ship commit';

  let expected = null;
  try {
    expected = readJson('package.json', checkRoot).version;
  } catch (error) {
    fail(`cannot read package.json version: ${error.message}`);
  }
  if (expected !== null && !parseSemver(expected)) {
    fail(`root package.json version ${JSON.stringify(expected)} is not semver`);
    expected = null;
  }
  if (!expected) {
    console.error(`[release:check] ${failures.length} check(s) failed.`);
    return false;
  }

  for (const manifest of WORKSPACE_MANIFESTS) {
    let version = null;
    try {
      version = readJson(manifest, checkRoot).version;
    } catch {
      fail(`${manifest} is missing or unreadable`);
      continue;
    }
    if (version === expected) {
      ok(`${manifest} version ${version} matches`);
    } else {
      fail(`${manifest} version ${JSON.stringify(version)} differs from root ${expected} (${versionHint})`);
    }
  }

  for (const [manifest, dep] of INTERNAL_PINS) {
    let spec = null;
    let unreadable = false;
    try {
      spec = readJson(manifest, checkRoot).dependencies?.[dep] ?? null;
    } catch {
      unreadable = true;
    }
    if (unreadable) {
      fail(`${manifest} is missing or unreadable`);
    } else if (spec === `^${expected}`) {
      ok(`${manifest} pins ${dep} at ^${expected}`);
    } else {
      fail(`${manifest} pins ${dep} at ${JSON.stringify(spec)}, want ^${expected} (${versionHint})`);
    }
  }

  try {
    const server = readJson('server.json', checkRoot);
    if (server.version === expected) {
      ok(`server.json version ${server.version} matches`);
    } else {
      fail(`server.json version ${JSON.stringify(server.version)} differs from root ${expected} (${versionHint})`);
    }
    for (const pkg of Array.isArray(server.packages) ? server.packages : []) {
      if (pkg?.version === expected) {
        ok(`server.json package ${pkg.identifier ?? '(unknown)'} matches`);
      } else {
        fail(
          `server.json package ${pkg?.identifier ?? '(unknown)'} version ${JSON.stringify(pkg?.version)} differs from root ${expected}`,
        );
      }
    }
  } catch {
    fail('server.json is missing or unreadable');
  }

  for (const manifest of PLUGIN_MANIFESTS) {
    let version = null;
    try {
      version = readJson(manifest, checkRoot).version;
    } catch {
      fail(`${manifest} is missing or unreadable`);
      continue;
    }
    if (version === expected) {
      ok(`${manifest} version ${version} matches`);
    } else {
      fail(`${manifest} version ${JSON.stringify(version)} differs from root ${expected} (${versionHint})`);
    }
  }

  try {
    const marketplace = readJson('.claude-plugin/marketplace.json', checkRoot);
    const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
    if (plugins.length === 0) {
      fail('.claude-plugin/marketplace.json has no plugins entries');
    }
    for (const plugin of plugins) {
      if (plugin?.version === expected) {
        ok(`.claude-plugin/marketplace.json plugin ${plugin.name ?? '(unknown)'} matches`);
      } else {
        fail(
          `.claude-plugin/marketplace.json plugin ${plugin?.name ?? '(unknown)'} version ${JSON.stringify(plugin?.version)} differs from root ${expected}`,
        );
      }
    }
  } catch {
    fail('.claude-plugin/marketplace.json is missing or unreadable');
  }

  let lock = null;
  try {
    lock = readJson('package-lock.json', checkRoot);
  } catch {
    fail('package-lock.json is missing or unreadable');
  }
  if (lock) {
    if (lock.version === expected) {
      ok(`package-lock.json version ${lock.version} matches`);
    } else {
      fail(`package-lock.json version ${JSON.stringify(lock.version)} differs from root ${expected} (${versionHint})`);
    }
    const entries = lock.packages ?? {};
    for (const key of ['', ...WORKSPACE_DIRS]) {
      const entry = entries[key];
      const label = key === '' ? '<root>' : key;
      if (!entry) {
        fail(`package-lock.json packages[${JSON.stringify(key)}] is missing`);
      } else if (entry.version === expected) {
        ok(`package-lock.json packages[${label}] version matches`);
      } else {
        fail(`package-lock.json packages[${label}] version ${JSON.stringify(entry.version)} differs from root ${expected}`);
      }
    }
    for (const [manifest, dep] of INTERNAL_PINS) {
      const key = path.dirname(manifest);
      const spec = entries[key]?.dependencies?.[dep] ?? null;
      if (spec === `^${expected}`) {
        ok(`package-lock.json packages[${key}] pins ${dep} at ^${expected}`);
      } else {
        fail(`package-lock.json packages[${key}] pins ${dep} at ${JSON.stringify(spec)}, want ^${expected}`);
      }
    }
  }

  try {
    const changelog = fs.readFileSync(path.join(checkRoot, 'CHANGELOG.md'), 'utf8');
    if (changelogHasSection(changelog, expected)) {
      ok(`CHANGELOG.md has a ## ${expected} section`);
    } else {
      fail(`CHANGELOG.md has no ## ${expected} section`);
    }
  } catch {
    fail('CHANGELOG.md is missing or unreadable');
  }

  if (failures.length > 0) {
    console.error(`[release:check] ${failures.length} check(s) failed.`);
    return false;
  }
  console.log('[release:check] All checks passed.');
  return true;
}

function latestReleaseTag() {
  const tags = git(['tag', '--list', 'v*']).split('\n').map((t) => t.trim()).filter(Boolean);
  const versions = [];
  for (const tag of tags) {
    const version = tag.startsWith('v') ? tag.slice(1) : tag;
    if (parseSemver(version)) {
      versions.push(version);
    }
  }
  versions.sort(compareSemver);
  return versions.length > 0 ? `v${versions[versions.length - 1]}` : null;
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function stubChangelog(version, summary, subjects) {
  const changelogPath = path.join(root, 'CHANGELOG.md');
  const changelog = fs.readFileSync(changelogPath, 'utf8');
  const lines = changelog.split('\n');
  const section = [
    `## ${version} ${CHANGELOG_DASH} ${today()}`,
    '',
    summary,
    '',
    ...subjects.map((s) => `- ${s}`),
    '',
  ];
  const idx = lines.findIndex((line) => line.startsWith('## '));
  const next = idx === -1 ? [...lines, ...section] : [...lines.slice(0, idx), ...section, ...lines.slice(idx)];
  fs.writeFileSync(changelogPath, next.join('\n'));
  console.log(`[release:prepare] Stubbed CHANGELOG.md ## ${version} section (${subjects.length} commit(s) in range)`);
}

function parsePrepareArgs(args) {
  let summary = null;
  let dry = false;
  let level = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry') {
      dry = true;
    } else if (arg === '--summary') {
      summary = args[i + 1] ?? null;
      i++;
    } else if (arg.startsWith('--summary=')) {
      summary = arg.slice('--summary='.length);
    } else if (arg.startsWith('--')) {
      console.error(`[release:prepare] Unknown flag: ${arg}`);
      usage();
    } else if (level === null) {
      level = arg;
    } else {
      console.error(`[release:prepare] Unexpected argument: ${arg}`);
      usage();
    }
  }
  return { level, summary, dry };
}

function runPrepare(args) {
  const { level, summary: rawSummary, dry } = parsePrepareArgs(args);
  const summary = (rawSummary ?? '').replace(/\s+/g, ' ').trim();
  if (!level || (!['patch', 'minor', 'major'].includes(level) && !parseSemver(level))) {
    console.error('[release:prepare] Give a level or version: patch, minor, major or X.Y.Z.');
    usage();
  }
  if (!summary) {
    console.error('[release:prepare] --summary "<why>" is required (one line saying why this release exists).');
    usage();
  }
  const current = readJson('package.json').version;
  if (!parseSemver(current)) {
    console.error(`[release:prepare] Root package.json version ${JSON.stringify(current)} is not semver — refusing to bump.`);
    process.exit(1);
  }
  const target = ['patch', 'minor', 'major'].includes(level) ? bumpVersion(current, level) : level;
  if (compareSemver(target, current) <= 0) {
    console.error(`[release:prepare] Target ${target} is not newer than current ${current} — nothing to release.`);
    process.exit(1);
  }
  const releaseBranch = `release/${target}`;
  const shipMessage = `Ship ${target}: ${summary}`;

  if (git(['status', '--porcelain'])) {
    console.error('[release:prepare] Working tree is not clean — commit or stash first.');
    process.exit(1);
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!dry) {
    if (branch !== 'main') {
      console.error(`[release:prepare] Must run from main (on ${JSON.stringify(branch)}).`);
      process.exit(1);
    }
    requireGh('release:prepare');
    console.log('[release:prepare] Fetching origin ...');
    try {
      execFileSync('git', ['fetch', 'origin', '--tags'], { cwd: root, stdio: 'inherit' });
    } catch {
      console.error('[release:prepare] git fetch origin failed — check the network and re-run.');
      process.exit(1);
    }
    if (git(['rev-parse', 'main']) !== git(['rev-parse', 'origin/main'])) {
      console.error('[release:prepare] main is not up-to-date with origin/main — pull (or push) first.');
      process.exit(1);
    }
    if (git(['ls-remote', '--heads', 'origin', releaseBranch])) {
      console.error(`[release:prepare] Branch ${releaseBranch} already exists on origin.`);
      process.exit(1);
    }
  } else {
    console.log(`[release:prepare] Dry run on ${JSON.stringify(branch)}: skipping the main/up-to-date/origin checks.`);
  }
  if (refExists(`refs/heads/${releaseBranch}`)) {
    console.error(`[release:prepare] Branch ${releaseBranch} already exists locally — delete it or pick another version.`);
    process.exit(1);
  }
  if (refExists(`refs/tags/v${target}`)) {
    console.error(`[release:prepare] Tag v${target} already exists — refusing to re-release it.`);
    process.exit(1);
  }

  const prev = latestReleaseTag();
  const subjects = git(['log', prev ? `${prev}..HEAD` : 'HEAD', '--format=%s'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (subjects.length === 0) {
    console.error(
      `[release:prepare] No commits since ${prev ?? 'the root commit'} — nothing to release (keep-the-version rule: no new version without new changes).`,
    );
    process.exit(1);
  }
  console.log(`[release:prepare] ${prev ? `Changes since ${prev}` : 'All commits'} (${subjects.length}):`);
  for (const s of subjects) {
    console.log(`[release:prepare]   - ${s}`);
  }

  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  if (changelogHasSection(changelog, target)) {
    console.error(`[release:prepare] CHANGELOG.md already has a ## ${target} section.`);
    process.exit(1);
  }

  console.log(`[release:prepare] Syncing every manifest, pin, server.json and lockfile entry to ${target} ...`);
  execFileSync(process.execPath, ['scripts/sync-versions.mjs', target], { cwd: root, stdio: 'inherit' });
  stubChangelog(target, summary, subjects);

  console.log('[release:prepare] Verifying the bump ...');
  if (!runCheck()) {
    console.error('[release:prepare] release:check failed after the sync — the tree edits are uncommitted; `git restore .` discards them.');
    process.exit(1);
  }
  console.log('[release:prepare] Building + smoke-testing the release (build:release) ...');
  try {
    execSync('npm run build:release', { cwd: root, stdio: 'inherit' });
  } catch {
    console.error('[release:prepare] build:release failed — fix it, `git restore .` to discard the bump, and re-run prepare.');
    process.exit(1);
  }

  execFileSync('git', ['checkout', '-b', releaseBranch], { cwd: root, stdio: 'inherit' });
  const files = SHIP_FILES.filter((f) => fs.existsSync(path.join(root, f)));
  execFileSync('git', ['add', '--', ...files], { cwd: root, stdio: 'inherit' });
  execFileSync('git', ['commit', '-m', shipMessage], { cwd: root, stdio: 'inherit' });

  if (dry) {
    console.log(`[release:prepare] Dry run: kept ${JSON.stringify(shipMessage)} on ${releaseBranch}; skipped the push and the PR creation.`);
    console.log(`[release:prepare] A live run would now push ${releaseBranch} and open the release PR against main.`);
    return;
  }
  execFileSync('git', ['push', '-u', 'origin', releaseBranch], { cwd: root, stdio: 'inherit' });
  const body = [
    `Release ${target}.`,
    '',
    summary,
    '',
    `Changes since ${prev ?? 'the beginning'}:`,
    ...subjects.map((s) => `- ${s}`),
    '',
    'After CI is green, merge with `npm run release:finish`. Pushing the tag starts release.yml, which verifies the tag, runs the release build and smoke, publishes the packages, and attaches the GitHub Release notes from CHANGELOG.md.',
  ].join('\n');
  execFileSync(
    'gh',
    ['pr', 'create', '--base', 'main', '--head', releaseBranch, '--title', shipMessage, '--body', body],
    { cwd: root, stdio: 'inherit' },
  );
  console.log('[release:prepare] Done: branch pushed, release PR opened. After CI is green, run npm run release:finish.');
}

function runFinish(args) {
  if (args.length > 0) {
    console.error(`[release:finish] Unexpected argument: ${args[0]} (finish takes no arguments)`);
    usage();
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const match = /^release\/(\d+\.\d+\.\d+(-[\w.]+)?)$/.exec(branch);
  if (!match) {
    console.error(`[release:finish] Must run from a release/X.Y.Z branch (on ${JSON.stringify(branch)} — release:prepare cuts it).`);
    process.exit(1);
  }
  const version = match[1];
  if (git(['status', '--porcelain'])) {
    console.error('[release:finish] Working tree is not clean — commit or stash first.');
    process.exit(1);
  }
  requireGh('release:finish');
  let pr = null;
  try {
    pr = JSON.parse(
      execFileSync('gh', ['pr', 'view', branch, '--json', 'number,state,baseRefName,headRefName,url'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch {
    pr = null;
  }
  if (!pr || pr.headRefName !== branch) {
    console.error(`[release:finish] No PR found for ${branch} — push the branch and open the PR first (release:prepare does both).`);
    process.exit(1);
  }
  if (pr.state !== 'OPEN' && pr.state !== 'MERGED') {
    console.error(`[release:finish] PR #${pr.number} is ${pr.state}, not OPEN — nothing to finish.`);
    process.exit(1);
  }
  if (pr.baseRefName !== 'main') {
    console.error(`[release:finish] PR #${pr.number} targets ${JSON.stringify(pr.baseRefName)}, not main.`);
    process.exit(1);
  }
  if (pr.state === 'MERGED') {
    // A merge followed by a failed fetch or tag push (or a lost gh
    // response) leaves main bumped without the tag. Re-running finish
    // must resume at the tag step, not exit on the merged PR.
    console.log(`[release:finish] PR #${pr.number} is already MERGED — resuming at the tag step.`);
    tagMergedRelease(version, pr);
    return;
  }
  console.log(`[release:finish] Waiting for CI on PR #${pr.number} (${pr.url}) ...`);
  try {
    execFileSync('gh', ['pr', 'checks', String(pr.number), '--watch'], { cwd: root, stdio: 'inherit' });
  } catch {
    console.error('[release:finish] CI did not pass — fix it and re-run release:finish.');
    process.exit(1);
  }
  console.log(`[release:finish] CI is green. Squash-merging PR #${pr.number} ...`);
  try {
    execFileSync('gh', ['pr', 'merge', String(pr.number), '--squash'], { cwd: root, stdio: 'inherit' });
  } catch {
    console.error(
      `[release:finish] Could not merge PR #${pr.number} — resolve it and re-run release:finish (a lost gh response after a server-side merge resumes at the tag step).`,
    );
    process.exit(1);
  }
  tagMergedRelease(version, pr);
}

/** Best-effort merge-commit oid for a PR; null when gh cannot report one. */
function prMergeCommitOid(pr) {
  try {
    const out = execFileSync('gh', ['pr', 'view', String(pr.number), '--json', 'mergeCommit'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const oid = JSON.parse(out)?.mergeCommit?.oid ?? null;
    return typeof oid === 'string' && /^[0-9a-f]{40}$/i.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the commit to tag: the PR's merge commit when gh reports one
 * (main may have moved past it, so the tip is not always the merge),
 * else the origin/main tip after verifying it is the Ship commit.
 */
function resolveMergeTarget(version, pr) {
  const mergeOid = prMergeCommitOid(pr);
  if (mergeOid) {
    if (!refExists(mergeOid)) {
      console.error(
        `[release:finish] Merge commit ${mergeOid} for PR #${pr.number} is not in this clone even after fetching — check the network and re-run release:finish.`,
      );
      process.exit(1);
    }
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', mergeOid, 'origin/main'], { cwd: root, stdio: 'ignore' });
    } catch {
      console.error(`[release:finish] Merge commit ${mergeOid} for PR #${pr.number} is not on origin/main — refusing to tag it.`);
      process.exit(1);
    }
    const subject = git(['log', '-1', '--format=%s', mergeOid]);
    if (!subject.startsWith(`Ship ${version}`)) {
      console.error(
        `[release:finish] Merge commit ${mergeOid} subject is ${JSON.stringify(subject)}, not the Ship ${version} commit — refusing to tag it.`,
      );
      process.exit(1);
    }
    return mergeOid;
  }
  const subject = git(['log', '-1', '--format=%s', 'origin/main']);
  if (!subject.startsWith(`Ship ${version}`)) {
    console.error(`[release:finish] origin/main tip is ${JSON.stringify(subject)}, not the Ship ${version} commit — refusing to tag it.`);
    process.exit(1);
  }
  return git(['rev-parse', 'origin/main']);
}

/**
 * Fetch, then idempotently create and push vX.Y.Z on the merge commit.
 * Safe to re-run: an existing tag on the right commit is kept and pushed.
 */
function tagMergedRelease(version, pr) {
  console.log('[release:finish] Fetching the merge commit ...');
  try {
    execFileSync('git', ['fetch', 'origin', '--tags'], { cwd: root, stdio: 'inherit' });
  } catch {
    console.error('[release:finish] git fetch failed — the PR is merged; check the network and re-run release:finish to resume at the tag step.');
    process.exit(1);
  }
  const tag = `v${version}`;
  const target = resolveMergeTarget(version, pr);
  if (refExists(`refs/tags/${tag}`)) {
    let existing = null;
    try {
      existing = git(['rev-parse', `${tag}^{}`]);
    } catch {
      existing = null;
    }
    if (existing === target) {
      console.log(`[release:finish] Tag ${tag} already exists on the merge commit — ensuring it is pushed.`);
    } else {
      console.error(`[release:finish] Tag ${tag} already exists${existing ? ` on ${existing}` : ''}, not the merge commit ${target} — refusing to move it.`);
      process.exit(1);
    }
  } else {
    try {
      execFileSync('git', ['tag', '-a', tag, target, '-m', `Agent Deck ${version}`], { cwd: root, stdio: 'inherit' });
    } catch {
      console.error(`[release:finish] Could not create tag ${tag} — re-run release:finish to retry.`);
      process.exit(1);
    }
  }
  try {
    execFileSync('git', ['push', 'origin', tag], { cwd: root, stdio: 'inherit' });
  } catch {
    console.error(`[release:finish] Could not push tag ${tag} — re-run release:finish to retry the push.`);
    process.exit(1);
  }
  console.log(
    `[release:finish] Done: ${tag} pushed. release.yml verifies the tag, runs the release build and smoke, publishes the packages, and attaches the GitHub Release notes — watch the run, then check npm view for each package.`,
  );
}

const [command, ...rest] = process.argv.slice(2);
if (!command || command === '--help' || command === '-h') {
  usage(!command ? 1 : 0);
} else if (command === 'prepare') {
  runPrepare(rest);
} else if (command === 'finish') {
  runFinish(rest);
} else if (command === 'check') {
  const rootFlagIndex = rest.indexOf('--root');
  let checkRoot = root;
  let extra = rest;
  if (rootFlagIndex >= 0) {
    const dir = rest[rootFlagIndex + 1];
    if (!dir || dir.startsWith('--')) {
      console.error('[release:check] --root needs a directory.');
      usage();
    }
    checkRoot = path.resolve(dir);
    extra = rest.filter((_, i) => i !== rootFlagIndex && i !== rootFlagIndex + 1);
  }
  if (extra.length > 0) {
    console.error(`[release:check] Unexpected argument: ${extra[0]} (check takes only --root DIR)`);
    usage();
  }
  if (!runCheck(checkRoot)) {
    process.exit(1);
  }
} else {
  console.error(`Unknown command: ${command}`);
  usage();
}
