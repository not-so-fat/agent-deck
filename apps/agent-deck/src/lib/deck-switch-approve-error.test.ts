import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/queryClient";
import { deckSwitchApproveFailure } from "@/lib/deck-switch-approve-error";

describe("deckSwitchApproveFailure", () => {
  it("explains a missing dashboard session and allows retry", () => {
    const failure = deckSwitchApproveFailure(new ApiError("auth required", 401, "GRANT_REQUIRED"));
    expect(failure.message).toContain("agent-deck open");
    expect(failure.retryable).toBe(true);
  });

  it("reports expiry as terminal and never claims a switch", () => {
    const failure = deckSwitchApproveFailure(
      new ApiError("Deck-switch request expired", 410, "DECK_SWITCH_EXPIRED"),
    );
    expect(failure.message).toContain("expired");
    expect(failure.message).toContain("were not changed");
    expect(failure.message).not.toMatch(/approved|switched to/i);
    expect(failure.retryable).toBe(false);
  });

  it("reports an already-resolved request as terminal", () => {
    const failure = deckSwitchApproveFailure(
      new ApiError("already resolved", 409, "DECK_SWITCH_CONSUMED"),
    );
    expect(failure.message).toContain("already resolved");
    expect(failure.retryable).toBe(false);
  });

  it("reports a session mismatch as unauthorized without retry", () => {
    const failure = deckSwitchApproveFailure(
      new ApiError("belongs to a different session", 403, "RESOURCE_OUT_OF_SCOPE"),
    );
    expect(failure.message).toContain("does not match");
    expect(failure.retryable).toBe(false);
  });

  it("reports a gone session without retry", () => {
    const failure = deckSwitchApproveFailure(new ApiError("absent", 401, "SESSION_INVALID"));
    expect(failure.retryable).toBe(false);
  });

  it("reports a missing request without retry", () => {
    const failure = deckSwitchApproveFailure(new ApiError("not found", 404));
    expect(failure.retryable).toBe(false);
  });

  it("reports an unreachable backend with retry", () => {
    const failure = deckSwitchApproveFailure(new TypeError("Failed to fetch"));
    expect(failure.message).toContain("agent-deck status");
    expect(failure.retryable).toBe(true);
  });

  it("falls back to the server message for unknown errors", () => {
    const failure = deckSwitchApproveFailure(new ApiError("boom", 500));
    expect(failure.message).toBe("boom");
    expect(failure.retryable).toBe(true);
  });
});
