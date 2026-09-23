import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '../..');
const srcRoot = path.resolve(appRoot, 'src');

const read = (rel: string) => fs.readFileSync(path.resolve(appRoot, rel), 'utf8');

/** The dashboard top bar: the header block in the home page. */
function headerBlock(): string {
  const source = read('src/pages/home.tsx');
  const start = source.indexOf('{/* Header */}');
  const end = source.indexOf('</header>');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** True when `token` appears as a full Tailwind class token (not a substring). */
function hasToken(block: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w:-])${escaped}(?![\\w-])`).test(block);
}

describe('NOT-256 compact top bar', () => {
  it('uses compact vertical padding (narrow base and standard sm widths)', () => {
    const header = headerBlock();
    // Compact base token governs the narrow viewport; the sm token governs
    // the standard desktop viewport. Both must be the compact step.
    expect(hasToken(header, 'py-2')).toBe(true);
    expect(hasToken(header, 'py-3')).toBe(false);
    expect(hasToken(header, 'py-4')).toBe(false);
    expect(hasToken(header, 'sm:py-4')).toBe(false);
  });

  it('uses a smaller logo from the existing size scale', () => {
    const header = headerBlock();
    expect(hasToken(header, 'h-8')).toBe(true);
    expect(hasToken(header, 'sm:h-10')).toBe(true);
    expect(hasToken(header, 'h-12')).toBe(false);
    expect(hasToken(header, 'sm:h-16')).toBe(false);
  });

  it('uses compact gaps between and inside control clusters', () => {
    const header = headerBlock();
    expect(hasToken(header, 'gap-2')).toBe(true);
    expect(hasToken(header, 'sm:gap-4')).toBe(false);
    expect(hasToken(header, 'sm:gap-6')).toBe(false);
  });

  it('keeps every top-bar control: title, MCP url, sessions, feedback, review', () => {
    const header = headerBlock();
    expect(header).toContain('AgentDeck');
    expect(header).toContain('Get MCP URL');
    expect(header).toContain('LiveSessionBadges');
    expect(header).toContain('Feedback');
    expect(header).toContain('Review');
    // Compact control-size token already used by the header buttons.
    expect(header).toContain('size="sm"');
  });

  it('keeps the Add Deck action (deck panel) untouched', () => {
    const panel = read('src/components/deck-management-panel.tsx');
    expect(panel).toContain('Add Deck');
    expect(panel).toContain('create-deck-button');
  });

  it('keeps controls vertically aligned without clipping or overlap', () => {
    const header = headerBlock();
    // Vertical centering for the shorter bar.
    expect(hasToken(header, 'items-center')).toBe(true);
    // Narrow viewport: clusters wrap instead of overlapping/clipping.
    expect(hasToken(header, 'flex-wrap')).toBe(true);
    // Title truncates and the logo never shrinks away.
    expect(hasToken(header, 'min-w-0')).toBe(true);
    expect(hasToken(header, 'shrink-0')).toBe(true);
  });

  it('introduces no separate top-bar design system', () => {
    const header = headerBlock();
    const headerOpenTag = header.slice(0, header.indexOf('>') + 1);
    // No fixed inline height on the bar itself — height comes from tokens.
    expect(headerOpenTag).not.toContain('style=');
    expect(headerOpenTag).not.toMatch(/h-\[|min-h-|max-h-/);
    // No bespoke top-bar class, variable, or stylesheet addition
    // (data-testid="top-bar" is a test hook, not styling).
    const classNames = [...header.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
    expect(classNames.join(' ')).not.toMatch(/top-bar|topbar|TopBar/);
    expect(read('src/index.css')).not.toMatch(/top-bar|topbar/);
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|css)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
          sources.push(full);
        }
      }
    };
    walk(srcRoot);
    const offenders = sources.filter((file) =>
      /--top-bar|topBarHeight|TOP_BAR_HEIGHT/.test(fs.readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
