import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluationScenarioToExperimentCase, type EvaluationScenario } from '@agent-deck/shared';
import { evaluateExperiment, parseExperimentManifest, runExperimentCommand } from './experiment';

const temporaryDirectories: string[] = [];

async function fixture(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-deck-experiment-'));
  temporaryDirectories.push(directory);
  await fs.mkdir(path.join(directory, 'artifacts'));
  await fs.mkdir(path.join(directory, 'outputs', 'baseline'), { recursive: true });
  await fs.mkdir(path.join(directory, 'outputs', 'candidate'), { recursive: true });
  await fs.writeFile(path.join(directory, 'artifacts', 'baseline.md'), 'Long baseline\nwith extra instructions\n');
  await fs.writeFile(path.join(directory, 'artifacts', 'candidate.md'), 'Short candidate\n');
  await fs.writeFile(path.join(directory, 'outputs', 'baseline', 'case.txt'), 'invent a new algorithm');
  await fs.writeFile(path.join(directory, 'outputs', 'candidate', 'case.txt'), 'reuse the existing evaluator');
  const manifest = {
    version: 1,
    name: 'Simple counterfactual',
    cases: [
      {
        id: 'existing-method',
        sourceSignalIds: ['fs_feedback_1'],
        expectations: [
          { id: 'reuse', type: 'contains', value: 'existing evaluator' },
          { id: 'no-invention', type: 'not_contains', value: 'new algorithm' },
        ],
      },
    ],
    variants: [
      {
        id: 'baseline',
        baseline: true,
        artifactFile: 'artifacts/baseline.md',
        observations: [{ caseId: 'existing-method', outputFile: 'outputs/baseline/case.txt' }],
      },
      {
        id: 'candidate',
        artifactFile: 'artifacts/candidate.md',
        observations: [{ caseId: 'existing-method', outputFile: 'outputs/candidate/case.txt' }],
      },
    ],
  };
  const manifestPath = path.join(directory, 'experiment.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })));
});

