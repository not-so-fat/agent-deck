import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '../..');
const srcRoot = path.resolve(appRoot, 'src');

const read = (rel: string) => fs.readFileSync(path.resolve(appRoot, rel), 'utf8');

function declarationValue(css: string): string {
  const match = css.match(/--font-ui-display\s*:\s*([^;]+);/);
  if (!match) throw new Error('--font-ui-display declaration not found in index.css');
  return match[1].trim();
}

/** True when the label's own line (or a neighbour) carries the display utility. */
function labelUsesDisplayUtility(source: string, label: string, radius = 2): boolean {
  const lines = source.split('\n');
  return lines.some(
    (line, i) =>
      line.includes(label) &&
      lines
        .slice(Math.max(0, i - radius), i + radius + 1)
        .some((near) => near.includes('font-ui-display')),
  );
}

/** True when no line near any line containing `needle` carries the display utility. */
function regionKeepsMonaco(source: string, needle: string, radius = 3): boolean {
  const lines = source.split('\n');
  return lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.includes(needle))
    .every(({ i }) =>
      lines
        .slice(Math.max(0, i - radius), i + radius + 1)
        .every((near) => !near.includes('font-ui-display')),
    );
}

function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSources(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('NOT-218 display-font token', () => {
  it('declares --font-ui-display exactly once, in :root', () => {
    const css = read('src/index.css');
    const declarations = css.match(/--font-ui-display\s*:/g) ?? [];
    expect(declarations).toHaveLength(1);
    const rootAt = css.indexOf(':root');
    const darkAt = css.indexOf('.dark');
    const declAt = css.indexOf('--font-ui-display');
    expect(rootAt).toBeGreaterThanOrEqual(0);
    expect(declAt).toBeGreaterThan(rootAt);
    expect(declAt).toBeLessThan(darkAt);
  });

  it('uses system fonts only, with Avenir first and no download (NOT-230)', () => {
    const value = declarationValue(read('src/index.css'));
    expect(value.startsWith('"Avenir Next"')).toBe(true);
    expect(value.startsWith('Optima')).toBe(false);
    for (const face of ['Avenir', '"Helvetica Neue"', 'system-ui', 'sans-serif']) {
      expect(value).toContain(face);
    }
    expect(value).not.toMatch(/optima/i);
    expect(value).not.toMatch(/url\(|woff|@font-face/i);
  });

  it('is consumed by one semantic utility backed by the variable', () => {
    const css = read('src/index.css');
    expect(css).toMatch(/\.font-ui-display\s*\{\s*font-family:\s*var\(--font-ui-display\)/);
    const tailwind = read('tailwind.config.ts');
    expect(tailwind).toContain('ui-display');
    expect(tailwind).toContain('var(--font-ui-display)');
  });

  it('is never hard-coded into a React component or shared primitive', () => {
    const offenders = walkSources(srcRoot).filter((file) =>
      /(optima|avenir)/i.test(fs.readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it.each([
    ['src/components/deck-management-panel.tsx', 'My Decks'],
    ['src/pages/home.tsx', 'Add Cards'],
    ['src/pages/home.tsx', 'My Collection'],
    ['src/pages/home.tsx', 'Feedback'],
    ['src/pages/home.tsx', 'Review'],
    ['src/components/deck-builder.tsx', 'Deck'],
    ['src/pages/playbook-patches.tsx', 'Deck'],
    ['src/pages/playbook-patches.tsx', 'Playbook review queue'],
    ['src/pages/feedback-signals.tsx', 'Feedback'],
  ])('applies the utility to allowlisted label %s in %s', (file, label) => {
    expect(labelUsesDisplayUtility(read(file), label)).toBe(true);
  });

  it('applies the utility to the Get MCP URL button element', () => {
    const lines = read('src/pages/home.tsx').split('\n');
    const labelAt = lines.findIndex((line) => line.includes('Get MCP URL'));
    expect(labelAt).toBeGreaterThan(0);
    let openAt = -1;
    for (let i = labelAt; i >= 0; i -= 1) {
      if (/<button\b/.test(lines[i])) {
        openAt = i;
        break;
      }
    }
    expect(openAt).toBeGreaterThanOrEqual(0);
    expect(lines.slice(openAt, labelAt + 1).some((line) => line.includes('font-ui-display'))).toBe(
      true,
    );
  });

  it('keeps count badges next to display labels on Monaco', () => {
    const home = read('src/pages/home.tsx');
    expect(regionKeepsMonaco(home, 'rounded-full px-2 py-0.5', 1)).toBe(true);
    expect(regionKeepsMonaco(home, '(collectionCount} cards)', 1)).toBe(true);
  });

  it('keeps the AgentDeck wordmark and subtitle on Monaco', () => {
    const home = read('src/pages/home.tsx');
    expect(regionKeepsMonaco(home, 'AgentDeck', 2)).toBe(true);
    expect(regionKeepsMonaco(home, 'Build tool deck for your agent', 2)).toBe(true);
  });

  it.each([
    'src/components/card-component.tsx',
    'src/components/credential-card-component.tsx',
    'src/components/playbook-card-component.tsx',
  ])('keeps representative card %s on Monaco inheritance', (file) => {
    const source = read(file);
    expect(source).not.toContain('font-ui-display');
    expect(source).not.toMatch(/font-family|fontFamily/);
  });

  it('keeps deck-list names and subtitles on Monaco', () => {
    const source = read('src/components/deck-management-panel.tsx');
    expect(regionKeepsMonaco(source, '{deck.name}')).toBe(true);
    expect(regionKeepsMonaco(source, '{subtitle}')).toBe(true);
  });

  it('resolves a card descendant to Monaco and a label through the token', () => {
    const value = declarationValue(read('src/index.css'));
    const style = document.createElement('style');
    style.textContent = [
      `:root { --font-ui-display: ${value}; }`,
      'body { font-family: Monaco, monospace; }',
      '.font-ui-display { font-family: var(--font-ui-display); }',
    ].join('\n');
    document.head.appendChild(style);

    const card = document.createElement('div');
    card.textContent = 'Representative card title';
    document.body.appendChild(card);

    const label = document.createElement('span');
    label.className = 'font-ui-display';
    label.textContent = 'My Decks';
    document.body.appendChild(label);

    try {
      expect(getComputedStyle(card).fontFamily).toMatch(/Monaco/);
      expect(getComputedStyle(label).fontFamily).toContain('var(--font-ui-display)');
    } finally {
      style.remove();
      card.remove();
      label.remove();
    }
  });

  describe('NOT-230 chrome labels on the display token', () => {
    it.each([
      ['src/pages/home.tsx', 'Register MCP'],
      ['src/pages/home.tsx', 'Register API key'],
      ['src/pages/home.tsx', 'Register Playbook'],
      ['src/pages/home.tsx', 'Export all'],
      ['src/pages/feedback-signals.tsx', 'Copy for agent'],
      ['src/pages/playbook-patches.tsx', 'Proposals'],
      ['src/pages/playbook-patches.tsx', 'Detail'],
    ])('applies the utility to chrome label %s in %s', (file, label) => {
      expect(labelUsesDisplayUtility(read(file), label)).toBe(true);
    });

    it('applies the utility to the Import button label', () => {
      expect(read('src/pages/home.tsx').includes('<span className="font-ui-display">Import</span>')).toBe(
        true,
      );
    });

    it('applies the utility to the Feedback Playbook filter label', () => {
      expect(
        read('src/pages/feedback-signals.tsx').includes(
          '<span className="font-ui-display">Playbook</span>',
        ),
      ).toBe(true);
    });
  });

  describe('NOT-230 Monaco boundaries', () => {
    it('keeps deck-name values on Monaco', () => {
      const builder = read('src/components/deck-builder.tsx');
      expect(regionKeepsMonaco(builder, 'value={nameDraft}', 3)).toBe(true);
      expect(regionKeepsMonaco(builder, '{deck.name}', 3)).toBe(true);
      expect(regionKeepsMonaco(builder, 'button-rename-deck', 3)).toBe(true);
      const panel = read('src/components/deck-management-panel.tsx');
      expect(regionKeepsMonaco(panel, '{deck.name}', 3)).toBe(true);
    });

    it('keeps search text and filter values on Monaco', () => {
      const home = read('src/pages/home.tsx');
      expect(regionKeepsMonaco(home, 'input-search', 3)).toBe(true);
      expect(regionKeepsMonaco(home, 'placeholder="Search..."', 3)).toBe(true);
      expect(regionKeepsMonaco(home, '<SelectItem value="all">All</SelectItem>', 1)).toBe(true);
      expect(regionKeepsMonaco(home, '<SelectItem value="mcp">MCP</SelectItem>', 1)).toBe(true);
      expect(regionKeepsMonaco(home, '<SelectItem value="api-key">API Key</SelectItem>', 1)).toBe(true);
      expect(regionKeepsMonaco(home, '<SelectItem value="playbook">Playbook</SelectItem>', 1)).toBe(
        true,
      );
    });

    it('keeps registration authentication notes on Monaco', () => {
      for (const file of [
        'src/components/service-registration-modal.tsx',
        'src/components/credential-registration-modal.tsx',
        'src/components/playbook-registration-modal.tsx',
      ]) {
        expect(read(file).includes('font-ui-display')).toBe(false);
      }
      const credential = read('src/components/credential-registration-modal.tsx');
      expect(regionKeepsMonaco(credential, 'never shown again', 3)).toBe(true);
      const playbook = read('src/components/playbook-registration-modal.tsx');
      expect(regionKeepsMonaco(playbook, 'auto-detects API key', 3)).toBe(true);
      const service = read('src/components/service-registration-modal.tsx');
      expect(regionKeepsMonaco(service, 'requires authentication', 3)).toBe(true);
    });

    it('keeps proposal rows and detail content on Monaco', () => {
      const page = read('src/pages/playbook-patches.tsx');
      expect(regionKeepsMonaco(page, '{patch.displayTitle}', 2)).toBe(true);
      expect(regionKeepsMonaco(page, '{patch.rationale}', 2)).toBe(true);
      expect(regionKeepsMonaco(page, '<PlaybookPatchDiff', 2)).toBe(true);
      expect(regionKeepsMonaco(page, 'user_feedback_excerpt', 2)).toBe(true);
      expect(regionKeepsMonaco(page, '{patch.kind}', 2)).toBe(true);
      expect(regionKeepsMonaco(page, '{patches.length}', 2)).toBe(true);
      expect(regionKeepsMonaco(page, '{label}', 2)).toBe(true);
    });

    it('keeps feedback excerpts, badges, counts, and filter values on Monaco', () => {
      const page = read('src/pages/feedback-signals.tsx');
      expect(regionKeepsMonaco(page, 'userFeedbackExcerpt', 2)).toBe(true);
      expect(regionKeepsMonaco(page, 'In proposal', 2)).toBe(true);
      expect(regionKeepsMonaco(page, '{signals.length}', 0)).toBe(true);
      expect(regionKeepsMonaco(page, '<option value="">All</option>', 2)).toBe(true);
      expect(regionKeepsMonaco(page, '{p.title}', 2)).toBe(true);
      expect(regionKeepsMonaco(page, 'selected.size', 0)).toBe(true);
      expect(regionKeepsMonaco(page, '<th className="px-3 py-2">Playbook</th>', 2)).toBe(true);
    });

    it('resolves a NOT-230 display label through the token while values stay Monaco', () => {
      const value = declarationValue(read('src/index.css'));
      const style = document.createElement('style');
      style.textContent = [
        `:root { --font-ui-display: ${value}; }`,
        'body { font-family: Monaco, monospace; }',
        '.font-ui-display { font-family: var(--font-ui-display); }',
      ].join('\n');
      document.head.appendChild(style);

      const label = document.createElement('span');
      label.className = 'font-ui-display';
      label.textContent = 'Register MCP';
      document.body.appendChild(label);

      const deckName = document.createElement('button');
      deckName.textContent = 'My deck name';
      document.body.appendChild(deckName);

      const search = document.createElement('input');
      search.placeholder = 'Search...';
      document.body.appendChild(search);

      try {
        expect(getComputedStyle(label).fontFamily).toContain('var(--font-ui-display)');
        expect(getComputedStyle(deckName).fontFamily).toMatch(/Monaco/);
        expect(getComputedStyle(search).fontFamily).toMatch(/Monaco/);
      } finally {
        style.remove();
        label.remove();
        deckName.remove();
        search.remove();
      }
    });
  });
});
