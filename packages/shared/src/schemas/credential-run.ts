import { z } from 'zod';

/**
 * Owner-approved credential runs (`run_with_credentials` MCP tool).
 *
 * A leader agent runs a command that needs deck credentials without the
 * secrets ever reaching the agent: the daemon resolves the secrets from its
 * own vault, spawns `argv` directly (no shell) with a minimal allowlist env
 * plus the credentials, and redacts every secret value from the output.
 * Each call needs a fresh human approval bound to the exact request.
 */

/** Default execution timeout (seconds). */
export const CREDENTIAL_RUN_TIMEOUT_SEC_DEFAULT = 300;
/** Maximum execution timeout (seconds). */
export const CREDENTIAL_RUN_TIMEOUT_SEC_MAX = 3600;
/** Per-stream output cap (bytes) before truncation. */
export const CREDENTIAL_RUN_OUTPUT_MAX_BYTES = 64 * 1024;
/** argv / credential-list bounds. */
export const CREDENTIAL_RUN_ARGV_MAX_ITEMS = 128;
export const CREDENTIAL_RUN_ARGV_MAX_CHARS = 16 * 1024;
export const CREDENTIAL_RUN_IDS_MAX_ITEMS = 32;

/** Target env name for one credential: `HF_TOKEN`-style identifier. */
const CredentialRunEnvNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'env name must be a valid identifier');

export const RunWithCredentialsRequestSchema = z
  .object({
    /** Command spawned directly with `shell: false` — never interpreted. */
    argv: z
      .array(z.string().min(1).max(CREDENTIAL_RUN_ARGV_MAX_CHARS))
      .min(1)
      .max(CREDENTIAL_RUN_ARGV_MAX_ITEMS),
    /** Credential ids; every one must sit on the session's deck. */
    credentials: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(CREDENTIAL_RUN_IDS_MAX_ITEMS),
    /**
     * Target env name → credential id. Defaults to each credential's own
     * `envName`. Every alias value must be listed in `credentials`
     * (cross-field check in `validateCredentialRunEnvAlias`, enforced by
     * the backend — kept out of this schema so it stays a plain object
     * the MCP SDK can convert).
     */
    env: z.record(CredentialRunEnvNameSchema, z.string().min(1).max(200)).optional(),
    /** Working directory; must resolve inside the session's workspace. */
    cwd: z.string().min(1).max(4096).optional(),
    /** Execution timeout, 1–3600 seconds (default 300). */
    timeoutSec: z.number().int().min(1).max(CREDENTIAL_RUN_TIMEOUT_SEC_MAX).optional(),
  })
  .strict();

export type RunWithCredentialsRequest = z.infer<typeof RunWithCredentialsRequestSchema>;

/** Every env alias value must name a credential id from `credentials`. */
export function validateCredentialRunEnvAlias(input: {
  credentials: string[];
  env?: Record<string, string>;
}): string | null {
  if (!input.env) {
    return null;
  }
  const listed = new Set(input.credentials);
  for (const [name, id] of Object.entries(input.env)) {
    if (!listed.has(id)) {
      return `env alias "${name}" names credential "${id}" which is not in credentials`;
    }
  }
  return null;
}

/** Owner decision on one pending credential-run request (dashboard-only). */
export const CredentialRunResolveBodySchema = z
  .object({
    runtimeSessionId: z.string().min(1),
    decision: z.enum(['approve', 'decline']),
    /** The client's permission prompt was the human approval. */
    approvedVia: z.enum(['client']).optional(),
  })
  .strict();

export type CredentialRunResolveBody = z.infer<typeof CredentialRunResolveBodySchema>;
