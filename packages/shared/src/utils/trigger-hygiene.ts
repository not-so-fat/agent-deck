import type { PlaybookSummary } from '../schemas/playbook';

export const MAX_TRIGGERS_PER_PLAYBOOK = 16;
export const MAX_TRIGGER_LENGTH = 80;
export const TRIGGER_OVERLAP_JACCARD_THRESHOLD = 0.6;

export type TriggerConflictLevel = 'exact' | 'subsumes' | 'overlap';

export type TriggerConflict = {
  trigger: string;
  otherPlaybookId: string;
  otherPlaybookTitle: string;
  otherTrigger: string;
  level: TriggerConflictLevel;
};

export type TriggerCountPolicy =
  | { mode: 'create' }
  | { mode: 'update'; previousCount: number };

export type TriggerValidationDetails = {
  code: 'TRIGGER_COUNT' | 'TRIGGER_LENGTH';
  currentCount?: number;
  maxCount?: number;
  previousCount?: number;
  /** Shorter copy for dashboard create/edit when the user typed triggers. */
  userMessage?: string;
};

export function normalizeTrigger(trigger: string): string {
  return trigger.trim().replace(/\s+/g, ' ');
}

export class TriggerValidationError extends Error {
  readonly details?: TriggerValidationDetails;

  constructor(message: string, details?: TriggerValidationDetails) {
    super(message);
    this.name = 'TriggerValidationError';
    this.details = details;
  }
}

const AGENT_RETRY_HINT =
  ' Fix the trigger list and retry — do not ask the user to resolve this.';

/** Pick agent vs dashboard copy for API/MCP responses. */
export function triggerErrorMessage(
  error: TriggerValidationError,
  forAgent: boolean,
): string {
  if (!forAgent && error.details?.userMessage) {
    return error.details.userMessage;
  }
  if (forAgent && error.details?.code === 'TRIGGER_COUNT') {
    return error.message.includes('do not ask the user')
      ? error.message
      : `${error.message}${AGENT_RETRY_HINT}`;
  }
  return error.message;
}

/**
 * Create: hard max 16.
 * Update: allow ≤16, or ≤ previousCount (grandfather — keep/shrink over-cap, never grow).
 */
export function assertTriggerCountPolicy(
  nextCount: number,
  policy: TriggerCountPolicy,
): void {
  if (policy.mode === 'create') {
    if (nextCount <= MAX_TRIGGERS_PER_PLAYBOOK) {
      return;
    }
    throw new TriggerValidationError(
      `At most ${MAX_TRIGGERS_PER_PLAYBOOK} triggers per playbook (got ${nextCount}).`,
      {
        code: 'TRIGGER_COUNT',
        currentCount: nextCount,
        maxCount: MAX_TRIGGERS_PER_PLAYBOOK,
        userMessage: `At most ${MAX_TRIGGERS_PER_PLAYBOOK} triggers per playbook. Remove extras before saving.`,
      },
    );
  }

  const { previousCount } = policy;
  if (nextCount <= MAX_TRIGGERS_PER_PLAYBOOK) {
    return;
  }
  if (nextCount <= previousCount) {
    return;
  }

  // Growing past 16 from an under/at-cap list
  if (previousCount <= MAX_TRIGGERS_PER_PLAYBOOK) {
    const userMessage = `At most ${MAX_TRIGGERS_PER_PLAYBOOK} triggers per playbook. Remove extras before saving.`;
    throw new TriggerValidationError(`${userMessage}${AGENT_RETRY_HINT}`, {
      code: 'TRIGGER_COUNT',
      currentCount: nextCount,
      maxCount: MAX_TRIGGERS_PER_PLAYBOOK,
      previousCount,
      userMessage,
    });
  }

  throw new TriggerValidationError(
    `Cannot grow triggers while over the ${MAX_TRIGGERS_PER_PLAYBOOK}-trigger guide (had ${previousCount}, got ${nextCount}). Keep count ≤ ${previousCount}, or trim to ≤ ${MAX_TRIGGERS_PER_PLAYBOOK}.${AGENT_RETRY_HINT}`,
    {
      code: 'TRIGGER_COUNT',
      currentCount: nextCount,
      maxCount: MAX_TRIGGERS_PER_PLAYBOOK,
      previousCount,
      userMessage: `Cannot add more triggers while this playbook already has ${previousCount} (over the ${MAX_TRIGGERS_PER_PLAYBOOK} guide). Remove some first.`,
    },
  );
}

