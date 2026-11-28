import { ApiError } from "@/lib/queryClient";

export type CredentialRunApproveFailure = {
  message: string;
  /** False when the same request can never succeed, so retry is a dead end. */
  retryable: boolean;
};

/**
 * Map credential-run approval failures to actionable copy. Mirrors the
 * deck-switch mapper: terminal states (expired/consumed/unauthorized/
 * not-found) are never retryable and must never read as an approval —
 * nothing executed and no secrets were resolved.
 */
export function credentialRunApproveFailure(error: unknown): CredentialRunApproveFailure {
  if (error instanceof ApiError) {
    if (error.errorCode === "GRANT_REQUIRED" || error.errorCode === "DASHBOARD_REQUIRED") {
      return {
        message:
          "This browser is not signed in to the Agent Deck dashboard. Run agent-deck open, then open this approval link again.",
        retryable: true,
      };
    }
    if (error.errorCode === "CREDENTIAL_RUN_EXPIRED" || error.status === 410) {
      return {
        message:
          "This credential-run request expired. Nothing executed and no secrets were resolved. Ask the agent to request the run again.",
        retryable: false,
      };
    }
    if (error.errorCode === "CREDENTIAL_RUN_CONSUMED" || error.status === 409) {
      return {
        message:
          "This credential-run request was already resolved. The command was not run twice — check with the agent before requesting again.",
        retryable: false,
      };
    }
    if (error.errorCode === "RESOURCE_OUT_OF_SCOPE") {
      return {
        message:
          "This approval link does not match the requesting session. Only the matching session's request can be approved here — ask the agent for a fresh link if needed.",
        retryable: false,
      };
    }
    if (error.errorCode === "SESSION_INVALID") {
      return {
        message:
          "The agent session for this request is gone. Ask the agent to reconnect and request the run again.",
        retryable: false,
      };
    }
    if (error.status === 404) {
      return {
        message:
          "This credential-run request was not found. It may have been cleaned up. Ask the agent to request the run again.",
        retryable: false,
      };
    }
    return { message: error.message || "Approval failed", retryable: true };
  }
  if (error instanceof TypeError) {
    return {
      message: "Could not reach Agent Deck. Check that it is running (agent-deck status) and try again.",
      retryable: true,
    };
  }
  return {
    message: error instanceof Error && error.message ? error.message : "Approval failed",
    retryable: true,
  };
}
