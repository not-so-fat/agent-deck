/**
 * Claude worker policy for headless Agent Deck runs (NOT-672).
 *
 * Maps the shared `WORKER_PROFILES` definition (`profiles.ts`) onto the
 * Claude Agent SDK surface: isolated worker settings, `dontAsk`, explicit
 * tool lists, and profile allow/deny rules. Enforcement lives here and in
 * the SDK permission system the generated settings drive — never in prompt
 * instructions.
 *
 * Two layers, same policy, in force wherever the SDK consults them:
 *
 * - Declarative: `claudeSettingsForProfile` (flag-layer settings with
 *   `permissions.allow/deny`, `ask: []`, `defaultMode: "dontAsk"`,
 *   `additionalDirectories`) plus the mirrored `allowedTools` list and
 *   `settingSources: []` (no project/user settings leak in). Under
 *   `dontAsk` anything without an allow rule is denied immediately — no
 *   prompt surface, no waits. `disallowedTools` stays empty on purpose:
 *   denied tools stay visible so an attempt surfaces as a recorded denial
 *   instead of the model routing around a hidden tool.
 * - Programmatic: `decideClaudeToolCall`, wired as the SDK `canUseTool`
 *   handler by `claude.ts`. It re-checks every consulted call against the
 *   same policy — including the read-only shell classifier
 *   (`isReadonlyShellCommand`), which sees compound commands, redirections,
 *   and per-tool flags the prefix patterns cannot express.
 *
 * The layers agree exactly on what each profile allows; where they differ
 * is precision, never verdict direction. The operator acceptance runs
 * (compound Bash, git, gh, curl, Python, WebFetch, Monitor against
 * fixtures) pin which layer fires on the installed SDK — either way the
 * verdict is the profile's.
 *
 * Node built-ins and sibling modules only (see the module-boundary test).
 */
import fs from 'node:fs';
import path from 'node:path';

import { WORKER_PROFILES, type RunToolsProfile } from './profiles';
import type { RunDenialKind } from './records';

/** Worker runs never prompt: deny anything not pre-approved. */
export const CLAUDE_WORKER_PERMISSION_MODE = 'dontAsk';

/**
 * Worker runs load no filesystem settings (SDK isolation mode): neither
 * the user's `~/.claude/settings.json` nor the checkout's project settings
 * can widen the worker profile.
 */
export const CLAUDE_WORKER_SETTING_SOURCES: readonly string[] = [];

/** No skills are enabled on worker runs in either profile. */
export const CLAUDE_WORKER_SKILLS: readonly string[] = [];

/** The inline per-run MCP server name (must match `claude.ts`). */
export const CLAUDE_WORKER_MCP_SERVER = 'agent-deck';

/** `mcp__<server>__<tool>` prefix for the worker MCP server's tools. */
export const CLAUDE_WORKER_MCP_TOOL_PREFIX = `mcp__${CLAUDE_WORKER_MCP_SERVER}__`;

/**
 * Built-in tools both profiles allow: reads, web reads (WebFetch is
 * GET-only by schema; WebSearch is a read), and session-state todos (not a
 * filesystem write and not an outbound mutation).
 */
export const CLAUDE_WORKER_BASE_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
];

/** Built-in tools only edit allows: writes, subagents, task tracking, watches. */
export const CLAUDE_EDIT_ONLY_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'NotebookEdit',
  'Agent',
  'Monitor',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
];

/**
 * Explicit deny rules for readonly: file writes, subagents (permission
 * inheritance into subagents is unverified, so readonly runs none),
 * Monitor (profile `monitor: false`), question prompts (a headless worker
 * must never wait on a human), and skill execution (no skills enabled).
 * Everything else unlisted is denied by `dontAsk` by default.
 */
export const CLAUDE_READONLY_DENY_RULES: readonly string[] = [
  'Edit',
  'Write',
  'NotebookEdit',
  'Agent',
  'Monitor',
  'AskUserQuestion',
  'Skill',
];

/**
 * Explicit deny rules for edit: question prompts and skill execution only.
 * Everything else unlisted is denied by `dontAsk` by default.
 */
export const CLAUDE_EDIT_DENY_RULES: readonly string[] = ['AskUserQuestion', 'Skill'];

/**
 * Read-only shell: commands whose every invocation is a read (no flag can
 * turn them into a write, an execution vector, or a secret printer).
 * Single source for the declarative `Bash(<cmd>:*)` patterns and the
 * classifier below — the two can never drift.
 *
 * Deliberately absent (fail-closed, each covered by a fixture):
 * - `curl`/`wget`: the prefix patterns cannot express GET-only, and the
 *   classifier cannot run where the SDK never consults it — web reads go
 *   through WebFetch/WebSearch instead.
 * - `python*`/`node`/`npm exec`/`sh -c` and friends: arbitrary code whose
 *   effects cannot be proven read-only statically.
 * - `env`/`printenv`/`set`/`export`/`declare`: print secrets.
 * - `awk`/`sed`/`yq`: script or `-i` vectors (`sed` also runs shell via
 *   the `e` command and `-f` scripts, which no flag check can bound).
 * - `find`/`sort`/`uniq`/`tar`/`rg`/`base64`: flag-dependent writes or
 *   execution (`-delete`/`-exec`, `-o`/`-T`, two-positional output,
 *   `-x`, `--pre`, macOS `-o`) — allowed only through the precise
 *   classifier forms, never through a coarse prefix pattern.
 * - `sudo`/`ssh`/`docker`/`psql` and friends: privilege, network, or
 *   stateful side effects.
 */
