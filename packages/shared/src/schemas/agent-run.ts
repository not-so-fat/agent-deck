import { z } from 'zod';

/**
 * Agent run HTTP contract (NOT-480): one coding-agent attempt on the Agent
 * Deck host, started or continued by an authenticated remote coordinator.
 *
 * Responses carry only public lifecycle fields and normalized events —
 * never a host pid, a private log path, credentials, or an Authorization
 * value. Success bodies are wrapped as `{ success: true, data }`.
 */

/** Prompt bound checked before launch (characters). */
export const AGENT_RUN_PROMPT_MAX_CHARS = 64 * 1024;
/** Whole-request bound for `POST /api/agent-runs` (bytes). */
export const AGENT_RUN_REQUEST_BODY_LIMIT_BYTES = 256 * 1024;
/** Required on `POST /api/agent-runs`; scoped to the calling grant. */
export const AGENT_RUN_IDEMPOTENCY_HEADER = 'idempotency-key';
export const AGENT_RUN_EVENTS_DEFAULT_LIMIT = 200;
export const AGENT_RUN_EVENTS_MAX_LIMIT = 1000;

export const AgentRunClientSchema = z.enum(['claude', 'codex', 'cursor', 'muse']);
export const AgentRunToolsSchema = z.enum(['readonly', 'edit']);

/** Opaque run id (`run-<UTC stamp>-<hex>`). */
export const AgentRunIdSchema = z.string().regex(/^run-\d{8}T\d{6}-[0-9a-f]{6}$/);

export const AgentRunIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, 'Idempotency-Key must be printable ASCII without spaces');

function isAbsoluteHostPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

export const CreateAgentRunRequestSchema = z
  .object({
    deckId: z.string().min(1).max(200),
    client: AgentRunClientSchema,
    /** Absolute working directory on the Agent Deck host. */
    cwd: z
      .string()
      .min(1)
      .max(4096)
      .refine(isAbsoluteHostPath, 'cwd must be an absolute path on the Agent Deck host'),
    prompt: z
      .string()
      .max(AGENT_RUN_PROMPT_MAX_CHARS)
      .refine((value) => value.trim().length > 0, 'prompt must not be empty'),
    /** Explicit tool profile; `readonly` only when omitted. */
    tools: AgentRunToolsSchema.default('readonly'),
    /** Opaque client session id from an earlier run's status. */
    resumeSessionId: z.string().min(1).max(512).optional(),
    /**
     * NOT-486: capture a private pre-launch Git baseline so this run can be
     * finalized into one local commit. Valid only with `tools: "edit"`, a Git
     * worktree `cwd`, and a clean Git index.
     */
    prepareFinalization: z.boolean().default(false),
  })
  .strict();

/**
 * NOT-539: trusted-session MCP start (`start_run`). The deck is the live
 * runtime-session deck and the cwd is the session's launch-bound workspace,
 * so neither is accepted here — an extra `deckId` or `cwd` is rejected.
 */
export const StartSessionAgentRunRequestSchema = z
  .object({
    client: AgentRunClientSchema,
    prompt: z
      .string()
      .max(AGENT_RUN_PROMPT_MAX_CHARS)
      .refine((value) => value.trim().length > 0, 'prompt must not be empty'),
    tools: AgentRunToolsSchema.default('readonly'),
    resumeSessionId: z.string().min(1).max(512).optional(),
    prepareFinalization: z.boolean().default(false),
    /** One pinned playbook version for the run's MCP session (NOT-537). */
    playbookVersion: z
      .object({ playbookId: z.string().min(1).max(200), versionId: z.string().min(1).max(200) })
      .strict()
      .optional(),
  })
  .strict();

/**
 * NOT-539: launch-bound execution workspace the Agent Deck MCP server sends
 * on trusted-session run calls. Distinct from the display workspace header,
 * which `bind_workspace` can move.
 */
export const AGENT_RUN_EXECUTION_WORKSPACE_HEADER = 'x-agent-deck-execution-workspace';

