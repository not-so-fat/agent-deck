import { ApiError } from "@/lib/queryClient";

export type AdminApproveFailure = {
  message: string;
  /** False when the same challenge can never succeed, so the button is only a dead end. */
  retryable: boolean;
};

/** Map approval failures to actionable copy (NOT-199) — never the raw "No deck selected". */
export function adminApproveFailure(error: unknown): AdminApproveFailure {
  if (error instanceof ApiError) {
    if (error.errorCode === "GRANT_REQUIRED" || error.errorCode === "DASHBOARD_REQUIRED") {
      return {
        message:
          "This browser is not signed in to the Agent Deck dashboard. Run agent-deck open, then open this approval link again.",
        retryable: true,
      };
    }
    if (error.errorCode === "ADMIN_CHALLENGE_EXPIRED") {
      return {
        message:
          "This approval request expired or was already used. Ask the agent to request admin elevation again.",
        retryable: false,
      };
    }
    if (error.errorCode === "SESSION_INVALID") {
      return {
        message:
          "The agent session for this request is gone. Ask the agent to reconnect and request admin elevation again.",
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