export const CLAUDE_READONLY_SIMPLE_COMMANDS: readonly string[] = [
  'arch',
  'bzcat',
  'bzgrep',
  'cal',
  'cat',
  'cksum',
  'column',
  'comm',
  'cut',
  'df',
  'diff',
  'dirs',
  'du',
  'echo',
  'expand',
  'false',
  'file',
  'fold',
  'grep',
  'groups',
  'gzcat',
  'head',
  'hexdump',
  'history',
  'id',
  'jobs',
  'join',
  'jq',
  'less',
  'locale',
  'ls',
  'dir',
  'vdir',
  'md5sum',
  'more',
  'nl',
  'od',
  'paste',
  'pgrep',
  'pidof',
  'popd',
  'printf',
  'ps',
  'pushd',
  'pwd',
  'rev',
  'seq',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'shasum',
  'sleep',
  'stat',
  'strings',
  'sum',
  'sw_vers',
  'tac',
  'tail',
  'test',
  'tr',
  'true',
  'type',
  'ulimit',
  'umask',
  'uname',
  'unexpand',
  'uptime',
  'wc',
  'which',
  'whereis',
  'whoami',
  'xzcat',
  'xzgrep',
  'zcat',
  'zcmp',
  'zdiff',
  'zgrep',
  'zipinfo',
  'zless',
  'zmore',
  'cd',
];

/**
 * Read-only shell, flag-sensitive half: commands allowed only in precise
 * forms the classifier checks argument by argument. `date` (`-s` sets the
 * clock — privileged-only, but still excluded from the coarse patterns),
 * `hostname` (bare args set the hostname), `base64` (macOS `-o` writes a
 * file), `rg` (`--pre`/`--hostname-bin` execute a command), `sort`
 * (`-o`/`-T`/`--compress-program` write or execute), `uniq` (a second
 * positional arg is an output file), `find` (`-exec*`/`-delete`/`-fprint*`),
 * `tar` (extract/create/append/update and `--to-command`), and `unzip`
 * (extract modes) stay out of the declarative patterns unless a pinned
 * safe form exists below — the classifier is their only path.
 */
export const CLAUDE_READONLY_SPECIAL_COMMANDS: readonly string[] = [
  'base64',
  'date',
  'find',
  'git',
  'gh',
  'hostname',
  'npm',
  'rg',
  'sort',
  'tar',
  'uniq',
  'unzip',
];

/**
 * Read-only `git`: subcommands whose every argument form is a read. Kept in
 * one list so the declarative patterns and the classifier share it.
 * Arg-sensitive subcommands (`branch`, `tag`, `config`, `stash`, `clean`,
 * `apply`, `archive`, `remote`, `worktree`, `submodule`, `notes`, `grep`)
 * are NOT here: the classifier gates their precise safe forms, and only
 * the flag-pinned safe forms below get declarative patterns.
 *
 * Two documented residuals on the coarse patterns (verified against git
 * 2.x `--help`): `diff`/`log`/`show` accept `--output=<file>` (writes that
 * subcommand's own output to a file — limited content, never arbitrary
 * bytes), and honor an external diff driver from repo config/attributes.
 * The classifier rejects `--output` and rewrites in `--no-ext-diff` where
 * consulted; the operator runs use benign fixtures without hostile
 * attributes. `grep` stays out entirely: `--open-files-in-pager` executes
 * an arbitrary command, so only the classifier's exact form runs it.
 */
export const CLAUDE_READONLY_GIT_READ_SUBCOMMANDS: readonly string[] = [
  'blame',
  'check-attr',
  'check-ignore',
  'describe',
  'diff',
  'help',
  'log',
  'ls-files',
  'ls-remote',
  'name-rev',
  'rev-parse',
  'shortlog',
  'show',
  'status',
  'var',
  'verify-commit',
  'verify-tag',
  'version',
];

/**
 * Read-only `git`: flag-pinned safe forms of arg-sensitive subcommands.
 * Each pins a read-only flag, so no argument suffix can turn it into a
 * write (`git stash list` and friends take display-only options).
 */
export const CLAUDE_READONLY_GIT_PINNED_FORMS: readonly string[] = [
  'apply --check',
  'apply --numstat',
  'apply --stat',
  'apply --summary',
  'config --get',
  'config --get-all',
  'config --get-regexp',
  'config --list',
  'notes list',
  'stash list',
  'submodule status',
  'worktree list',
];

/**
 * Read-only `gh`: read-only subcommand paths. `api` is absent (arbitrary
 * method), `auth status` is absent (the pattern cannot exclude
 * `--show-token`, which prints the credential — the classifier allows the
 * exact form), and every listed form rejects `-w`/`--web` in the
 * classifier (a declarative pattern cannot exclude it either, so `--web`
 * opening a browser tab is the accepted residual there).
 */
export const CLAUDE_READONLY_GH_READ_PATHS: readonly string[] = [
  'gist list',
  'gist view',
  'issue list',
  'issue status',
  'issue view',
  'pr checks',
  'pr diff',
  'pr list',
  'pr status',
  'pr view',
  'release list',
  'release view',
  'repo view',
  'run list',
  'run view',
  'search',
  'status',
];

/** Read-only `npm`: registry reads and local listings only. */
export const CLAUDE_READONLY_NPM_READ_SUBCOMMANDS: readonly string[] = [
  'la',
  'list',
  'll',
  'ls',
  'ping',
  'prefix',
  'root',
  'view',
];

/**
 * Read-only `unzip`: list and stdout-only modes. Bare `unzip` extracts, so
 * it has no pattern — the classifier requires one of these flags.
 */
export const CLAUDE_READONLY_UNZIP_LIST_FLAGS: readonly string[] = ['-c', '-l', '-p', '-v', '-Z'];

/** Format one `Bash(<prefix>:*)` permission pattern. */
export function bashPattern(prefix: string): string {
  return `Bash(${prefix}:*)`;
}

