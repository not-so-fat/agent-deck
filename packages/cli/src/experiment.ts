import fs from 'node:fs/promises';
import path from 'node:path';
import type { DeterministicExpectation as Expectation } from '@agent-deck/shared';

type ExperimentCase = {
  id: string;
  description?: string;
  sourceSignalIds?: string[];
  expectations: Expectation[];
};

type Observation = {
  caseId: string;
  outputFile: string;
};

type ExperimentVariant = {
  id: string;
  baseline?: boolean;
  artifactFile: string;
  observations: Observation[];
};

export type ExperimentManifest = {
  version: 1;
  name: string;
  cases: ExperimentCase[];
  variants: ExperimentVariant[];
};

export type ExpectationResult = {
  id: string;
  type: Expectation['type'];
  passed: boolean;
};

export type ObservationResult = {
  variantId: string;
  caseId: string;
  sourceSignalIds: string[];
  outputFile: string;
  passed: boolean;
  checks: ExpectationResult[];
};

export type VariantResult = {
  id: string;
  baseline: boolean;
  passedCases: number;
  totalCases: number;
  passedChecks: number;
  totalChecks: number;
  complexity: {
    bytes: number;
    words: number;
    nonEmptyLines: number;
  };
};

export type ExperimentReport = {
  version: 1;
  name: string;
  manifestPath: string;
  variants: VariantResult[];
  observations: ObservationResult[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function parseExpectation(value: unknown, field: string): Expectation {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const id = requiredString(value.id, `${field}.id`);
  const type = requiredString(value.type, `${field}.type`);
  const expected = requiredString(value.value, `${field}.value`);
  if (type === 'contains' || type === 'not_contains' || type === 'equals') {
    if (value.caseSensitive !== undefined && typeof value.caseSensitive !== 'boolean') {
      throw new Error(`${field}.caseSensitive must be a boolean`);
    }
    return { id, type, value: expected, caseSensitive: value.caseSensitive };
  }
  if (type === 'regex') {
    if (value.flags !== undefined && typeof value.flags !== 'string') {
      throw new Error(`${field}.flags must be a string`);
    }
    const flags = value.flags ?? '';
    if (!/^[imsu]*$/.test(flags) || new Set(flags).size !== flags.length) {
      throw new Error(`${field}.flags may contain each of i, m, s, and u at most once`);
    }
    try {
      new RegExp(expected, flags);
    } catch (error) {
      throw new Error(`${field}.value is not a valid regex: ${error instanceof Error ? error.message : error}`);
    }
    return { id, type, value: expected, flags };
  }
  throw new Error(`${field}.type must be contains, not_contains, equals, or regex`);
}

export function parseExperimentManifest(value: unknown): ExperimentManifest {
  if (!isRecord(value)) throw new Error('manifest must be an object');
  if (value.version !== 1) throw new Error('manifest.version must be 1');
  const name = requiredString(value.name, 'manifest.name');
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error('manifest.cases must contain at least one case');
  }
  if (!Array.isArray(value.variants) || value.variants.length < 2) {
    throw new Error('manifest.variants must contain a baseline and at least one candidate');
  }

  const cases: ExperimentCase[] = value.cases.map((entry, index) => {
    const field = `manifest.cases[${index}]`;
    if (!isRecord(entry)) throw new Error(`${field} must be an object`);
    const id = requiredString(entry.id, `${field}.id`);
    if (!Array.isArray(entry.expectations) || entry.expectations.length === 0) {
      throw new Error(`${field}.expectations must contain at least one check`);
    }
    const expectations = entry.expectations.map((expectation, expectationIndex) =>
      parseExpectation(expectation, `${field}.expectations[${expectationIndex}]`),
    );
    const expectationIds = expectations.map((expectation) => expectation.id);
    if (new Set(expectationIds).size !== expectationIds.length) {
      throw new Error(`${field}.expectations contains duplicate ids`);
    }
    if (entry.description !== undefined && typeof entry.description !== 'string') {
      throw new Error(`${field}.description must be a string`);
    }
    if (
      entry.sourceSignalIds !== undefined &&
      (!Array.isArray(entry.sourceSignalIds) ||
        entry.sourceSignalIds.some((signalId) => typeof signalId !== 'string' || !/^fs_[a-z0-9_]+$/.test(signalId)))
    ) {
      throw new Error(`${field}.sourceSignalIds must contain feedback signal ids`);
    }
    const sourceSignalIds = (entry.sourceSignalIds as string[] | undefined) ?? [];
    if (new Set(sourceSignalIds).size !== sourceSignalIds.length) {
      throw new Error(`${field}.sourceSignalIds contains duplicate ids`);
    }
    return { id, description: entry.description, sourceSignalIds, expectations };
  });

  const caseIds = cases.map((entry) => entry.id);
  if (new Set(caseIds).size !== caseIds.length) throw new Error('manifest.cases contains duplicate ids');
  const knownCaseIds = new Set(caseIds);

  const variants: ExperimentVariant[] = value.variants.map((entry, index) => {
    const field = `manifest.variants[${index}]`;
    if (!isRecord(entry)) throw new Error(`${field} must be an object`);
    const id = requiredString(entry.id, `${field}.id`);
    const artifactFile = requiredString(entry.artifactFile, `${field}.artifactFile`);
    if (entry.baseline !== undefined && typeof entry.baseline !== 'boolean') {
      throw new Error(`${field}.baseline must be a boolean`);
    }
    if (!Array.isArray(entry.observations)) throw new Error(`${field}.observations must be an array`);
    const observations = entry.observations.map((observation, observationIndex) => {
      const observationField = `${field}.observations[${observationIndex}]`;
      if (!isRecord(observation)) throw new Error(`${observationField} must be an object`);
      const caseId = requiredString(observation.caseId, `${observationField}.caseId`);
      if (!knownCaseIds.has(caseId)) throw new Error(`${observationField}.caseId is unknown: ${caseId}`);
      return {
        caseId,
        outputFile: requiredString(observation.outputFile, `${observationField}.outputFile`),
      };
    });
    const observationCaseIds = observations.map((observation) => observation.caseId);
    if (new Set(observationCaseIds).size !== observationCaseIds.length) {
      throw new Error(`${field}.observations contains duplicate case ids`);
    }
    const missing = caseIds.filter((caseId) => !observationCaseIds.includes(caseId));
    if (missing.length > 0) throw new Error(`${field}.observations is missing cases: ${missing.join(', ')}`);
    return { id, baseline: entry.baseline, artifactFile, observations };
  });

  const variantIds = variants.map((entry) => entry.id);
  if (new Set(variantIds).size !== variantIds.length) throw new Error('manifest.variants contains duplicate ids');
  if (variants.filter((entry) => entry.baseline === true).length !== 1) {
    throw new Error('manifest.variants must mark exactly one variant as baseline');
  }

  return { version: 1, name, cases, variants };
}

async function resolveBundleFile(bundleDir: string, relativeFile: string): Promise<string> {
  if (path.isAbsolute(relativeFile) || path.win32.isAbsolute(relativeFile)) {
    throw new Error(`experiment file must be relative: ${relativeFile}`);
  }
  const resolved = path.resolve(bundleDir, relativeFile);
  const relative = path.relative(bundleDir, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`experiment file escapes the bundle directory: ${relativeFile}`);
  }
  const [realBundleDir, realFile] = await Promise.all([fs.realpath(bundleDir), fs.realpath(resolved)]);
  const realRelative = path.relative(realBundleDir, realFile);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`experiment file escapes the bundle directory: ${relativeFile}`);
  }
  return realFile;
}