/**
 * NOT-539: `WORKSPACE_REQUIRED` remedy. The agent cannot fix this itself, so
 * it names the launcher — never a CLI command, a port, or a local URL.
 */
export const AGENT_RUN_WORKSPACE_REQUIRED_MESSAGE =
  'This MCP session was launched without a host execution workspace, so start_run has nowhere to run and the agent cannot choose one. ' +
  'The launcher that started this session (for example Agent Dealer) must provide its workspace when it launches the session.';

/**
 * Lifecycle state. `starting` is the launch acknowledgement (record written,
 * no event yet); `running` has emitted events; `ended`, `error`, `died`, and
 * `canceled` (NOT-481: operator cancellation, never an execution error) are
 * terminal. `running` never implies success.
 */
export const AgentRunStateSchema = z.enum(['starting', 'running', 'ended', 'error', 'died', 'canceled']);
export const AGENT_RUN_TERMINAL_STATES = ['ended', 'error', 'died', 'canceled'] as const;

export const CreateAgentRunResponseSchema = z
  .object({
    runId: AgentRunIdSchema,
    state: AgentRunStateSchema,
  })
  .strict();

/** Lowercase hex Git object id (SHA-1 or SHA-256 repositories). */
export const GitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
/** Opaque reference to a run's private pre-launch Git baseline. */
export const FinalizationBaselineRefSchema = z.string().regex(/^bl_[0-9a-f]{24}$/);

/**
 * `prepared`: baseline captured, not finalized; `finalizing`: one finalize
 * request is in progress; `finalized`: one local commit was created.
 */
export const FinalizationStateSchema = z.enum(['prepared', 'finalizing', 'finalized']);

/** Public finalization fields on a prepared run (never a host path or file content). */
export const AgentRunFinalizationStatusSchema = z
  .object({
    baselineRef: FinalizationBaselineRefSchema,
    baselineDigest: Sha256HexSchema,
    state: FinalizationStateSchema,
    commit: GitObjectIdSchema.nullable(),
  })
  .strict();

export const AgentRunStatusSchema = z
  .object({
    runId: AgentRunIdSchema,
    deckId: z.string(),
    client: AgentRunClientSchema,
    tools: AgentRunToolsSchema,
    state: AgentRunStateSchema,
    /** Opaque client session id; pass as `resumeSessionId` to continue. */
    sessionId: z.string().nullable(),
    startedAt: z.string(),
    lastEventAt: z.string().nullable(),
    /** NOT-486: present only when the run was started with `prepareFinalization`. */
    finalization: AgentRunFinalizationStatusSchema.nullable(),
  })
  .strict();

const eventBase = { seq: z.number().int().positive(), ts: z.string() };

/**
 * Normalized run events, in log order. `seq` is the event's 1-based position
 * in the canonical log: stable across reads and strictly increasing.
 */
export const AgentRunEventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('text'), text: z.string() }).strict(),
  z.object({ ...eventBase, type: z.literal('tool'), name: z.string() }).strict(),
  z
    .object({ ...eventBase, type: z.literal('notice'), message: z.string(), sessionId: z.string().nullable() })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('result'),
      subtype: z.string(),
      result: z.unknown(),
      sessionId: z.string().nullable(),
    })
    .strict(),
  z.object({ ...eventBase, type: z.literal('end'), sessionId: z.string().nullable() }).strict(),
  z
    .object({ ...eventBase, type: z.literal('error'), message: z.string(), sessionId: z.string().nullable() })
    .strict(),
  /** Terminal operator cancellation (NOT-481); no event follows it. */
  z.object({ ...eventBase, type: z.literal('canceled'), sessionId: z.string().nullable() }).strict(),
]);

export const AgentRunEventsQuerySchema = z
  .object({
    /** Cursor from a previous read's `nextCursor`; omitted reads from the start. */
    after: z.string().regex(/^\d+$/).optional(),
    limit: z.coerce.number().int().min(1).max(AGENT_RUN_EVENTS_MAX_LIMIT).optional(),
  })
  .strict();

