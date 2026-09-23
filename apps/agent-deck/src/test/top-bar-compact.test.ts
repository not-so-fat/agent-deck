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
  it('uses compact vertical padding on the header container', () => {
    const header = headerBlock();
    expect(hasToken(header, 'py-2')).toBe(true);
    expect(hasToken(header, 'py-3')).toBe(false);
    expect(hasToken(header, 'py-4')).toBe(false);
    expect(hasToken(header, 'sm:py-4')).toBe(false);
  });

  it('renders a one-line brand: h-9 logo plus AgentDeck wordmark', () => {
    const header = headerBlock();
    // Logo is exactly h-9 w-9 (no responsive resizing back to a large mark).
    const imgTags = [...header.matchAll(/<img[^>]*>/g)].map((m) => m[0]);
    expect(imgTags.length).toBeGreaterThan(0);
    const logo = imgTags.find((tag) => tag.includes('AgentDeckLogo'));
    expect(logo).toBeDefined();
    expect(hasToken(logo!, 'h-9')).toBe(true);
    expect(hasToken(logo!, 'w-9')).toBe(true);
    expect(hasToken(logo!, 'h-8')).toBe(false);
    expect(hasToken(logo!, 'sm:h-10')).toBe(false);
    // Wordmark sits beside the logo on one line.
    expect(header).toContain('AgentDeck');
    expect(header).toMatch(/<h1[^>]*whitespace-nowrap[^>]*>\s*AgentDeck\s*<\/h1>/);
  });

  it('keeps the tagline out of the visible top bar', () => {
    const header = headerBlock();
    const tagline = 'Build tool deck for your agent';
    expect(header).toContain(tagline);
    // Every mention of the tagline must be screen-reader only.
    const lines = header.split('\n').filter((line) => line.includes(tagline));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/sr-only/);
    }
    // No visible (non-sr-only) tagline styling remains.
    expect(header).not.toMatch(/<p className="text-xs/);
  });

  it('has no free wrapping on desktop: one level row', () => {
    const header = headerBlock();
    expect(hasToken(header, 'flex-wrap')).toBe(false);
    // Desktop row centers brand and actions on one axis.
    expect(hasToken(header, 'sm:flex-row')).toBe(true);
    expect(hasToken(header, 'sm:items-center')).toBe(true);
    expect(hasToken(header, 'sm:justify-between')).toBe(true);
    expect(hasToken(header, 'items-center')).toBe(true);
  });

  it('stacks brand/actions on narrow widths with a single scrollable action row', () => {
    const header = headerBlock();
    // Deliberate two-row stack on narrow viewports.
    expect(hasToken(header, 'flex-col')).toBe(true);
    // Action row stays single-line and scrolls instead of wrapping.
    expect(hasToken(header, 'flex-nowrap')).toBe(true);
    expect(hasToken(header, 'overflow-x-auto')).toBe(true);
    // Actions must not shrink their labels away.
    expect(hasToken(header, 'shrink-0')).toBe(true);
    expect(hasToken(header, 'whitespace-nowrap')).toBe(true);
  });

  it('gives every top-level action the same h-9 height', () => {
    const header = headerBlock();
    // Get MCP URL is a single h-9 button (not a container around a smaller button).
    expect(header).toMatch(
      /<button[^>]*h-9[^>]*data-testid="button-copy-mcp-url"|<button[^>]*data-testid="button-copy-mcp-url"[^>]*h-9/,
    );
    expect(header).toMatch(
      /data-testid="button-copy-mcp-url"[\s\S]{0,1200}Get MCP URL/,
    );
    // Live-session trigger resolves to h-9.
    const badges = read('src/components/live-session-badges.tsx');
    const trigger = badges.slice(badges.indexOf('live-session-badges-trigger') - 600, badges.indexOf('live-session-badges-trigger'));
    expect(hasToken(trigger, 'h-9')).toBe(true);
    expect(hasToken(trigger, 'h-7')).toBe(false);
    // Feedback and Review use Button size="sm", which the design system maps to h-9.
    expect(header).toContain('size="sm"');
    const button = read('src/components/ui/button.tsx');
    expect(button).toMatch(/sm:\s*"h-9[^"]*"/);
  });

  it('keeps every top-bar control and handler: MCP url, sessions, feedback, review', () => {
    const header = headerBlock();
    expect(header).toContain('AgentDeck');
    expect(header).toContain('Get MCP URL');
    expect(header).toContain('LiveSessionBadges');
    expect(header).toContain('Feedback');
    expect(header).toContain('Review');
    expect(header).toContain('button-copy-mcp-url');
    expect(header).toContain('copyMcpEndpointToClipboard');
    expect(header).toContain('title="Click to copy MCP URL"');
    expect(header).toContain('/feedback-signals');
    expect(header).toContain('/playbook-patches');
    // Connected/disconnected treatment stays on the single pill button.
    expect(header).toContain('bg-emerald-500/20');
    expect(header).toContain('bg-red-500/20');
    // Compact control-size token already used by the header buttons.
    expect(header).toContain('size="sm"');
    // Title truncates safely and the logo never shrinks away.
    expect(hasToken(header, 'shrink-0')).toBe(true);
  });

  it('keeps the Add Deck action (deck panel) untouched', () => {
    const panel = read('src/components/deck-management-panel.tsx');
    expect(panel).toContain('Add Deck');
    expect(panel).toContain('create-deck-button');
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