/**
 * Declarative read-only Bash patterns: one per simple command plus the
 * pinned safe forms. Every pattern is safe even if the SDK matches it as a
 * bare prefix: the pinned forms name a read-only flag or subcommand, and
 * no simple command has a write mode under any suffix. Compound safety
 * (whether `ls; evil` matches `Bash(ls:*)`) is a matcher property the
 * operator runs verify; the classifier below splits compounds regardless.
 */
export function claudeReadonlyBashPatterns(): string[] {
  const patterns = CLAUDE_READONLY_SIMPLE_COMMANDS.map(bashPattern);
  for (const sub of CLAUDE_READONLY_GIT_READ_SUBCOMMANDS) {
    patterns.push(bashPattern(`git ${sub}`));
  }
  for (const form of CLAUDE_READONLY_GIT_PINNED_FORMS) {
    patterns.push(bashPattern(`git ${form}`));
  }
  patterns.push(bashPattern('git --version'), bashPattern('git --help'));
  for (const form of CLAUDE_READONLY_GH_READ_PATHS) {
    patterns.push(bashPattern(`gh ${form}`));
  }
  patterns.push(bashPattern('gh --version'));
  for (const sub of CLAUDE_READONLY_NPM_READ_SUBCOMMANDS) {
    patterns.push(bashPattern(`npm ${sub}`));
  }
  patterns.push(bashPattern('npm --version'));
  for (const flag of CLAUDE_READONLY_UNZIP_LIST_FLAGS) {
    patterns.push(bashPattern(`unzip ${flag}`));
  }
  patterns.push(bashPattern('command -v'), bashPattern('command -V'));
  return patterns;
}

/** `mcp__agent-deck__<tool>` for every tool `profile` allows. */
export function claudeMcpToolRules(profile: RunToolsProfile): string[] {
  return WORKER_PROFILES[profile].mcpAllowTools.map((tool) => `${CLAUDE_WORKER_MCP_TOOL_PREFIX}${tool}`);
}

// ---------------------------------------------------------------------------
// Read-only shell classifier
// ---------------------------------------------------------------------------

/**
 * Why a command failed the read-only shell check. `segment` is the 0-based
 * index of the compound segment that failed (compounds split on `;`, `&&`,
 * `||`, `|`, `&`, and newlines).
 */
export type ReadonlyShellDenial = { allowed: false; reason: string; segment: number };
export type ReadonlyShellVerdict =
  | { allowed: true; rewrittenCommand?: string }
  | ReadonlyShellDenial;

type ScanQuote = 'none' | 'single' | 'double';

/**
 * Split `command` into compound segments, tracking quote state so separators
 * inside quotes never split. Also fails closed on constructs the allowlist
 * cannot bound: command substitution (`$(`, backtick — rejected even inside
 * double quotes, where it still expands), arithmetic expansion (`$((`),
 * subshells (`(`/`)` unquoted), and output redirections (`>`, `>>`, `>|`,
 * `<>`, `&>`, and `>&`/`<&` except the fd-duplication form `N>&M`/`N<&M`).
 * Input redirections (`<`, `<<<`) and pipes are reads and pass through.
 */
type ShellSplit = { segments: string[]; separators: string[] };

