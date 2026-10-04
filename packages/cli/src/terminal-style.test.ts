import { afterEach, describe, expect, it } from 'vitest';

import { terminalColorsEnabled } from './terminal-style';

const originalNoColor = process.env.NO_COLOR;
const originalForceColor = process.env.FORCE_COLOR;

afterEach(() => {
  if (originalNoColor === undefined) {
    delete process.env.NO_COLOR;
  } else {
    process.env.NO_COLOR = originalNoColor;
  }
  if (originalForceColor === undefined) {
    delete process.env.FORCE_COLOR;
  } else {
    process.env.FORCE_COLOR = originalForceColor;
  }
});

describe('terminalColorsEnabled', () => {
  const tty = { isTTY: true } as NodeJS.WriteStream;

  it('allows color when NO_COLOR is present but empty', () => {
    process.env.NO_COLOR = '';
    delete process.env.FORCE_COLOR;
    expect(terminalColorsEnabled(tty)).toBe(true);
  });

  it('disables color when NO_COLOR is non-empty', () => {
    process.env.NO_COLOR = '1';
    expect(terminalColorsEnabled(tty)).toBe(false);
  });

  it('disables color when FORCE_COLOR is zero', () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '0';
    expect(terminalColorsEnabled(tty)).toBe(false);
  });
});
