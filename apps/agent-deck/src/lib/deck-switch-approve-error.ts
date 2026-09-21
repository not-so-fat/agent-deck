import { ApiError } from "@/lib/queryClient";

export type DeckSwitchApproveFailure = {
  message: string;
  /** False when the same request can never succeed, so retry is a dead end. */
  retryable: boolean;
};

/**
 * Map deck-switch approval failures to actionable copy (NOT-210).
 * Terminal states (expired/consumed/unauthorized/not-found) are never
 * retryable and must never read as a successful switch.
 */
export function deckSwitchApproveFailure(error: unknown): DeckSwitchApproveFailure {
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
          "This deck-switch request expired. The session and workspace default were not changed. Ask the agent to request the switch again.",
        retryable: false,
      };
    }
    if (error.errorCode === "DECK_SWITCH_CONSUMED" || error.status === 409) {
      return {
        message:
          "This deck-switch request was already resolved. The switch was not applied twice — check the current deck before requesting again.",
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
          "The agent session for this request is gone. Ask the agent to reconnect and request the deck switch again.",
        retryable: false,
      };
    }
    if (error.status === 404) {
      return {
        message:
          "This deck-switch request was not found. It may have been cleaned up. Ask the agent to request the switch again.",
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