describe('experiment evaluator', () => {
  it('accepts copied ready-scenario JSON as an evaluator case without observations', () => {
    const scenario: EvaluationScenario = {
      id: 'es_feedback_blocker',
      targetPlaybookId: 'pb_review_pr',
      name: 'Blocking review',
      description: 'Surface blocking review findings.',
      taskInput: 'Review the supplied pull request.',
      historicalFailedOutput: 'Looks good.',
      sourceSignalIds: ['fs_first', 'fs_second'],
      expectations: [{ id: 'mentions-blocker', type: 'contains', value: 'blocking' }],
      status: 'ready',
      createdAt: '2026-10-29T00:00:00.000Z',
      updatedAt: '2026-10-29T00:00:00.000Z',
    };
    const copied = JSON.parse(JSON.stringify(evaluationScenarioToExperimentCase(scenario)));
    expect(Object.keys(copied)).toEqual(['id', 'description', 'sourceSignalIds', 'expectations']);
    expect(copied).not.toHaveProperty('taskInput');
    expect(copied).not.toHaveProperty('historicalFailedOutput');
    expect(parseExperimentManifest({
      version: 1,
      name: 'Copied scenario',
      cases: [copied],
      variants: [
        { id: 'baseline', baseline: true, artifactFile: 'a.md', observations: [{ caseId: copied.id, outputFile: 'a.txt' }] },
        { id: 'candidate', artifactFile: 'b.md', observations: [{ caseId: copied.id, outputFile: 'b.txt' }] },
      ],
    }).cases[0]).toEqual(copied);
  });

  it('deterministically compares frozen outputs, provenance, and absolute complexity', async () => {
    const manifestPath = await fixture();
    const report = await evaluateExperiment(manifestPath);
    const repeatedReport = await evaluateExperiment(manifestPath);
    expect(JSON.stringify(repeatedReport)).toBe(JSON.stringify(report));
    expect(report.variants).toEqual([
      expect.objectContaining({
        id: 'baseline',
        baseline: true,
        passedCases: 0,
        totalCases: 1,
        passedChecks: 0,
        totalChecks: 2,
      }),
      expect.objectContaining({
        id: 'candidate',
        baseline: false,
        passedCases: 1,
        totalCases: 1,
        passedChecks: 2,
        totalChecks: 2,
      }),
    ]);
    expect(report.variants[0].complexity).toEqual({ bytes: 38, words: 5, nonEmptyLines: 2 });
    expect(report.variants[1].complexity).toEqual({ bytes: 16, words: 2, nonEmptyLines: 1 });
    expect(report.observations[0].sourceSignalIds).toEqual(['fs_feedback_1']);
    expect(report.observations[1].sourceSignalIds).toEqual(['fs_feedback_1']);
  });

  it('rejects incomplete observations before reading outputs', () => {
    expect(() =>
      parseExperimentManifest({
        version: 1,
        name: 'bad',
        cases: [{ id: 'a', expectations: [{ id: 'x', type: 'contains', value: 'x' }] }],
        variants: [
          { id: 'baseline', baseline: true, artifactFile: 'a.md', observations: [] },
          { id: 'candidate', artifactFile: 'b.md', observations: [] },
        ],
      }),
    ).toThrow('missing cases: a');
  });

  it('rejects files outside the experiment bundle', async () => {
    const manifestPath = await fixture();
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.variants[0].artifactFile = '../outside.md';
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await expect(evaluateExperiment(manifestPath)).rejects.toThrow('escapes the bundle directory');

    manifest.variants[0].artifactFile = path.resolve(path.dirname(manifestPath), 'artifacts', 'baseline.md');
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await expect(evaluateExperiment(manifestPath)).rejects.toThrow('experiment file must be relative');

    manifest.variants[0].artifactFile = 'C:\\outside.md';
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await expect(evaluateExperiment(manifestPath)).rejects.toThrow('experiment file must be relative');
  });

  it('rejects symlinks that escape the experiment bundle', async () => {
    const manifestPath = await fixture();
    const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-deck-experiment-outside-'));
    temporaryDirectories.push(outsideDirectory);
    const outsideArtifact = path.join(outsideDirectory, 'outside.md');
    await fs.writeFile(outsideArtifact, 'outside');
    await fs.symlink(outsideArtifact, path.join(path.dirname(manifestPath), 'artifacts', 'escaped.md'));
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.variants[0].artifactFile = 'artifacts/escaped.md';
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await expect(evaluateExperiment(manifestPath)).rejects.toThrow('escapes the bundle directory');
  });

  it('rejects duplicate or missing baselines and invalid regex patterns', () => {
    const manifest = {
      version: 1,
      name: 'validation',
      cases: [{ id: 'a', expectations: [{ id: 'x', type: 'contains', value: 'x' }] }],
      variants: [
        { id: 'baseline', baseline: true, artifactFile: 'a.md', observations: [{ caseId: 'a', outputFile: 'a.txt' }] },
        { id: 'candidate', artifactFile: 'b.md', observations: [{ caseId: 'a', outputFile: 'b.txt' }] },
      ],
    };
    expect(parseExperimentManifest(manifest).cases[0].sourceSignalIds).toEqual([]);
    expect(() =>
      parseExperimentManifest({
        ...manifest,
        variants: manifest.variants.map((variant) => ({ ...variant, baseline: undefined })),
      }),
    ).toThrow('exactly one variant as baseline');
    expect(() =>
      parseExperimentManifest({
        ...manifest,
        variants: manifest.variants.map((variant) => ({ ...variant, baseline: true })),
      }),
    ).toThrow('exactly one variant as baseline');
    expect(() =>
      parseExperimentManifest({
        ...manifest,
        cases: [{ id: 'a', expectations: [{ id: 'x', type: 'regex', value: '[' }] }],
      }),
    ).toThrow('value is not a valid regex');
  });

  it('keeps valid comparison failures successful and reports malformed input concisely', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const manifestPath = await fixture();
    expect(await runExperimentCommand(['evaluate', manifestPath, '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0])).name).toBe('Simple counterfactual');
    await fs.writeFile(manifestPath, '{');
    expect(await runExperimentCommand(['evaluate', manifestPath, '--json'])).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).not.toContain('\n');
  });
});