function splitShellSegments(command: string): { denied: string } | ShellSplit {
  const segments: string[] = [];
  const separators: string[] = [];
  let current = '';
  let quote: ScanQuote = 'none';
  let i = 0;
  const push = (separator: string): void => {
    segments.push(current);
    separators.push(separator);
    current = '';
  };
  while (i < command.length) {
    const char = command[i];
    const next = command[i + 1] ?? '';
    if (quote === 'single') {
      current += char;
      if (char === "'") {
        quote = 'none';
      }
      i += 1;
      continue;
    }
    // Single quotes never reach here (handled above).
    if (char === '\\') {
      // Backslash escapes the next char (including newlines); a trailing
      // backslash is a literal.
      current += char;
      if (i + 1 < command.length) {
        current += command[i + 1];
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (char === "'" && quote === 'none') {
      quote = 'single';
      current += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      quote = quote === 'double' ? 'none' : 'double';
      current += char;
      i += 1;
      continue;
    }
    // Command substitution expands even inside double quotes: only single
    // quotes contain it, and single quotes never reach this branch.
    // Arithmetic first: `$((` would otherwise match the `$(` check.
    if (char === '$' && next === '(' && command[i + 2] === '(') {
      return { denied: 'arithmetic expansion is not allowed in the read-only shell' };
    }
    if (char === '`' || (char === '$' && (next === '(' || next === '`'))) {
      return { denied: 'command substitution is not allowed in the read-only shell' };
    }
    if (quote === 'double') {
      current += char;
      i += 1;
      continue;
    }
    if (char === '(' || char === ')') {
      return { denied: `subshells are not allowed in the read-only shell (found "${char}")` };
    }
    // Separators (longest match first): && || ;; | |& & ; newline.
    if (char === '&' && next === '&') {
      push('&&');
      i += 2;
      continue;
    }
    if (char === '|' && next === '|') {
      push('||');
      i += 2;
      continue;
    }
    if (char === ';' && next === ';') {
      push(';;');
      i += 2;
      continue;
    }
    if (char === '|' && next === '&') {
      push('|&');
      i += 2;
      continue;
    }
    if (char === '|' || char === '&' || char === ';' || char === '\n') {
      push(char);
      i += 1;
      continue;
    }
    // Redirections: input forms pass; every output form fails closed
    // except fd duplication (`N>&M`, `N<&M` with digits after the operator,
    // e.g. `2>&1` — a bare `>` or `>&file` writes to a file and is denied).
    if (char === '>') {
      if (next === '&' && /^[0-9]+/.test(command.slice(i + 2))) {
        const digits = command.slice(i + 2).match(/^[0-9]+/)?.[0] ?? '';
        current += command.slice(i, i + 2 + digits.length);
        i += 2 + digits.length;
        continue;
      }
      return { denied: 'output redirection is not allowed in the read-only shell' };
    }
    if (char === '<') {
      if (next === '>' || next === '&') {
        if (next === '&') {
          const after = command.slice(i + 2).match(/^[0-9]+/)?.[0] ?? '';
          if (after) {
            current += command.slice(i, i + 2 + after.length);
            i += 2 + after.length;
            continue;
          }
        }
        return { denied: 'output redirection is not allowed in the read-only shell' };
      }
      // `<` and `<<<` read: pass through.
      current += char;
      i += 1;
      continue;
    }
    current += char;
    i += 1;
  }
  segments.push(current);
  return { segments, separators };
}

/** Rejoin a split: `segments[0] + separators[0] + segments[1] + ...`. */
function joinShellSplit(split: ShellSplit): string {
  let out = split.segments[0] ?? '';
  for (let i = 0; i < split.separators.length; i += 1) {
    out += split.separators[i] + (split.segments[i + 1] ?? '');
  }
  return out;
}

/**
 * Split one segment into words (quote-aware, quotes and escapes resolved).
 * Returns null when quotes are left unterminated — fail closed.
 */
function splitSegmentWords(segment: string): string[] | null {
  const words: string[] = [];
  let current = '';
  let quote: ScanQuote = 'none';
  let hasCurrent = false;
  let i = 0;
  while (i < segment.length) {
    const char = segment[i];
    if (quote === 'single') {
      if (char === "'") {
        quote = 'none';
      } else {
        current += char;
      }
      i += 1;
      continue;
    }
    // Single quotes never reach here (handled above).
    if (char === '\\') {
      if (i + 1 < segment.length) {
        // Outside quotes a backslash-newline is a line continuation.
        if (quote === 'none' && segment[i + 1] === '\n') {
          i += 2;
          continue;
        }
        current += segment[i + 1];
        hasCurrent = true;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (char === "'" && quote === 'none') {
      quote = 'single';
      hasCurrent = true;
      i += 1;
      continue;
    }
    if (char === '"') {
      quote = quote === 'double' ? 'none' : 'double';
      hasCurrent = true;
      i += 1;
      continue;
    }
    if (quote === 'none' && (char === ' ' || char === '\t' || char === '\r' || char === '\n')) {
      if (hasCurrent) {
        words.push(current);
        current = '';
        hasCurrent = false;
      }
      i += 1;
      continue;
    }
    current += char;
    hasCurrent = true;
    i += 1;
  }
  if (quote !== 'none') {
    return null;
  }
  if (hasCurrent) {
    words.push(current);
  }
  return words;
}

/** Basename of a command word (`/bin/ls` → `ls`). */
function commandName(word: string): string {
  const slash = word.lastIndexOf('/');
  return slash === -1 ? word : word.slice(slash + 1);
}

function isShortFlag(token: string): boolean {
  return token.startsWith('-') && !token.startsWith('--') && token.length > 1;
}

/** Non-flag words (positionals), skipping nothing. */
function positionalArgs(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith('-') || arg === '-');
}

function isGitOutputWrite(token: string): boolean {
  return token === '--output' || token.startsWith('--output=');
}

function isGitPagerExec(token: string): boolean {
  return token === '--open-files-in-pager' || token.startsWith('--open-files-in-pager=');
}

/**
 * Read-only `git` gate. No global flags are skipped (`-c` sets config and
 * would need value parsing, so any leading flag fails closed and the model
 * retries bare): `args[0]` is the subcommand or a bare-form flag.
 */
function isReadonlyGitArgs(args: string[]): boolean {
  if (args.length === 0) {
    return true;
  }
  const [sub, ...rest] = args;
  if (sub === '--version' || sub === '--help' || sub === '-h') {
    return args.length === 1;
  }
  if ((CLAUDE_READONLY_GIT_READ_SUBCOMMANDS as readonly string[]).includes(sub)) {
    // `diff`/`log`/`show` take `--output=<file>`; `grep` is not in the
    // read list at all (see below).
    if (sub === 'diff' || sub === 'log' || sub === 'show') {
      return !rest.some(isGitOutputWrite);
    }
    return true;
  }
  switch (sub) {
    case 'grep':
      return !rest.some(isGitPagerExec);
    case 'remote':
      return rest.length === 0 || rest.every((arg) => arg === '-v' || arg === '--verbose');
    case 'config': {
      if (rest.some((arg) => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(arg))) {
        return true;
      }
      if (rest.some((arg) => ['--add', '--unset', '--unset-all', '--replace-all', '--remove-section', '--rename-section'].includes(arg))) {
        return false;
      }
      return positionalArgs(rest).length === 1;
    }
    case 'stash':
    case 'notes':
      return rest.length === 1 && rest[0] === 'list';
    case 'worktree':
      return rest.length === 1 && rest[0] === 'list';
    case 'submodule':
      return rest.length === 1 && rest[0] === 'status';
    case 'apply':
      return rest.some((arg) => ['--check', '--stat', '--numstat', '--summary'].includes(arg));
    case 'branch': {
      // List forms only: a bare name creates a branch. Bundled shorts
      // (`-av`) expand character by character.
      const valueFlags = new Set(['--merged', '--no-merged', '--contains', '--no-contains', '--list']);
      const bareFlags = new Set(['--all', '--remotes', '--show-current', '--verbose']);
      const bareShorts = new Set(['a', 'r', 'v']);
      for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i];
        if (bareFlags.has(arg)) {
          continue;
        }
        if (isShortFlag(arg) && [...arg.slice(1)].every((flag) => bareShorts.has(flag))) {
          continue;
        }
        if (valueFlags.has(arg)) {
          i += 1; // A branch-name value (or nothing for bare `--list`).
          continue;
        }
        return false;
      }
      return true;
    }
    case 'tag': {
      // Bare lists; `-l`/`--list` list with an optional pattern; anything
      // else (including a bare name, which creates) fails closed.
      if (rest.length === 0) {
        return true;
      }
      let listed = false;
      for (const arg of rest) {
        if (arg === '-l' || arg === '--list' || arg.startsWith('--list=')) {
          listed = true;
          continue;
        }
        if (arg === '-n') {
          continue;
        }
        if (arg.startsWith('-')) {
          return false;
        }
        if (!listed) {
          return false;
        }
      }
      return true;
    }
    case 'clean': {
      // Dry-run only: `-n` must be present as a real flag (not as `-e`'s
      // value), and every flag must be a display/scope flag (`-i` is
      // interactive and never allowed). Bundled shorts expand
      // character by character, with `-e` consuming the rest of its
      // token as the exclude pattern (getopt-style).
      const cleanLongs = new Set(['--dry-run', '--force', '--quiet']);
      const cleanShorts = new Set(['n', 'd', 'f', 'x', 'X', 'q']);
      let hasDryRun = false;
      for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i];
        if (arg === '--dry-run') {
          hasDryRun = true;
          continue;
        }
        if (cleanLongs.has(arg)) {
          continue;
        }
        if (arg === '-e') {
          i += 1; // The exclude pattern value.
          continue;
        }
        if (!isShortFlag(arg)) {
          return false;
        }
        for (const flag of arg.slice(1)) {
          if (flag === 'e') {
            break; // The rest of the token is the exclude pattern.
          }
          if (!cleanShorts.has(flag)) {
            return false;
          }
          if (flag === 'n') {
            hasDryRun = true;
          }
        }
      }
      return hasDryRun;
    }
    case 'archive': {
      // Stdout only: no `-o`/`--output`, no `--exec`.
      return !rest.some(
        (arg) =>
          arg.startsWith('--output') ||
          arg.startsWith('--exec') ||
          (isShortFlag(arg) && arg.includes('o')),
      );
    }
    default:
      return false;
  }
}

