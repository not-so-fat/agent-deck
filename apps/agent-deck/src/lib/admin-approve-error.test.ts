import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/queryClient";
import { adminApproveFailure } from "@/lib/admin-approve-error";

describe("adminApproveFailure", () => {
  it("explains a missing dashboard session instead of 'No deck selected'", () => {
    const failure = adminApproveFailure(
      new ApiError("No deck selected for this connection", 401, "GRANT_REQUIRED"),
    );
    expect(failure.message).toContain("agent-deck open");
    expect(failure.message).not.toContain("No deck selected");
    expect(failure.retryable).toBe(true);
  });

  it("treats DASHBOARD_REQUIRED the same as a missing session", () => {
    expect(
      adminApproveFailure(new ApiError("Dashboard authentication required", 403, "DASHBOARD_REQUIRED")).message,
    ).toContain("agent-deck open");
  });

  it("tells the user to re-request when the challenge expired, and hides retry", () => {
    const failure = adminApproveFailure(
      new ApiError("Approval challenge expired or was already consumed", 410, "ADMIN_CHALLENGE_EXPIRED"),
    );
    expect(failure.message).toContain("request admin elevation again");
    expect(failure.retryable).toBe(false);
  });

  it("tells the user to reconnect when the agent session is gone", () => {
    const failure = adminApproveFailure(new ApiError("Runtime session absent", 401, "SESSION_INVALID"));
    expect(failure.retryable).toBe(false);
  });

  it("reports an unreachable backend", () => {
    expect(adminApproveFailure(new TypeError("Failed to fetch")).message).toContain("agent-deck status");
  });

  it("falls back to the server message for unknown errors", () => {
    expect(adminApproveFailure(new ApiError("boom", 500)).message).toBe("boom");
  });
});
