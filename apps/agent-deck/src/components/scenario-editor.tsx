import { useEffect, useState } from 'react';
import type {
  DeterministicExpectation,
  EvaluationScenario,
  EvaluationScenarioStatus,
  FeedbackSignal,
} from '@agent-deck/shared';
import { Button } from '@/components/ui/button';
import { Plus, X } from 'lucide-react';

export type ScenarioEditorValue = Pick<
  EvaluationScenario,
  'name' | 'description' | 'taskInput' | 'historicalFailedOutput' | 'expectations'
>;

type Props = {
  scenario?: EvaluationScenario | null;
  playbookId: string;
  playbookTitle: string;
  sourceSignals: FeedbackSignal[];
  error?: string | null;
  busy?: boolean;
  onCancel: () => void;
  onSave: (value: ScenarioEditorValue, status: EvaluationScenarioStatus) => void;
};

const INPUT_CLASS =
  'mt-1 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-100';

function emptyValue(scenario?: EvaluationScenario | null): ScenarioEditorValue {
  return scenario
    ? {
        name: scenario.name,
        description: scenario.description,
        taskInput: scenario.taskInput,
        historicalFailedOutput: scenario.historicalFailedOutput,
        expectations: scenario.expectations,
      }
    : {
        name: '',
        description: '',
        taskInput: '',
        historicalFailedOutput: null,
        expectations: [],
      };
}

export function ScenarioEditor({
  scenario,
  playbookId,
  playbookTitle,
  sourceSignals,
  error,
  busy,
  onCancel,
  onSave,
}: Props) {
  const [value, setValue] = useState<ScenarioEditorValue>(() => emptyValue(scenario));

  useEffect(() => setValue(emptyValue(scenario)), [scenario]);

  const updateExpectation = (index: number, patch: Partial<DeterministicExpectation>) => {
    setValue((current) => ({
      ...current,
      expectations: current.expectations.map((expectation, expectationIndex) =>
        expectationIndex === index
          ? ({ ...expectation, ...patch } as DeterministicExpectation)
          : expectation,
      ),
    }));
  };

  return (
    <section aria-label="Scenario editor" className="rounded-lg border border-gray-700 bg-gray-900/70 p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-ui-display text-base font-semibold">
            {scenario ? `Edit ${scenario.name}` : 'Create scenario'}
          </h2>
          <p className="text-xs text-gray-400">
            Fixed playbook: {playbookTitle} <span className="font-mono">({playbookId})</span>
          </p>
          <p className="text-xs text-gray-400">
            Fixed signals: {sourceSignals.map((signal) => signal.id).join(', ')}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onCancel} aria-label="Close scenario editor">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(16rem,2fr)]">
        <div className="space-y-3">
          <label className="block text-xs text-gray-400">
            Name
            <input
              className={INPUT_CLASS}
              value={value.name}
              onChange={(event) => setValue({ ...value, name: event.target.value })}
            />
          </label>
          <label className="block text-xs text-gray-400">
            Description
            <textarea
              className={INPUT_CLASS}
              rows={2}
              value={value.description}
              onChange={(event) => setValue({ ...value, description: event.target.value })}
            />
          </label>
          <label className="block text-xs text-gray-400">
            Real task input
            <textarea
              className={INPUT_CLASS}
              rows={4}
              value={value.taskInput}
              onChange={(event) => setValue({ ...value, taskInput: event.target.value })}
            />
          </label>
          <label className="block text-xs text-gray-400">
            Historical failed output
            <textarea
              className={INPUT_CLASS}
              rows={4}
              value={value.historicalFailedOutput ?? ''}
              onChange={(event) =>
                setValue({ ...value, historicalFailedOutput: event.target.value || null })
              }
            />
          </label>

          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">Deterministic checks</span>
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() =>
                  setValue({
                    ...value,
                    expectations: [
                      ...value.expectations,
                      { id: `check-${value.expectations.length + 1}`, type: 'contains', value: '' },
                    ],
                  })
                }
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Add check
              </Button>
            </div>
            <div className="mt-2 space-y-2">
              {value.expectations.map((expectation, index) => (
                <div key={index} className="grid gap-2 rounded border border-gray-800 p-2 sm:grid-cols-[1fr_9rem_2fr_auto]">
                  <input
                    aria-label={`Check ${index + 1} id`}
                    className={INPUT_CLASS.replace('mt-1 ', '')}
                    value={expectation.id}
                    onChange={(event) => updateExpectation(index, { id: event.target.value })}
                  />
                  <select
                    aria-label={`Check ${index + 1} type`}
                    className={INPUT_CLASS.replace('mt-1 ', '')}
                    value={expectation.type}
                    onChange={(event) =>
                      updateExpectation(index, {
                        type: event.target.value as DeterministicExpectation['type'],
                      })
                    }
                  >
                    <option value="contains">contains</option>
                    <option value="not_contains">not_contains</option>
                    <option value="equals">equals</option>
                    <option value="regex">regex</option>
                  </select>
                  <input
                    aria-label={`Check ${index + 1} value`}
                    className={INPUT_CLASS.replace('mt-1 ', '')}
                    value={expectation.value}
                    onChange={(event) => updateExpectation(index, { value: event.target.value })}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove check ${index + 1}`}
                    onClick={() =>
                      setValue({
                        ...value,
                        expectations: value.expectations.filter((_, itemIndex) => itemIndex !== index),
                      })
                    }
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || !value.name.trim()} onClick={() => onSave(value, 'draft')}>
              Save draft
            </Button>
            <Button
              variant="gold"
              disabled={busy || !value.name.trim()}
              onClick={() => onSave(value, 'ready')}
            >
              {scenario?.status === 'ready' ? 'Save ready scenario' : 'Mark ready'}
            </Button>
          </div>
        </div>

        <aside className="rounded border border-gray-800 bg-gray-950/60 p-3">
          <h3 className="font-ui-display text-sm font-semibold">Source feedback</h3>
          <p className="mt-1 text-xs text-gray-500">
            Read-only evidence. Supply real task/output text; do not infer it from excerpts.
          </p>
          <div className="mt-3 space-y-3">
            {sourceSignals.map((signal) => (
              <article key={signal.id} className="rounded border border-gray-800 p-2 text-xs">
                <p className="font-mono text-gray-500">{signal.id}</p>
                <p className="mt-1 text-gray-200">“{signal.userFeedbackExcerpt}”</p>
                <p className="mt-1 text-gray-400">{signal.failureSummary}</p>
                {signal.correctedOutputHint && (
                  <p className="mt-1 text-gray-500">Hint: {signal.correctedOutputHint}</p>
                )}
              </article>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}
