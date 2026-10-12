import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { getCliPackageRoot } from './paths';
import { parseRunArgs } from './run';
import { parseRunListArgs, parseRunLogArgs, parseRunStatusArgs } from './run-status';

const SECTION_HEADING = '## First delegated run (detach, check, resume)';

function repoRoot(): string {
  return path.resolve(getCliPackageRoot(), '..', '..');
}

function readFriendPath(): { file: string; lines: string[] } {
  const file = path.join(repoRoot(), 'docs', 'FRIEND_PATH.md');
  expect(fs.existsSync(file), `expected the friend path at ${file}`).toBe(true);
  return { file, lines: fs.readFileSync(file, 'utf8').split('\n') };
}

/** The new section: from its heading to the next `## ` heading (or EOF). */
function sectionLines(all: string[]): string[] {
  const start = all.findIndex((line) => line.trim() === SECTION_HEADING);
  expect(start, `missing section heading: ${SECTION_HEADING}`).toBeGreaterThanOrEqual(0);
  let end = all.length;
  for (let i = start + 1; i < all.length; i += 1) {
    if (all[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  return all.slice(start, end);
}

type FencedBlock = { tag: string; lines: string[]; startLine: number };

/** Fenced blocks, tolerating list-item indentation before the backticks. */
function fencedBlocks(lines: string[]): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let open: { tag: string; lines: string[]; startLine: number } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      if (open) {
        blocks.push(open);
        open = null;
      } else {
        open = { tag: fence[1], lines: [], startLine: i + 1 };
      }
      continue;
    }
    if (open) {
      open.lines.push(line.trim());
    }
  }
  expect(open, 'unclosed fenced block in the friend-path section').toBeNull();
  return blocks;
}

/** Minimal shell-word split: single/double quotes, `#` comments, no continuations. */
function splitCommand(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: string | null = null;
  let started = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && i + 1 < line.length) {
        i += 1;
        word += line[i];
      } else {
        word += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === '#') {
      break;
    } else if (/\s/.test(char)) {
      if (started || word) {
        words.push(word);
        word = '';
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }
  expect(quote, `unterminated quote in: ${line}`).toBeNull();
  if (started || word) {
    words.push(word);
  }
  return words;
}

/** Doc placeholders (`<runId>`, …) stand in for values only known at runtime. */
function fillPlaceholders(words: string[]): string[] {
  return words.map((word) => word.replace(/<[^<>]*>/g, 'doc-placeholder'));
}

/**
 * Dry-parse one fenced `agent-deck` command against the shipped CLI parsers.
 * Unknown shapes fail loudly: extending the section means extending this test.
 */
function dryParse(words: string[], source: string): void {
  expect(words[0], `not an agent-deck command: ${source}`).toBe('agent-deck');
  const argv = fillPlaceholders(words.slice(1));
  const [command, sub, ...rest] = argv;
  if (command === 'run' && (sub === 'status' || sub === 'log' || sub === 'list')) {
    const parsed =
      sub === 'status'
        ? parseRunStatusArgs(rest)
        : sub === 'log'
          ? parseRunLogArgs(rest)
          : parseRunListArgs(rest);
    expect(
      parsed,
      `${source} does not parse against the shipped run ${sub} usage: ${JSON.stringify(parsed)}`,
    ).not.toHaveProperty('error');
    return;
  }
  if (command === 'run') {
    const parsed = parseRunArgs(argv.slice(1));
    expect(
      parsed,
      `${source} does not parse against the shipped run usage: ${JSON.stringify(parsed)}`,
    ).not.toHaveProperty('error');
    return;
  }
  throw new Error(
    `${source}: no dry parser for \`agent-deck ${command}\` — extend friend-path-docs.test.ts`,
  );
}

describe('friend-path delegated-run section (NOT-405)', () => {
  it('every fenced agent-deck command dry-parses against the shipped CLI usage', () => {
    const { lines } = readFriendPath();
    const section = sectionLines(lines);
    const commands: string[] = [];
    for (const block of fencedBlocks(section)) {
      if (block.tag !== 'bash' && block.tag !== 'sh') {
        continue;
      }
      for (const line of block.lines) {
        if (!line || line.startsWith('#')) {
          continue;
        }
        expect(line.endsWith('\\'), `line continuations are not supported: ${line}`).toBe(false);
        if (!line.startsWith('agent-deck ')) {
          continue;
        }
        commands.push(line);
        dryParse(splitCommand(line), line);
      }
    }
    // The ticket's four commands must stay fenced in the section.
    expect(commands.length, 'no fenced agent-deck commands found in the section').toBeGreaterThan(0);
    const joined = commands.join('\n');
    expect(joined).toMatch(/--detach/);
    expect(joined).toMatch(/run status/);
    expect(joined).toMatch(/run log/);
    expect(joined).toMatch(/--resume/);
  });

  it('relative doc links resolve to files that exist', () => {
    const { file, lines } = readFriendPath();
    const docsDir = path.dirname(file);
    const linkPattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
    let checked = 0;
    for (const line of lines) {
      for (const match of line.matchAll(linkPattern)) {
        const target = match[1];
        if (
          target.startsWith('http://') ||
          target.startsWith('https://') ||
          target.startsWith('#') ||
          target.startsWith('mailto:')
        ) {
          continue;
        }
        const targetFile = target.split('#')[0];
        checked += 1;
        expect(
          fs.existsSync(path.resolve(docsDir, targetFile)),
          `broken docs link: ${target} (in ${file})`,
        ).toBe(true);
      }
    }
    expect(checked, 'expected at least one relative link in the friend path').toBeGreaterThan(0);
  });
});