/**
 * Read-only `gh` gate: `args[0]` is the subcommand group. No global flags
 * are skipped (same fail-closed retry as git).
 */
function isReadonlyGhArgs(args: string[]): boolean {
  if (args.length === 0) {
    return true;
  }
  const [sub, ...rest] = args;
  if (sub === '--version' || sub === '--help' || sub === '-h') {
    return args.length === 1;
  }
  // `--web` opens a browser tab: rejected on every allowed form.
  if (
    rest.some(
      (arg) => arg === '--web' || arg.startsWith('--web=') || (isShortFlag(arg) && arg.includes('w')),
    )
  ) {
    return false;
  }
  switch (sub) {
    case 'pr':
      return rest.length > 0 && ['view', 'list', 'status', 'checks', 'diff'].includes(rest[0]);
    case 'issue':
      return rest.length > 0 && ['view', 'list', 'status'].includes(rest[0]);
    case 'repo':
      return rest.length > 0 && rest[0] === 'view';
    case 'release':
      return rest.length > 0 && ['view', 'list'].includes(rest[0]);
    case 'run':
      return rest.length > 0 && ['view', 'list'].includes(rest[0]);
    case 'gist':
      return rest.length > 0 && ['view', 'list'].includes(rest[0]);
    case 'search':
      return true;
    case 'auth':
      // Exact: `--show-token` prints the credential.
      return rest.length === 1 && rest[0] === 'status';
    case 'status':
      return rest.length === 0;
    default:
      return false;
  }
}

/** Read-only `npm`: registry reads and local listings only. */
function isReadonlyNpmArgs(args: string[]): boolean {
  if (args.length === 0) {
    return true;
  }
  const [sub, ...rest] = args;
  if (args.length === 1 && (sub === '--version' || sub === '-v' || sub === '--help' || sub === '-h')) {
    return true;
  }
  return (CLAUDE_READONLY_NPM_READ_SUBCOMMANDS as readonly string[]).includes(sub);
}

/** Read-only `tar`: list mode, no write mode, no command execution. */
function isReadonlyTarArgs(args: string[]): boolean {
  let hasList = false;
  for (const arg of args) {
    // Both spellings: GNU tar also accepts old-style single-dash longs,
    // and under a bundled-short reading `-to-command` carries a `-t` (fake
    // list mode) plus `-o` (output file) — so `o` is rejected too even
    // though it is inert beside a real `-t`.
    const long = arg.replace(/^-+/, '--');
    if (long.startsWith('--to-command') || long.startsWith('--use-compress-program') || long.startsWith('--checkpoint-action')) {
      return false;
    }
    if (arg === '--list') {
      hasList = true;
      continue;
    }
    if (arg.startsWith('--')) {
      if (['--extract', '--get', '--create', '--append', '--update', '--delete', '--concatenate'].includes(arg)) {
        return false;
      }
      continue;
    }
    if (isShortFlag(arg)) {
      if (arg.includes('t')) {
        hasList = true;
      }
      if ([...arg].some((flag) => ['x', 'c', 'r', 'u', 'A', 'I', 'o', 'w'].includes(flag))) {
        return false;
      }
    }
  }
  return hasList;
}

/** Read-only `unzip`: list and stdout-only modes, never extract-to-disk flags. */
function isReadonlyUnzipArgs(args: string[]): boolean {
  let hasListMode = false;
  for (const arg of args) {
    if (!isShortFlag(arg)) {
      continue;
    }
    const flags = [...arg.slice(1)];
    if (flags.some((flag) => ['l', 'Z', 'p', 'c', 'v'].includes(flag))) {
      hasListMode = true;
    }
    if (flags.some((flag) => ['d', 'o', 'n', 'u'].includes(flag))) {
      return false;
    }
  }
  return hasListMode;
}