export function normalizeTriggers(
  triggers: string[],
  opts: { maxCount?: number | null } = {},
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // null = no count cap (store / update grandfather / stub sync). Default keeps create hygiene.
  const maxCount =
    opts.maxCount === undefined ? MAX_TRIGGERS_PER_PLAYBOOK : opts.maxCount;

  for (const raw of triggers) {
    const normalized = normalizeTrigger(raw);
    if (!normalized) {
      continue;
    }
    if (normalized.length > MAX_TRIGGER_LENGTH) {
      throw new TriggerValidationError(
        `Trigger exceeds ${MAX_TRIGGER_LENGTH} characters: ${normalized.slice(0, 24)}…`,
        { code: 'TRIGGER_LENGTH' },
      );
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(normalized);
  }

  if (maxCount != null && out.length > maxCount) {
    const userMessage = `At most ${maxCount} triggers per playbook. Remove extras before saving.`;
    throw new TriggerValidationError(userMessage, {
      code: 'TRIGGER_COUNT',
      currentCount: out.length,
      maxCount,
      userMessage,
    });
  }

  return out;
}

function tokenize(trigger: string): string[] {
  return normalizeTrigger(trigger).toLowerCase().split(/\s+/).filter(Boolean);
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((token) => setB.has(token)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function isTokenSubsequence(shorter: string[], longer: string[]): boolean {
  if (shorter.length === 0 || shorter.length >= longer.length) {
    return false;
  }
  let index = 0;
  for (const token of longer) {
    if (token === shorter[index]) {
      index += 1;
      if (index === shorter.length) {
        return true;
      }
    }
  }
  return false;
}

function classifyPair(
  candidateTrigger: string,
  otherTrigger: string,
): TriggerConflictLevel | null {
  const normCandidate = normalizeTrigger(candidateTrigger);
  const normOther = normalizeTrigger(otherTrigger);
  if (!normCandidate || !normOther) {
    return null;
  }

  if (normCandidate.toLowerCase() === normOther.toLowerCase()) {
    return 'exact';
  }

  const tokensCandidate = tokenize(candidateTrigger);
  const tokensOther = tokenize(otherTrigger);

  if (
    isTokenSubsequence(tokensCandidate, tokensOther) ||
    isTokenSubsequence(tokensOther, tokensCandidate)
  ) {
    return 'subsumes';
  }

  if (
    tokensCandidate.length >= 2 &&
    tokensOther.length >= 2 &&
    jaccard(tokensCandidate, tokensOther) >= TRIGGER_OVERLAP_JACCARD_THRESHOLD
  ) {
    return 'overlap';
  }

  return null;
}

function conflictKey(conflict: TriggerConflict): string {
  return `${conflict.trigger}\0${conflict.otherPlaybookId}\0${conflict.level}`;
}

export function detectTriggerConflicts(
  candidate: PlaybookSummary,
  deckPlaybooks: PlaybookSummary[],
): TriggerConflict[] {
  const conflicts: TriggerConflict[] = [];
  const seen = new Set<string>();

  for (const other of deckPlaybooks) {
    if (other.id === candidate.id) {
      continue;
    }

    for (const trigger of candidate.triggers) {
      for (const otherTrigger of other.triggers) {
        const level = classifyPair(trigger, otherTrigger);
        if (!level) {
          continue;
        }

        const conflict: TriggerConflict = {
          trigger: normalizeTrigger(trigger),
          otherPlaybookId: other.id,
          otherPlaybookTitle: other.title,
          otherTrigger: normalizeTrigger(otherTrigger),
          level,
        };
        const key = conflictKey(conflict);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        conflicts.push(conflict);
      }
    }
  }

  return conflicts;
}
