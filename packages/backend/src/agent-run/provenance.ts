/**
 * Trusted resume provenance for codex runs (NOT-484), extended to claude
 * runs (NOT-672).
 *
 * `codex exec resume` accepts no sandbox flag: the thread keeps the sandbox
 * it started with. A claude resume re-applies the requested profile's
 * options, but must still never continue a session another profile
 * started. So a resume is only as safe as what Agent Deck knows about the
 * run that started the session. The origin is the earliest run record
 * under `<homeDir>/runs/` that is a start (not itself a resume) and
 * captured the requested session id. A resume is allowed only when that
 * origin exists and matches the request on client, deck, canonical cwd, and
 * tool profile — so edit→edit and readonly→readonly continue, while an
 * unknown/external session, a readonly→edit escalation, an edit→readonly
 * mislabel, or a cross-deck/cross-client/cwd mismatch fails closed before
 * anything is spawned.
 *
 * Only Agent Deck's own run records count as provenance; runs written to a
 * custom `--log` path live outside `runs/` and are not discoverable.
 *
 * Known limitation (NOT-672): claude resumes written before the provenance
 * gate carry no `resumedFrom` and no resume notice, so they are
 * indistinguishable from starts and can serve as an origin for their
 * session id. The resumed session still runs under the requested profile's
 * freshly passed options (the primary enforcement); provenance is
 * defense-in-depth, and the grandfathered set is the operator's own
 * pre-existing resume records only.
 */
import fs from 'node:fs';

import type { RunClient, RunToolsProfile } from './adapter';
import { readRunLog, readRunMeta, runPaths, runsRoot, type RunMeta, type RunResumeOrigin } from './records';

export type ResumeProvenanceRequest = {
  client: RunClient;
  cwd: string;
  tools: RunToolsProfile;
  resumeId: string;
};

export type ResumeProvenance = { ok: true; origin: RunResumeOrigin } | { ok: false; error: string };

/** Realpath of `dir`, or null when it no longer resolves. */
export function canonicalCwd(dir: string): string | null {
  try {
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

/** Run records (default location only) that captured `sessionId`, oldest first. */
function recordsForSession(homeDir: string, sessionId: string): RunMeta[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(runsRoot(homeDir));
  } catch {
    return [];
  }
  const metas: RunMeta[] = [];
  for (const runId of entries) {
    const read = readRunMeta(runPaths(homeDir, runId).metaPath);
    if (read.ok && read.meta.runId === runId && read.meta.sessionId === sessionId) {
      metas.push(read.meta);
    }
  }
  metas.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  return metas;
}

/**
 * Pre-NOT-484 versions resumed codex threads without recording resumedFrom;
 * such a run's log opens with the adapter's resume notice. It is not a start,
 * so it cannot vouch for the thread's sandbox.
 */
function isUnmarkedResume(homeDir: string, meta: RunMeta): boolean {
  const first = readRunLog(runPaths(homeDir, meta.runId).logPath).events[0]?.event;
  return (
    first?.t === 'notice' && typeof first.message === 'string' && first.message.startsWith('Resuming codex thread ')
  );
}

/**
 * Resolve and check the origin of a resume. A detached starter's
 * pre-written record carries no session id, so it never matches.
 */
export function resolveResumeProvenance(
  homeDir: string,
  request: ResumeProvenanceRequest,
  deck: { id: string; name: string },
): ResumeProvenance {
  const { resumeId } = request;
  const records = recordsForSession(homeDir, resumeId);
  const origin = records.find((meta) => !meta.resumedFrom && !isUnmarkedResume(homeDir, meta));
  if (!origin) {
    const because =
      request.client === 'codex'
        ? 'so its sandbox is unknown'
        : 'so its permissions are unknown';
    return {
      ok: false,
      error:
        `Cannot resume ${request.client} session ${resumeId}: no Agent Deck run on this host started it, ` +
        `${because}. Resume only a sessionId printed by \`agent-deck run\` ` +
        `(see \`agent-deck run list\`), or start a new run without --resume.`,
    };
  }
  if (origin.client !== request.client) {
    return {
      ok: false,
      error:
        `Cannot resume session ${resumeId} with --client ${request.client}: it was started by ` +
        `--client ${origin.client} in run ${origin.runId}. Resume it with --client ${origin.client}, or start a new run.`,
    };
  }
  if (origin.deck !== deck.id) {
    return {
      ok: false,
      error:
        `Cannot resume session ${resumeId} on deck "${deck.name}" (${deck.id}): run ${origin.runId} ` +
        `started it on deck ${origin.deck}. Resume it on that deck, or start a new run on "${deck.name}".`,
    };
  }
  const requested = canonicalCwd(request.cwd);
  const recorded = origin.canonicalCwd ?? canonicalCwd(origin.cwd);
  if (!requested || !recorded || requested !== recorded) {
    return {
      ok: false,
      error:
        `Cannot resume session ${resumeId} in ${request.cwd}: run ${origin.runId} started it in ` +
        `${recorded ?? origin.cwd}. Resume it with --cwd ${recorded ?? origin.cwd}, or start a new run here.`,
    };
  }
  if (origin.tools !== request.tools) {
    const because =
      request.client === 'codex'
        ? `and a resumed ${request.client} thread keeps its original sandbox`
        : 'and a resumed session must never keep another profile\'s permissions';
    return {
      ok: false,
      error:
        `Cannot resume session ${resumeId} with --tools ${request.tools}: run ${origin.runId} started it ` +
        `with --tools ${origin.tools}, ${because}. ` +
        `Resume with --tools ${origin.tools}, or start a new run with --tools ${request.tools}.`,
    };
  }
  return { ok: true, origin: { runId: origin.runId, sessionId: resumeId, tools: origin.tools } };
}

/**
 * Clients whose resume must prove same-profile provenance: codex (the
 * thread keeps its original sandbox) and claude (a resumed SDK session
 * must never keep another profile's permissions; NOT-672).
 */
export function resumeNeedsProvenance(client: RunClient): boolean {
  return client === 'codex' || client === 'claude';
}