/** Read-only `find`: no `-exec*`/`-ok*`, no `-delete`, no file-printing actions. */
function isReadonlyFindArgs(args: string[]): boolean {
  return !args.some((arg) =>
    ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fls', '-fprint', '-fprint0', '-fprintf'].includes(arg),
  );
}

/** Read-only `sort`: no `-o`/`-T`, no `--compress-program`. */
function isReadonlySortArgs(args: string[]): boolean {
  return !args.some(
    (arg) =>
      arg.startsWith('--output') ||
      arg.startsWith('--temporary-directory') ||
      arg.startsWith('--compress-program') ||
      (isShortFlag(arg) && (arg.includes('o') || arg.includes('T'))),
  );
}

/** Read-only `uniq`: at most one positional (a second is an output file). */
function isReadonlyUniqArgs(args: string[]): boolean {
  let positionals = 0;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-f' || arg === '-s' || arg === '-w') {
      i += 1; // The skip-count value.
      continue;
    }
    if (arg === '--') {
      positionals += args.length - (i + 1);
      break;
    }
    if (arg.startsWith('-') && arg !== '-') {
      continue;
    }
    positionals += 1;
  }
  return positionals <= 1;
}

/** Read-only `date`: never `-s`/`--set` (sets the clock). */
function isReadonlyDateArgs(args: string[]): boolean {
  return !args.some((arg) => arg.startsWith('--set') || (isShortFlag(arg) && arg.includes('s')));
}

/** Read-only `hostname`: bare or display-only flags (any other arg sets it). */
function isReadonlyHostnameArgs(args: string[]): boolean {
  return args.every((arg) => ['-f', '--fqdn', '--short', '-s'].includes(arg));
}

/** Read-only `rg`: never `--pre*`/`--hostname-bin` (execute a command). */
function isReadonlyRgArgs(args: string[]): boolean {
  return !args.some((arg) => arg.startsWith('--pre') || arg.startsWith('--hostname-bin'));
}

/** Read-only `base64`: never `-o`/`--output` (macOS writes a file). */
function isReadonlyBase64Args(args: string[]): boolean {
  return !args.some((arg) => arg.startsWith('--output') || (isShortFlag(arg) && arg.includes('o')));
}

const READONLY_SIMPLE_COMMAND_SET: ReadonlySet<string> = new Set(CLAUDE_READONLY_SIMPLE_COMMANDS);

/**
 * Classify one compound segment's words. Strips the `!` negator and the
 * `time`/`command`/`builtin` prefixes (recursively classifying the rest),
 * then looks the command up in the simple set or the special gates.
 * Anything else — including shell keywords (`if`/`for`/`function`), nested
 * shells, `sudo`, and unknown binaries — fails closed.
 */
function classifySegmentWords(words: string[]): boolean {
  let rest = [...words];
  while (rest.length > 0 && rest[0] === '!') {
    rest = rest.slice(1);
  }
  if (rest.length === 0) {
    return false;
  }
  const [head, ...tail] = rest;
  const name = commandName(head);
  if (name === 'time') {
    const after = tail[0] === '-p' ? tail.slice(1) : tail;
    return after.length === 0 || classifySegmentWords(after);
  }
  if (name === 'command') {
    if (tail.length === 0) {
      return true;
    }
    if (tail[0] === '-v' || tail[0] === '-V') {
      return true;
    }
    const after = tail[0] === '-p' ? tail.slice(1) : tail;
    return after.length > 0 && classifySegmentWords(after);
  }
  if (name === 'builtin') {
    return tail.length === 0 || classifySegmentWords(tail);
  }
  if (READONLY_SIMPLE_COMMAND_SET.has(name)) {
    return true;
  }
  return isReadonlySpecialCommand(name, tail);
}

/**
 * Strip the `!`/`time`/`command`/`builtin` prefixes the classifier looks
 * through, returning the remaining words (argv).
 */
function stripShellPrefixes(words: string[]): string[] {
  let rest = [...words];
  while (rest.length > 0 && rest[0] === '!') {
    rest = rest.slice(1);
  }
  const head = rest.length > 0 ? commandName(rest[0]) : '';
  if (head === 'time' || head === 'command' || head === 'builtin') {
    rest = rest.slice(1);
    if (rest[0] === '-p') {
      rest = rest.slice(1);
    }
  }
  return rest;
}

/**
 * Harden an allowed `git` segment against repo-controlled execution: splice
 * `--no-pager` after the `git` word and `--no-ext-diff` after a
 * `diff`/`show`/`log` subcommand (an external diff driver from repo config
 * or attributes would otherwise run). Splices land on the first word
 * occurrence — argv[0] and the subcommand are always the first matches
 * after prefix stripping — and inserting defensive flags can only break
 * odd spellings, never bypass.
 */
function rewriteReadonlyGitSegment(segment: string, words: string[]): string {
  const argv = stripShellPrefixes(words);
  if (argv.length === 0 || commandName(argv[0]) !== 'git') {
    return segment;
  }
  let out = segment;
  if (!out.includes('--no-pager')) {
    out = out.replace(/\bgit\b/, 'git --no-pager');
  }
  const subcommand = argv[1] ?? '';
  if (
    (subcommand === 'diff' || subcommand === 'show' || subcommand === 'log') &&
    !out.includes('--no-ext-diff')
  ) {
    out = out.replace(new RegExp(`\\b${subcommand}\\b`), `${subcommand} --no-ext-diff`);
  }
  return out;
}

/**
 * True when `command` is provably read-only: every compound segment splits
 * cleanly and classifies. Use `classifyReadonlyShell` for the denial
 * reason and the hardened command.
 */