export const AgentRunEventsResponseSchema = z
  .object({
    runId: AgentRunIdSchema,
    state: AgentRunStateSchema,
    events: z.array(AgentRunEventSchema),
    /** Pass as `after` to read the next page; unchanged when nothing new arrived. */
    nextCursor: z.string(),
  })
  .strict();

/** NOT-539: `get_run` — the public status plus one cursor page of ordered events. */
export const SessionAgentRunResponseSchema = AgentRunStatusSchema.extend({
  events: z.array(AgentRunEventSchema),
  nextCursor: z.string(),
}).strict();

/**
 * `GET /api/agent-runs/capabilities` (NOT-481): only clients whose real host
 * preflight (installed and signed in) passes are listed. `start`/`resume`
 * name the tool profiles the client can enforce; `same_profile_provenance`
 * means a resume continues only a session an Agent Deck run on this host
 * started with the same deck, cwd, and tools.
 */
export const AgentRunClientCapabilitySchema = z
  .object({
    client: AgentRunClientSchema,
    start: z.array(AgentRunToolsSchema),
    resume: z.array(AgentRunToolsSchema),
    resumeRequires: z.enum(['none', 'same_profile_provenance']),
  })
  .strict();

export const AgentRunCapabilitiesResponseSchema = z
  .object({
    /** Runs execute on the Agent Deck host; `cwd` is a path on that host. */
    host: z.literal('same-host'),
    clients: z.array(AgentRunClientCapabilitySchema),
  })
  .strict();

/**
 * NOT-486: one manifest entry. Repository-relative POSIX path; `sha256` is
 * the SHA-256 of the exact working-tree bytes and `mode` the Git file mode.
 * A deleted path carries `sha256: null` and `mode: null`.
 */
export const FINALIZATION_MANIFEST_MAX_FILES = 1000;
export const FINALIZATION_PATH_MAX_CHARS = 1024;
export const FINALIZATION_COMMIT_MESSAGE_MAX_CHARS = 8192;
export const FINALIZATION_REVIEW_ID_MAX_CHARS = 200;

export const FinalizationFileModeSchema = z.enum(['100644', '100755']);

export const FinalizationManifestEntrySchema = z
  .object({
    path: z.string().min(1).max(FINALIZATION_PATH_MAX_CHARS),
    sha256: Sha256HexSchema.nullable(),
    mode: FinalizationFileModeSchema.nullable(),
  })
  .strict()
  .refine((entry) => (entry.sha256 === null) === (entry.mode === null), {
    message: 'sha256 and mode are both null (deleted) or both set',
  });

/** `GET /api/agent-runs/:runId/changes`: the candidate manifest, ordered by path. */
export const AgentRunChangesResponseSchema = z
  .object({
    runId: AgentRunIdSchema,
    baselineRef: FinalizationBaselineRefSchema,
    baselineDigest: Sha256HexSchema,
    /** Pass as `expectedBaseCommit` when finalizing. */
    baseCommit: GitObjectIdSchema,
    files: z.array(FinalizationManifestEntrySchema),
    manifestDigest: Sha256HexSchema,
  })
  .strict();

/** `POST /api/agent-runs/:runId/finalize` (requires `Idempotency-Key`). */
export const FinalizeAgentRunRequestSchema = z
  .object({
    baselineDigest: Sha256HexSchema,
    expectedBaseCommit: GitObjectIdSchema,
    reviewId: z
      .string()
      .min(1)
      .max(FINALIZATION_REVIEW_ID_MAX_CHARS)
      .regex(/^[\x21-\x7e]+$/, 'reviewId must be printable ASCII without spaces'),
    commitMessage: z
      .string()
      .max(FINALIZATION_COMMIT_MESSAGE_MAX_CHARS)
      .refine((value) => value.trim().length > 0, 'commitMessage must not be empty')
      .refine((value) => !value.includes('\u0000'), 'commitMessage must not contain NUL'),
    files: z.array(FinalizationManifestEntrySchema).min(1).max(FINALIZATION_MANIFEST_MAX_FILES),
  })
  .strict();

