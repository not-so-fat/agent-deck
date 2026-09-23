import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '../..');

const read = (rel: string) => fs.readFileSync(path.resolve(appRoot, rel), 'utf8');

function buttonBlock(): string {
  const source = read('src/components/deck-management-panel.tsx');
  const anchor = source.indexOf('create-deck-button');
  expect(anchor).toBeGreaterThan(0);
  const openAt = source.lastIndexOf('<Button', anchor);
  const closeAt = source.indexOf('</Button>', anchor);
  expect(openAt).toBeGreaterThanOrEqual(0);
  expect(closeAt).toBeGreaterThan(openAt);
  return source.slice(openAt, closeAt);
}

describe('NOT-259 Add Deck shared UI font', () => {
  it('routes the Add Deck label through the shared display token', () => {
    expect(read('src/components/deck-management-panel.tsx')).toContain(
      '<span className="font-ui-display">Add Deck</span>',
    );
  });

  it('keeps the visible copy exactly "Add Deck" with the Plus affordance', () => {
    const block = buttonBlock();
    expect(block).toContain('Add Deck');
    expect(block).not.toContain('+ Add Deck');
    expect(block).toContain('<Plus');
    expect(block).toContain('create-deck-button');
    // Behavior hook untouched: opens the create-deck modal.
    expect(block).toContain('setCreateModalOpen(true)');
  });

  it('uses the token rather than a one-off font-family declaration', () => {
    const block = buttonBlock();
    expect(block).not.toMatch(/font-family|fontFamily/i);
    expect(block).not.toMatch(/avenir|optima|helvetica|system-ui/i);
    expect(block).toContain('font-ui-display');
  });

  it('keeps default, hover, focus, and disabled treatment legible and aligned', () => {
    const block = buttonBlock();
    // Alignment comes from the shared Button primitive (inline-flex centered).
    const primitive = read('src/components/ui/button.tsx');
    expect(primitive).toContain('items-center');
    expect(primitive).toContain('justify-center');
    // Focus ring and disabled legibility live on the shared primitive.
    expect(primitive).toContain('focus-visible:ring-2');
    expect(primitive).toContain('disabled:opacity-50');
    // The action keeps its full-width bordered chrome layout.
    expect(block).toContain('w-full');
    expect(block).toContain('border');
  });
});