export function isReadonlyShellCommand(command: string): boolean {
  return classifyReadonlyShell(command).allowed;
}

/**
 * Classify a full shell command for the read-only profile: split compounds,
 * classify every segment, and harden allowed `git` segments (see
 * `rewriteReadonlyGitSegment`). The first failing segment decides, with a
 * reason naming it. Empty input is denied. Blank segments (from a trailing
 * `&` or `;`) are skipped; anything else must classify.
 */
export function classifyReadonlyShell(command: string): ReadonlyShellVerdict {
  if (!command.trim()) {
    return { allowed: false, reason: 'empty command is not allowed in the read-only shell', segment: 0 };
  }
  const split = splitShellSegments(command);
  if ('denied' in split) {
    return { allowed: false, reason: `readonly shell: ${split.denied}`, segment: 0 };
  }
  const hardened = [...split.segments];
  let position = 0;
  for (const [at, segment] of split.segments.entries()) {
    if (!segment.trim()) {
      continue;
    }
    position += 1;
    const words = splitSegmentWords(segment);
    if (!words || words.length === 0 || !classifySegmentWords(words)) {
      const head = words?.[0] ?? segment.trim().split(/\s+/, 1)[0] ?? '';
      const shown = head ? ` \`${head.slice(0, 60)}\`` : '';
      return {
        allowed: false,
        reason: `readonly shell: segment ${position}${shown} is not a read-only command`,
        segment: at,
      };
    }
    const argv = stripShellPrefixes(words);
    if (argv.length > 0 && commandName(argv[0]) === 'git') {
      hardened[at] = rewriteReadonlyGitSegment(segment, words);
    }
  }
  const finalCommand = joinShellSplit({ segments: hardened, separators: split.separators });
  return finalCommand !== command ? { allowed: true, rewrittenCommand: finalCommand } : { allowed: true };
}

// ---------------------------------------------------------------------------
// Tool-call decisions (`canUseTool`)
// ---------------------------------------------------------------------------

/** What the policy needs to scope file writes. */
export type ClaudePolicyContext = {
  profile: RunToolsProfile;
  /** Run workspace: file writes resolve relative paths against it. */
  cwd: string;
  /** Agent user's home directory. */
  homeDir: string;
  /** OS temp dir (scratch space for builds and tooling). */
  tmpDir: string;
};

export type ClaudeToolDecision =
  | { decision: 'allow'; updatedCommand?: string }
  | { decision: 'deny'; reason: string; kind: RunDenialKind };

/** Realpath when it resolves, else the path as given. */
function resolveForScope(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * True when `candidate` is inside `root` (equal or beneath, after
 * resolving both — a symlinked workspace still matches its canonical root).
 */
function pathCoversDir(root: string, candidate: string): boolean {
  const resolvedRoot = resolveForScope(root);
  const resolvedCandidate = resolveForScope(candidate);
  return (
    resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

/**
 * True when an edit-profile file write to `filePath` is in scope: the run
 * workspace, the agent home, or the OS temp dir. Relative paths resolve
 * against the run workspace. Non-string and empty paths fail closed.
 */
export function isEditFileWriteInScope(filePath: unknown, ctx: ClaudePolicyContext): boolean {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return false;
  }
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);
  return (
    pathCoversDir(ctx.cwd, absolute) ||
    pathCoversDir(ctx.homeDir, absolute) ||
    pathCoversDir(ctx.tmpDir, absolute)
  );
}

function fileWriteTarget(toolName: string, input: Record<string, unknown>): unknown {
  // Edit/Write take `file_path`; NotebookEdit takes `notebook_path`.
  return toolName === 'NotebookEdit' ? input.notebook_path : input.file_path;
}

/**
 * Map a denied client-side tool to its denial kind: shell for Bash,
 * file_write for the file writers, network for the web tools, and
 * client_tool for everything else (subagents, Monitor, MCP tools the
 * profile excludes, and the unlisted tail). `mcp_tool` is never returned:
 * that kind is reserved for Agent Deck's own server-side enforcement.
 */
export function claudeDenialKindForTool(toolName: string): RunDenialKind {
  if (toolName === 'Bash') {
    return 'shell';
  }
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
    return 'file_write';
  }
  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    return 'network';
  }
  return 'client_tool';
}

function denyTool(toolName: string, reason: string): ClaudeToolDecision {
  return { decision: 'deny', reason, kind: claudeDenialKindForTool(toolName) };
}

/**
 * Decide one tool call against the worker profile (NOT-672): the pure
 * function behind the SDK `canUseTool` handler. Readonly allows reads,
 * web reads, session todos, read-only shell, and the profile's Agent Deck
 * MCP tools; edit additionally allows writes in scope, any shell,
 * subagents, task tracking, and Monitor. Both profiles deny question
 * prompts (a headless worker never waits), skill execution, non-worker
 * MCP servers, and everything unlisted. MCP denials name the full
 * `mcp__agent-deck__<tool>` target; the server remains the authoritative
 * backstop (in particular the readonly `call_service_tool` annotation
 * gate, which only the server can check).
 */
