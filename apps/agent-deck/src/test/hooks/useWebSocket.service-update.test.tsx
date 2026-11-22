import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";

import CardWarningBadge from "../../components/card-warning-badge";
import { useWebSocket } from "../../hooks/use-websocket";
import type { CollectionCardWarning } from "../../lib/collection-warnings";
import { createTestWrapper } from "../setup";

const GOOGLE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const EXPIRED_WARNING: CollectionCardWarning = {
  kind: "oauth_expired",
  message: "OAuth token expired — re-authenticate",
  severity: "error",
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function Harness({ serviceId }: { serviceId: string }) {
  useWebSocket();
  // Card face badge …
  const warningsQuery = useQuery({
    queryKey: ["/api/collection/warnings"],
    queryFn: async () => {
      const response = await fetch("/api/collection/warnings");
      return (await response.json()) as {
        success: boolean;
        data: { services: Record<string, CollectionCardWarning[]> };
      };
    },
  });
  // … and the same status query the details modal reads.
  useQuery({
    queryKey: ["/api/oauth", serviceId, "status"],
    queryFn: async () => {
      const response = await fetch(`/api/oauth/${serviceId}/status`);
      return (await response.json()) as { success: boolean; data: unknown };
    },
  });
  const warnings = warningsQuery.data?.data.services[serviceId];
  return <CardWarningBadge warnings={warnings} />;
}

describe("websocket service update clears OAuth warnings (NOT-655)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.WebSocket = vi.fn().mockImplementation(function () {
      return {
        send: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        readyState: 1,
        CONNECTING: 0,
        OPEN: 1,
        CLOSING: 2,
        CLOSED: 3,
      };
    }) as unknown as typeof WebSocket;
  });

  it("a healthy service update after the OAuth callback clears the face badge without a reload", async () => {
    let callbackDone = false;
    const seen: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      seen.push(url);
      if (url === "/api/collection/warnings") {
        return jsonResponse({
          success: true,
          data: {
            services: callbackDone ? {} : { [GOOGLE_ID]: [EXPIRED_WARNING] },
          },
        });
      }
      if (url === `/api/oauth/${GOOGLE_ID}/status`) {
        return jsonResponse({
          success: true,
          data: callbackDone
            ? { authenticated: true, authState: "ok" }
            : { authenticated: false, authState: "needs_reconnect" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<Harness serviceId={GOOGLE_ID} />, {
      wrapper: createTestWrapper(),
    });

    // Face badge starts out warning …
    expect(await screen.findByTestId("card-warning-badge")).not.toBeNull();
    const warningsFetchesBefore = seen.filter(
      (url) => url === "/api/collection/warnings",
    ).length;
    const statusFetchesBefore = seen.filter((url) =>
      url.includes(`/api/oauth/${GOOGLE_ID}/status`),
    ).length;

    // … the OAuth callback succeeds, the backend broadcasts the update …
    callbackDone = true;
    const ws = (global.WebSocket as unknown as { mock: { results: Array<{ value: { onmessage: ((event: { data: string }) => void) | null } }> } })
      .mock.results[0].value;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "service_update",
          data: {
            serviceId: GOOGLE_ID,
            health: "healthy",
            isConnected: true,
            lastPing: new Date().toISOString(),
          },
        }),
      });
    });

    // … and both the face badge and the details status refetch and clear.
    await waitFor(() => {
      expect(screen.queryByTestId("card-warning-badge")).toBeNull();
    });
    await waitFor(() => {
      expect(
        seen.filter((url) => url === "/api/collection/warnings").length,
      ).toBeGreaterThan(warningsFetchesBefore);
      expect(
        seen.filter((url) => url.includes(`/api/oauth/${GOOGLE_ID}/status`))
          .length,
      ).toBeGreaterThan(statusFetchesBefore);
    });
  });
});
