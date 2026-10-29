import { z } from 'zod';
import { FeedbackSignalIdSchema } from './feedback-signal';
import { PlaybookIdSchema } from './playbook';

const ExpectationBaseSchema = z.object({
  id: z.string().trim().min(1, 'Expectation id is required'),
  value: z.string().min(1, 'Expectation value is required'),
});

const TextExpectationSchema = ExpectationBaseSchema.extend({
  type: z.enum(['contains', 'not_contains', 'equals']),
  caseSensitive: z.boolean().optional(),
});

const RegexExpectationSchema = ExpectationBaseSchema.extend({
  type: z.literal('regex'),
  flags: z
    .string()
    .regex(/^[imsu]*$/, 'Regex flags may only contain i, m, s, and u')
    .refine((flags) => new Set(flags).size === flags.length, 'Regex flags must not repeat')
    .optional(),
}).superRefine((expectation, ctx) => {
  try {
    new RegExp(expectation.value, expectation.flags ?? '');
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
});

/** Frozen-output checks supported by the deterministic experiment evaluator. */
export const DeterministicExpectationSchema = z.union([
  TextExpectationSchema,
  RegexExpectationSchema,
]);

export type DeterministicExpectation = z.infer<typeof DeterministicExpectationSchema>;

export const EvaluationScenarioIdSchema = z
  .string()
  .regex(/^es_[a-z0-9_]+$/, 'Scenario id must match es_<slug>');

export const EvaluationScenarioStatusSchema = z.enum(['draft', 'ready', 'retired']);

const ScenarioEvidenceSchema = z.object({
  taskInput: z.string(),
  historicalFailedOutput: z.string().nullable(),
  expectations: z.array(DeterministicExpectationSchema),
  sourceSignalIds: z.array(FeedbackSignalIdSchema),
  status: EvaluationScenarioStatusSchema,
});

function addScenarioEvidenceIssues(
  scenario: z.infer<typeof ScenarioEvidenceSchema>,
  ctx: z.RefinementCtx,
): void {
  const duplicateExpectationIds = scenario.expectations
    .map((expectation) => expectation.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateExpectationIds.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expectations'],
      message: 'Expectation ids must be unique',
    });
  }

  if (new Set(scenario.sourceSignalIds).size !== scenario.sourceSignalIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceSignalIds'],
      message: 'Source signal ids must be unique',
    });
  }

  if (scenario.status !== 'ready') return;
  if (scenario.taskInput.trim().length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['taskInput'],
      message: 'Ready scenarios require task input',
    });
  }
  if (!scenario.historicalFailedOutput?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['historicalFailedOutput'],
      message: 'Ready scenarios require a historical failed output',
    });
  }
  if (scenario.sourceSignalIds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceSignalIds'],
      message: 'Ready scenarios require at least one source signal',
    });
  }
  if (scenario.expectations.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expectations'],
      message: 'Ready scenarios require at least one deterministic expectation',
    });
  }
}

const EvaluationScenarioFieldsSchema = ScenarioEvidenceSchema.extend({
  id: EvaluationScenarioIdSchema,
  targetPlaybookId: PlaybookIdSchema,
  name: z.string().trim().min(1, 'Name is required'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const EvaluationScenarioSchema = EvaluationScenarioFieldsSchema.superRefine(
  addScenarioEvidenceIssues,
);

export type EvaluationScenario = z.infer<typeof EvaluationScenarioSchema>;
export type EvaluationScenarioStatus = z.infer<typeof EvaluationScenarioStatusSchema>;

export const CreateEvaluationScenarioSchema = ScenarioEvidenceSchema.extend({
  id: EvaluationScenarioIdSchema.optional(),
  targetPlaybookId: PlaybookIdSchema,
  name: z.string().trim().min(1, 'Name is required'),
  taskInput: z.string().default(''),
  historicalFailedOutput: z.string().nullable().default(null),
  expectations: z.array(DeterministicExpectationSchema).default([]),
  sourceSignalIds: z.array(FeedbackSignalIdSchema).default([]),
  status: EvaluationScenarioStatusSchema.default('draft'),
}).superRefine(addScenarioEvidenceIssues);

export type CreateEvaluationScenarioInput = z.infer<typeof CreateEvaluationScenarioSchema>;

export const UpdateEvaluationScenarioSchema = z.object({
  targetPlaybookId: PlaybookIdSchema.optional(),
  name: z.string().trim().min(1, 'Name is required').optional(),
  taskInput: z.string().optional(),
  historicalFailedOutput: z.string().nullable().optional(),
  expectations: z.array(DeterministicExpectationSchema).optional(),
  sourceSignalIds: z.array(FeedbackSignalIdSchema).optional(),
  status: EvaluationScenarioStatusSchema.optional(),
});

export type UpdateEvaluationScenarioInput = z.infer<typeof UpdateEvaluationScenarioSchema>;

export const ListEvaluationScenariosQuerySchema = z.object({
  targetPlaybookId: PlaybookIdSchema.optional(),
  status: EvaluationScenarioStatusSchema.optional(),
});

export type ListEvaluationScenariosQuery = z.infer<typeof ListEvaluationScenariosQuerySchema>;
