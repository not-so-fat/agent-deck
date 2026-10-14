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
  })
  .strict();

/**
 * Lifecycle state. `starting` is the launch acknowledgement (record written,
 * no event yet); `running` has emitted events; `ended`, `error`, and `died`
 * are terminal. `running` never implies success.
 */
export const AgentRunStateSchema = z.enum(['starting', 'running', 'ended', 'error', 'died']);
export const AGENT_RUN_TERMINAL_STATES = ['ended', 'error', 'died'] as const;

export const CreateAgentRunResponseSchema = z
  .object({
    runId: AgentRunIdSchema,
    state: AgentRunStateSchema,
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

/** Run-specific error codes (auth failures use the trusted-session codes). */
export const AgentRunErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'REQUEST_TOO_LARGE',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
  'DECK_NOT_FOUND',
  'WORKSPACE_INVALID',
  'WORKSPACE_MISMATCH',
  'CLIENT_UNAVAILABLE',
  'PROFILE_UNSUPPORTED',
  'RUN_NOT_FOUND',
]);

export type AgentRunClient = z.infer<typeof AgentRunClientSchema>;
export type AgentRunTools = z.infer<typeof AgentRunToolsSchema>;
export type CreateAgentRunRequest = z.infer<typeof CreateAgentRunRequestSchema>;
export type CreateAgentRunResponse = z.infer<typeof CreateAgentRunResponseSchema>;
export type AgentRunState = z.infer<typeof AgentRunStateSchema>;
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;
export type AgentRunEvent = z.infer<typeof AgentRunEventSchema>;
export type AgentRunEventsQuery = z.infer<typeof AgentRunEventsQuerySchema>;
export type AgentRunEventsResponse = z.infer<typeof AgentRunEventsResponseSchema>;
export type AgentRunErrorCode = z.infer<typeof AgentRunErrorCodeSchema>;

export type AgentRunErrorBody = {
  success: false;
  error: string;
  error_code: AgentRunErrorCode;
};

export function agentRunError(code: AgentRunErrorCode, message: string): AgentRunErrorBody {
  return { success: false, error: message, error_code: code };
}
