import { ApiError } from "@/lib/queryClient";

export type DeckAssignmentApproveFailure = {
  message: string;
  /** False when the same request can never succeed, so retry is a dead end. */
  retryable: boolean;
};

/**
 * Map deck-assignment approval failures to actionable copy (NOT-597).
 * Mirrors the deck-switch mapper: terminal states are never retryable
 * and must never read as a successful assignment.
 */
export function deckAssignmentApproveFailure(error: unknown): DeckAssignmentApproveFailure {
  if (error instanceof ApiError) {
    if (error.errorCode === "GRANT_REQUIRED" || error.errorCode === "DASHBOARD_REQUIRED") {
      return {
        message:
          "This browser is not signed in to the Agent Deck dashboard. Run agent-deck open, then open this approval link again.",
        retryable: true,
      };
    }
    if (error.errorCode === "DECK_SWITCH_EXPIRED" || error.status === 410) {
      return {
        message:
          "This deck-assignment request expired. Nothing was assigned. Ask the agent to request the assignment again.",
        retryable: false,
      };
    }
    if (error.errorCode === "DECK_SWITCH_CONSUMED" || error.status === 409) {
      return {
        message:
          "This deck-assignment request was already resolved. The assignment was not applied twice — check the current deck before requesting again.",
        retryable: false,
      };
    }
    if (error.errorCode === "SESSION_INVALID") {
      return {
        message:
          "The folder for this request is no longer valid. Ask the agent to request the assignment again with the correct folder.",
        retryable: false,
      };
    }
    if (error.status === 404) {
      return {
        message:
          "This deck-assignment request was not found. It may have been cleaned up. Ask the agent to request the assignment again.",
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