function evaluateExpectation(output: string, expectation: Expectation): boolean {
  if (expectation.type === 'regex') {
    return new RegExp(expectation.value, expectation.flags ?? '').test(output);
  }
  const caseSensitive = expectation.caseSensitive ?? false;
  const actual = caseSensitive ? output : output.toLowerCase();
  const expected = caseSensitive ? expectation.value : expectation.value.toLowerCase();
  if (expectation.type === 'contains') return actual.includes(expected);
  if (expectation.type === 'not_contains') return !actual.includes(expected);
  return actual.trim() === expected.trim();
}

function complexityOf(artifact: string): VariantResult['complexity'] {
  return {
    bytes: Buffer.byteLength(artifact, 'utf8'),
    words: artifact.trim().length === 0 ? 0 : artifact.trim().split(/\s+/u).length,
    nonEmptyLines: artifact.split(/\r?\n/u).filter((line) => line.trim().length > 0).length,
  };
}

export async function evaluateExperiment(manifestPath: string): Promise<ExperimentReport> {
  const absoluteManifestPath = path.resolve(manifestPath);
  const bundleDir = path.dirname(absoluteManifestPath);
  const raw = JSON.parse(await fs.readFile(absoluteManifestPath, 'utf8')) as unknown;
  const manifest = parseExperimentManifest(raw);
  const cases = new Map(manifest.cases.map((entry) => [entry.id, entry]));
  const observations: ObservationResult[] = [];
  const variants: VariantResult[] = [];

  for (const variant of manifest.variants) {
    const artifact = await fs.readFile(await resolveBundleFile(bundleDir, variant.artifactFile), 'utf8');
    let passedCases = 0;
    let passedChecks = 0;
    let totalChecks = 0;

    for (const observation of variant.observations) {
      const experimentCase = cases.get(observation.caseId);
      if (!experimentCase) throw new Error(`unknown case after validation: ${observation.caseId}`);
      const output = await fs.readFile(await resolveBundleFile(bundleDir, observation.outputFile), 'utf8');
      const checks = experimentCase.expectations.map((expectation) => ({
        id: expectation.id,
        type: expectation.type,
        passed: evaluateExpectation(output, expectation),
      }));
      const passed = checks.every((check) => check.passed);
      if (passed) passedCases += 1;
      passedChecks += checks.filter((check) => check.passed).length;
      totalChecks += checks.length;
      observations.push({
        variantId: variant.id,
        caseId: observation.caseId,
        sourceSignalIds: experimentCase.sourceSignalIds ?? [],
        outputFile: observation.outputFile,
        passed,
        checks,
      });
    }

    variants.push({
      id: variant.id,
      baseline: variant.baseline === true,
      passedCases,
      totalCases: manifest.cases.length,
      passedChecks,
      totalChecks,
      complexity: complexityOf(artifact),
    });
  }

  return {
    version: 1,
    name: manifest.name,
    manifestPath: absoluteManifestPath,
    variants,
    observations,
  };
}