export function decideClaudeToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ClaudePolicyContext,
): ClaudeToolDecision {
  const { profile } = ctx;
  // Question prompts and skill execution: never on a headless worker.
  if (toolName === 'AskUserQuestion') {
    return denyTool(toolName, `worker profile "${profile}": interactive questions are never allowed headless`);
  }
  if (toolName === 'Skill') {
    return denyTool(toolName, `worker profile "${profile}": skills are not enabled on worker runs`);
  }
  // Reads, web reads, and session todos: both profiles.
  if ((CLAUDE_WORKER_BASE_TOOLS as readonly string[]).includes(toolName)) {
    return { decision: 'allow' };
  }
  // Shell.
  if (toolName === 'Bash') {
    if (input.dangerouslyDisableSandbox === true) {
      return denyTool(toolName, `worker profile "${profile}": disabling the sandbox is never allowed`);
    }
    if (profile === 'edit') {
      return { decision: 'allow' };
    }
    const command = input.command;
    if (typeof command !== 'string' || !command.trim()) {
      return denyTool(toolName, 'worker profile "readonly": Bash needs a command string');
    }
    const verdict = classifyReadonlyShell(command);
    if (!verdict.allowed) {
      return { decision: 'deny', reason: verdict.reason, kind: 'shell' };
    }
    return verdict.rewrittenCommand ? { decision: 'allow', updatedCommand: verdict.rewrittenCommand } : { decision: 'allow' };
  }
  // File writes.
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
    if (profile === 'readonly') {
      return denyTool(toolName, `worker profile "readonly": ${toolName} writes are not allowed`);
    }
    const target = fileWriteTarget(toolName, input);
    if (!isEditFileWriteInScope(target, ctx)) {
      return denyTool(
        toolName,
        `worker profile "edit": ${toolName} is scoped to the workspace, the agent home, and the OS temp dir`,
      );
    }
    return { decision: 'allow' };
  }
  // Subagents, task tracking, and Monitor: edit only.
  if (
    toolName === 'Agent' ||
    toolName === 'Monitor' ||
    toolName === 'TaskCreate' ||
    toolName === 'TaskGet' ||
    toolName === 'TaskUpdate' ||
    toolName === 'TaskList'
  ) {
    if (profile === 'readonly') {
      return denyTool(toolName, `worker profile "readonly": ${toolName} is not allowed`);
    }
    return { decision: 'allow' };
  }
  // Agent Deck MCP tools: exactly the profile allow set. Any other MCP
  // server prefix fails closed (worker runs connect to agent-deck only).
  if (toolName.startsWith('mcp__')) {
    if (!toolName.startsWith(CLAUDE_WORKER_MCP_TOOL_PREFIX)) {
      return denyTool(toolName, `worker profile "${profile}": only the agent-deck MCP server is connected`);
    }
    const mcpTool = toolName.slice(CLAUDE_WORKER_MCP_TOOL_PREFIX.length);
    if (!(WORKER_PROFILES[profile].mcpAllowTools as readonly string[]).includes(mcpTool)) {
      return denyTool(toolName, `worker profile "${profile}": MCP tool "${mcpTool}" is not allowed`);
    }
    return { decision: 'allow' };
  }
  // The unlisted tail (TaskStop, ToolSearch, plan/cron/scheduling tools,
  // MCP resources, and anything newer than this list): denied by default.
  return denyTool(toolName, `worker profile "${profile}": ${toolName} is not allowed`);
}

function isReadonlySpecialCommand(name: string, args: string[]): boolean {
  switch (name) {
    case 'git':
      return isReadonlyGitArgs(args);
    case 'gh':
      return isReadonlyGhArgs(args);
    case 'npm':
      return isReadonlyNpmArgs(args);
    case 'tar':
      return isReadonlyTarArgs(args);
    case 'unzip':
      return isReadonlyUnzipArgs(args);
    case 'find':
      return isReadonlyFindArgs(args);
    case 'sort':
      return isReadonlySortArgs(args);
    case 'uniq':
      return isReadonlyUniqArgs(args);
    case 'date':
      return isReadonlyDateArgs(args);
    case 'hostname':
      return isReadonlyHostnameArgs(args);
    case 'rg':
      return isReadonlyRgArgs(args);
    case 'base64':
      return isReadonlyBase64Args(args);
    default:
      return false;
  }
}

/**
 * Explicit allow rules for `profile`: built-ins, the Bash surface
 * (patterns for readonly, bare `Bash` for edit), and the profile's Agent
 * Deck MCP tools. Single source for the SDK `allowedTools` option and the
 * flag-layer `settings.permissions.allow` — the two can never drift.
 */
export function claudeAllowedToolsForProfile(profile: RunToolsProfile): string[] {
  const builtins =
    profile === 'edit'
      ? [...CLAUDE_WORKER_BASE_TOOLS, ...CLAUDE_EDIT_ONLY_TOOLS]
      : [...CLAUDE_WORKER_BASE_TOOLS];
  const bash = profile === 'edit' ? ['Bash'] : claudeReadonlyBashPatterns();
  return [...builtins, ...bash, ...claudeMcpToolRules(profile)];
}

/** Explicit deny rules for `profile` (see `CLAUDE_*_DENY_RULES`). */
export function claudeDenyRulesForProfile(profile: RunToolsProfile): string[] {
  return [...(profile === 'edit' ? CLAUDE_EDIT_DENY_RULES : CLAUDE_READONLY_DENY_RULES)];
}

/**
 * Flag-layer worker settings for `profile` (the SDK `settings` option):
 * explicit allow/deny, never ask, `dontAsk` default, and the working
 * directories file tools may touch (the run workspace is implicit in
 * `cwd`; home and the OS temp dir ride here so edit writes and every
 * profile's temp-file reads have a scope).
 */
export function claudeSettingsForProfile(
  profile: RunToolsProfile,
  input: { homeDir: string; tmpDir: string },
): {
  permissions: {
    allow: string[];
    deny: string[];
    ask: string[];
    defaultMode: string;
    additionalDirectories: string[];
  };
} {
  return {
    permissions: {
      allow: claudeAllowedToolsForProfile(profile),
      deny: claudeDenyRulesForProfile(profile),
      ask: [],
      defaultMode: CLAUDE_WORKER_PERMISSION_MODE,
      additionalDirectories: [input.homeDir, input.tmpDir],
    },
  };
}