export const FinalizeAgentRunResponseSchema = z
  .object({
    runId: AgentRunIdSchema,
    finalizationState: z.literal('finalized'),
    commit: GitObjectIdSchema,
    tree: GitObjectIdSchema,
    parent: GitObjectIdSchema,
    manifestDigest: Sha256HexSchema,
    fileCount: z.number().int().positive(),
    reviewId: z.string(),
  })
  .strict();

/** Run-specific error codes (auth failures use the trusted-session codes). */
export const AgentRunErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'REQUEST_TOO_LARGE',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
  'DECK_NOT_FOUND',
  'WORKSPACE_INVALID',
  'WORKSPACE_MISMATCH',
  // NOT-539: the MCP session carries no launch-bound execution workspace.
  'WORKSPACE_REQUIRED',
  'CLIENT_UNAVAILABLE',
  'PROFILE_UNSUPPORTED',
  'RESUME_UNVERIFIED',
  'RUN_NOT_FOUND',
  'RUN_NOT_CANCELABLE',
  // NOT-486: finalization.
  'FINALIZATION_INVALID',
  'FINALIZATION_NOT_PREPARED',
  'RUN_NOT_TERMINAL',
  'BASE_MISMATCH',
  'INDEX_DIRTY',
  'BASELINE_MISMATCH',
  'PATH_INVALID',
  'PATH_UNEXPECTED',
  'DIGEST_MISMATCH',
  'GIT_LOCK_CONFLICT',
  'REF_RACE',
  'FINALIZATION_CANCELED',
  'FINALIZATION_FAILED',
]);

export type AgentRunClient = z.infer<typeof AgentRunClientSchema>;
export type AgentRunTools = z.infer<typeof AgentRunToolsSchema>;
export type CreateAgentRunRequest = z.infer<typeof CreateAgentRunRequestSchema>;
export type StartSessionAgentRunRequest = z.infer<typeof StartSessionAgentRunRequestSchema>;
export type SessionAgentRunResponse = z.infer<typeof SessionAgentRunResponseSchema>;
export type CreateAgentRunResponse =z.infer<typeof CreateAgentRunResponseSchema>;
export type AgentRunState = z.infer<typeof AgentRunStateSchema>;
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;
export type AgentRunEvent = z.infer<typeof AgentRunEventSchema>;
export type AgentRunEventsQuery = z.infer<typeof AgentRunEventsQuerySchema>;
export type AgentRunEventsResponse = z.infer<typeof AgentRunEventsResponseSchema>;
export type AgentRunErrorCode = z.infer<typeof AgentRunErrorCodeSchema>;
export type AgentRunClientCapability = z.infer<typeof AgentRunClientCapabilitySchema>;
export type AgentRunCapabilitiesResponse = z.infer<typeof AgentRunCapabilitiesResponseSchema>;
export type FinalizationState = z.infer<typeof FinalizationStateSchema>;
export type AgentRunFinalizationStatus = z.infer<typeof AgentRunFinalizationStatusSchema>;
export type FinalizationFileMode = z.infer<typeof FinalizationFileModeSchema>;
export type FinalizationManifestEntry = z.infer<typeof FinalizationManifestEntrySchema>;
export type AgentRunChangesResponse = z.infer<typeof AgentRunChangesResponseSchema>;
export type FinalizeAgentRunRequest = z.infer<typeof FinalizeAgentRunRequestSchema>;
export type FinalizeAgentRunResponse = z.infer<typeof FinalizeAgentRunResponseSchema>;

export type AgentRunErrorBody = {
  success: false;
  error: string;
  error_code: AgentRunErrorCode;
};

export function agentRunError(code: AgentRunErrorCode, message: string): AgentRunErrorBody {
  return { success: false, error: message, error_code: code };
}
