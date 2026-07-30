import { describe, expect, it } from 'vitest';
import {
  detectTriggerConflicts,
  normalizeTriggers,
  assertTriggerCountPolicy,
  triggerErrorMessage,
  TriggerValidationError,
} from './trigger-hygiene';

const productPrinciple = {
  id: 'pb_product_principle',
  title: 'Product principle',
  triggers: [
    'master-detail layout',
    'split-pane UI',
    'human gate UI',
    'review product layout',
    'drafting design doc',
  ],
};

const uiPrinciple = {
  id: 'pb_ui_principle',
  title: 'UI principle',
  triggers: [
    'master-detail layout',
    'split-pane UI layout',
    'human gate UI',
    'review UI layout',
    'split-pane UI',
  ],
};

describe('normalizeTriggers', () => {
  it('trims, collapses whitespace, and dedupes case-insensitively', () => {
    expect(normalizeTriggers([' PRD ', 'prd', '  write   PRD  '])).toEqual(['PRD', 'write PRD']);
  });

  it('rejects triggers longer than 80 characters', () => {
    expect(() => normalizeTriggers(['x'.repeat(81)])).toThrow(TriggerValidationError);
  });

  it('rejects more than 16 triggers by default', () => {
    const many = Array.from({ length: 17 }, (_, index) => `trigger ${index}`);
    expect(() => normalizeTriggers(many)).toThrow(TriggerValidationError);
  });

  it('allows more than 16 triggers when maxCount is null (store round-trip)', () => {
    const many = Array.from({ length: 20 }, (_, index) => `trigger ${index}`);
    expect(normalizeTriggers(many, { maxCount: null })).toHaveLength(20);
  });
});

describe('assertTriggerCountPolicy', () => {
  it('rejects create over 16', () => {
    expect(() => assertTriggerCountPolicy(17, { mode: 'create' })).toThrow(
      TriggerValidationError,
    );
  });

  it('allows update that keeps or shrinks an over-cap list', () => {
    expect(() =>
      assertTriggerCountPolicy(20, { mode: 'update', previousCount: 20 }),
    ).not.toThrow();
    expect(() =>
      assertTriggerCountPolicy(18, { mode: 'update', previousCount: 20 }),
    ).not.toThrow();
  });

  it('rejects update that grows an over-cap list', () => {
    expect(() =>
      assertTriggerCountPolicy(21, { mode: 'update', previousCount: 20 }),
    ).toThrow(/do not ask the user/);
  });

  it('rejects update that grows past 16 from under the cap', () => {
    expect(() =>
      assertTriggerCountPolicy(17, { mode: 'update', previousCount: 10 }),
    ).toThrow(TriggerValidationError);
  });

  it('prefers userMessage for dashboard clients', () => {
    try {
      assertTriggerCountPolicy(21, { mode: 'update', previousCount: 20 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TriggerValidationError);
      expect(
        triggerErrorMessage(error as TriggerValidationError, false),
      ).toMatch(/Remove some first/);
      expect(
        triggerErrorMessage(error as TriggerValidationError, true),
      ).toMatch(/do not ask the user/);
    }
  });
});

describe('detectTriggerConflicts', () => {
  it('detects exact, subsumes, and overlap for the live product/ui pair', () => {
    const conflicts = detectTriggerConflicts(uiPrinciple, [productPrinciple, uiPrinciple]);

    expect(conflicts.some((conflict) => conflict.level === 'exact')).toBe(true);
    expect(
      conflicts.some(
        (conflict) => conflict.level === 'subsumes' || conflict.level === 'overlap',
      ),
    ).toBe(true);
    expect(conflicts.length).toBeGreaterThanOrEqual(2);
  });
});