function printReport(report: ExperimentReport): void {
  console.log(report.name);
  console.log('');
  console.log('Variant\tRole\tCases\tChecks\tBytes\tWords\tNon-empty lines');
  for (const variant of report.variants) {
    console.log(
      `${variant.id}\t${variant.baseline ? 'baseline' : 'candidate'}\t` +
        `${variant.passedCases}/${variant.totalCases}\t${variant.passedChecks}/${variant.totalChecks}\t` +
        `${variant.complexity.bytes}\t${variant.complexity.words}\t${variant.complexity.nonEmptyLines}`,
    );
  }
  const failed = report.observations.filter((observation) => !observation.passed);
  if (failed.length > 0) {
    console.log('');
    console.log('Failed checks');
    for (const observation of failed) {
      const ids = observation.checks.filter((check) => !check.passed).map((check) => check.id).join(', ');
      console.log(`${observation.variantId}/${observation.caseId}: ${ids}`);
    }
  }
}

export async function runExperimentCommand(args: string[]): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h' || args.length === 0) {
    console.log('Usage: agent-deck experiment evaluate <manifest.json> [--json]');
    return args.length === 0 ? 1 : 0;
  }
  if (args[0] !== 'evaluate') {
    console.error(`Unknown experiment command: ${args[0]}`);
    return 1;
  }
  const manifestPath = args[1];
  if (!manifestPath || manifestPath.startsWith('--')) {
    console.error('Missing experiment manifest path');
    return 1;
  }
  const unknown = args.slice(2).filter((arg) => arg !== '--json');
  if (unknown.length > 0) {
    console.error(`Unknown experiment option: ${unknown[0]}`);
    return 1;
  }
  try {
    const report = await evaluateExperiment(manifestPath);
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}
