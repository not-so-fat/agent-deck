import { describe, expect, it } from 'vitest';
import {
  CreateEvaluationScenarioSchema,
  EvaluationScenarioSchema,
} from './evaluation-scenario';

describe('evaluation scenario schemas', () => {
  it('accepts a draft without task/output evidence', () => {
    expect(
      CreateEvaluationScenarioSchema.parse({
        targetPlaybookId: 'pb_review_pr',
        name: 'Missing failure transcript',
      }),
    ).toMatchObject({
      taskInput: '',
      historicalFailedOutput: null,
      expectations: [],
      sourceSignalIds: [],
      status: 'draft',
    });
  });

  it('accepts a ready scenario with evaluator-compatible expectations', () => {
    const scenario = EvaluationScenarioSchema.parse({
      id: 'es_review_pr_summary',
      targetPlaybookId: 'pb_review_pr',
      name: 'Preserve blocking findings',
      taskInput: 'Review this pull request.',
      historicalFailedOutput: 'Looks good to me.',
      expectations: [
        { id: 'mentions-risk', type: 'contains', value: 'risk' },
        { id: 'no-approval', type: 'regex', value: 'looks good', flags: 'i' },
      ],
      sourceSignalIds: ['fs_first', 'fs_second'],
      status: 'ready',
      createdAt: '2026-10-29T12:00:00.000Z',
      updatedAt: '2026-10-29T12:00:00.000Z',
    });

    expect(scenario.expectations.map((expectation) => expectation.type)).toEqual([
      'contains',
      'regex',
    ]);
  });

  it.each([
    ['taskInput', { taskInput: '' }],
    ['historicalFailedOutput', { historicalFailedOutput: null }],
    ['sourceSignalIds', { sourceSignalIds: [] }],
    ['expectations', { expectations: [] }],
  ])('rejects ready scenarios missing %s', (_field, override) => {
    const result = CreateEvaluationScenarioSchema.safeParse({
      targetPlaybookId: 'pb_review_pr',
      name: 'Ready evidence',
      taskInput: 'Review this pull request.',
      historicalFailedOutput: 'Looks good to me.',
      expectations: [{ id: 'mentions-risk', type: 'contains', value: 'risk' }],
      sourceSignalIds: ['fs_first'],
      status: 'ready',
      ...override,
    });

    expect(result.success).toBe(false);
  });
});
