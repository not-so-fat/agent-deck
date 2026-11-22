import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  invalidateDashboardServiceQueries,
  isOAuthCompleteMessage,
  OAUTH_COMPLETE_MESSAGE,
} from "./invalidate-dashboard-queries";

describe("invalidateDashboardServiceQueries", () => {
  it("invalidates services list and collection warnings", () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    invalidateDashboardServiceQueries(queryClient);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/services"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/collection/warnings"] });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("also invalidates a specific service when serviceId is provided", () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    invalidateDashboardServiceQueries(queryClient, "svc-1");

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/services", "svc-1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/services", "svc-1", "tools"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/oauth", "svc-1", "status"] });
    expect(invalidate).toHaveBeenCalledTimes(5);
  });
});

describe("isOAuthCompleteMessage", () => {
  it("accepts oauth complete messages", () => {
    expect(
      isOAuthCompleteMessage({ type: OAUTH_COMPLETE_MESSAGE, serviceId: "abc" }),
    ).toBe(true);
  });

  it("rejects other message shapes", () => {
    expect(isOAuthCompleteMessage({ type: "other" })).toBe(false);
    expect(isOAuthCompleteMessage(null)).toBe(false);
  });
});
