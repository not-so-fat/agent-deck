import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * NOT-236: detect a stale `agent-deck` binary earlier on PATH than the
 * current managed install. `install`/`upgrade` repoint
 * `~/.agent-deck/current` but never touch copies installed elsewhere
 * (e.g. Homebrew), so the launcher that spawns each MCP connection can
 * silently predate the backend. Detection and a stated remedy only —
 * never reorder PATH, uninstall, or relink anything here.
 */

export type CliOnPathEntry = {
  path: string;
  version: string | null;
};

export type StaleCliFinding = {
  firstPath: string;
  firstVersion: string;
  currentDir: string;
  currentVersion: string;
  otherPaths: string[];
};

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve every `agent-deck` on PATH in shell resolution order (what the
 * shell would actually invoke first comes first). Pure PATH walk —
 * inject `pathEnv`/`isExecutable` in tests instead of mutating PATH.
 */
export function resolveAgentDeckOnPath(
  options: {
    pathEnv?: string;
    delimiter?: string;
    command?: string;
    isExecutable?: (candidate: string) => boolean;
  } = {},
): string[] {
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const delimiter = options.delimiter ?? path.delimiter;
  const command = options.command ?? 'agent-deck';
  const isExecutable = options.isExecutable ?? isExecutableFile;
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, command);
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    try {
      if (isExecutable(candidate)) {
        resolved.push(candidate);
      }
    } catch {
      // An unreadable PATH entry must not break the check.
    }
  }
  return resolved;
}

export function extractVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return match?.[1] ?? null;
}

/** Report the version string a binary prints for `--version`; null when unknown. */
export function probeBinaryVersion(
  binaryPath: string,
  run: (binaryPath: string) => string = (target) =>
    execFileSync(target, ['--version'], { encoding: 'utf8', timeout: 8000 }).toString(),
): string | null {
  try {
    return extractVersion(run(binaryPath));
  } catch {
    return null;
  }
}

/**
 * Pure comparison: warn when the first PATH-resolved binary reports a
 * different version than the managed current install. Unknown versions
 * (unparseable/unrunnable) never warn — no evidence of a gap.
 */
export function evaluatePathCandidates(
  candidates: CliOnPathEntry[],
  current: { dir: string; version: string } | null,
): StaleCliFinding | null {
  if (!current || candidates.length === 0) {
    return null;
  }
  const [first, ...rest] = candidates;
  if (!first || !first.version) {
    return null;
  }
  if (first.version === current.version) {
    return null;
  }
  return {
    firstPath: first.path,
    firstVersion: first.version,
    currentDir: current.dir,
    currentVersion: current.version,
    otherPaths: rest.map((entry) => entry.path),
  };
}

export function formatStaleDoctorWarning(finding: StaleCliFinding): string {
  return (
    `WARN: stale agent-deck on PATH: ${finding.firstPath} reports ${finding.firstVersion} ` +
    `but the current install is ${finding.currentVersion} (${finding.currentDir}). ` +
    `Reorder PATH so the current install resolves first, or run: brew uninstall agent-deck (or brew unlink agent-deck).`
  );
}

export type StaleCliCheckDeps = {
  pathEnv?: string;
  candidates?: string[];
  currentDir?: string | null;
  currentVersion?: string | null;
  probeVersion?: (binaryPath: string) => string | null;
};

/** Real-IO wrapper for `doctor`: resolve PATH, probe versions, format one warning line. */
export function checkPathForStaleCli(deps: StaleCliCheckDeps = {}): string | null {
  const currentVersion = deps.currentVersion;
  const currentDir = deps.currentDir;
  if (currentVersion == null || currentDir == null) {
    return null;
  }
  const binaries = deps.candidates ?? resolveAgentDeckOnPath({ pathEnv: deps.pathEnv });
  const probe = deps.probeVersion ?? probeBinaryVersion;
  const finding = evaluatePathCandidates(
    binaries.map((binary) => ({ path: binary, version: probe(binary) })),
    { dir: currentDir, version: currentVersion },
  );
  return finding ? formatStaleDoctorWarning(finding) : null;
}

/** Pure comparison for the mcp-launch startup check. Null means no gap to report. */
export function evaluateInvokerVersion(
  invokerVersion: string | null | undefined,
  currentVersion: string | null | undefined,
): { invokerVersion: string; currentVersion: string } | null {
  const invoker = invokerVersion?.trim();
  const current = currentVersion?.trim();
  if (!invoker || !current || invoker === current) {
    return null;
  }
  return { invokerVersion: invoker, currentVersion: current };
}

export function formatMcpLaunchStaleLine(
  gap: { invokerVersion: string; currentVersion: string },
  invokerPath?: string,
): string {
  const via = invokerPath ? ` (${invokerPath})` : '';
  return (
    `[agent-deck] WARNING: mcp-launch is running from agent-deck ${gap.invokerVersion}${via} ` +
    `while the current install is ${gap.currentVersion}; launcher behavior may be stale. ` +
    `Reorder PATH so the current install resolves first, or run: brew uninstall agent-deck (or brew unlink agent-deck). Continuing launch.`
  );
}

export type InvokerStaleCheckDeps = {
  invokerVersion?: string | null;
  invokerPath?: string;
  currentVersion?: string | null;
  log?: (line: string) => void;
};

/**
 * Log one stderr line when the invoking binary predates the managed
 * current install. Never throws and never blocks launch — log only.
 */
export function warnIfInvokerStale(deps: InvokerStaleCheckDeps = {}): string | null {
  try {
    const gap = evaluateInvokerVersion(deps.invokerVersion, deps.currentVersion);
    if (!gap) {
      return null;
    }
    const line = formatMcpLaunchStaleLine(gap, deps.invokerPath);
    (deps.log ?? ((text) => console.error(text)))(line);
    return line;
  } catch {
    return null;
  }
}
