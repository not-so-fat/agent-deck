import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import type { Service } from "@agent-deck/shared";

import CardWarningBadge from "../../components/card-warning-badge";
import ServiceDetailsModal from "../../components/service-details-modal";
import { useWebSocket } from "../../hooks/use-websocket";
import type { CollectionCardWarning } from "../../lib/collection-warnings";
import { OAUTH_EXPIRED_MESSAGE } from "../../lib/collection-warnings";
import { createTestWrapper } from "../setup";

const GOOGLE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const EXPIRED_WARNING: CollectionCardWarning = {
  kind: "oauth_expired",
  message: OAUTH_EXPIRED_MESSAGE,
  severity: "error",
};

const googleService: Service = {
  id: GOOGLE_ID,
  name: "Gmail",
  type: "mcp",
  url: "https://gmailmcp.googleapis.com/mcp",
  health: "unhealthy",
  cardColor: "#92E4DD",
  disabledToolNames: [],
  isConnected: false,
  registeredAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  oauthClientId: "google-client",
};

const MANUAL_SETUP = {
  success: true,
  data: {
    guide: {
      provider: "Google",
      setupMode: "manual",
      title: "Google setup",
      redirectUri: "http://127.0.0.1:8000/api/oauth/callback",
      steps: ["Create a GCP OAuth client."],
    },
    savedOAuthClientId: "google-client",
    hasStoredClientSecret: true,
    hasSavedCredentials: true,
  },
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function Harness() {
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
  const warnings = warningsQuery.data?.data.services[GOOGLE_ID];
  return (
    <>
      <CardWarningBadge warnings={warnings} />
      {/* … and the open details modal reading the same server auth state. */}
      <ServiceDetailsModal service={googleService} isOpen onClose={() => {}} />
    </>
  );
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

  it("a healthy service update after the OAuth callback clears the face badge and the details warning without a reload", async () => {
    let callbackDone = false;
    const seen: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      seen.push(`${method} ${url}`);
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
            ? {
                hasToken: true,
                isExpired: false,
                authenticated: true,
                hasRefreshToken: true,
                refreshFailed: false,
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                authState: "ok",
              }
            : {
                hasToken: true,
                isExpired: true,
                authenticated: false,
                hasRefreshToken: false,
                refreshFailed: false,
                expiresAt: "2020-01-01T00:00:00.000Z",
                authState: "needs_reconnect",
                reason: "no_refresh_token",
              },
        });
      }
      if (url === "/api/mcp/discover" && method === "POST") {
        return jsonResponse({
          success: true,
          data: { oauth: { required: false } },
        });
      }
      if (url === `/api/oauth/${GOOGLE_ID}/setup`) {
        return jsonResponse(MANUAL_SETUP);
      }
      if (url === `/api/services/${GOOGLE_ID}/tools`) {
        return jsonResponse({ success: true, data: [] });
      }
      if (url === `/api/services/${GOOGLE_ID}`) {
        return jsonResponse({ success: true, data: googleService });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    render(<Harness />, {
      wrapper: createTestWrapper(),
    });

    // Face badge and details warning start out agreeing (badge + modal).
    expect(await screen.findByTestId("card-warning-badge")).not.toBeNull();
    expect(await screen.findByTestId("oauth-connect-section")).not.toBeNull();
    expect(await screen.findAllByText(OAUTH_EXPIRED_MESSAGE)).not.toHaveLength(0);
    const warningsFetchesBefore = seen.filter((entry) =>
      entry.includes("/api/collection/warnings"),
    ).length;
    const statusFetchesBefore = seen.filter((entry) =>
      entry.includes(`/api/oauth/${GOOGLE_ID}/status`),
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

    // … and both the face badge and the details warning refetch and clear.
    await waitFor(() => {
      expect(screen.queryByTestId("card-warning-badge")).toBeNull();
    });
    await waitFor(() => {
      expect(screen.queryAllByText(OAUTH_EXPIRED_MESSAGE)).toHaveLength(0);
    });
    await waitFor(() => {
      expect(
        seen.filter((entry) => entry.includes("/api/collection/warnings"))
          .length,
      ).toBeGreaterThan(warningsFetchesBefore);
      expect(
        seen.filter((entry) =>
          entry.includes(`/api/oauth/${GOOGLE_ID}/status`),
        ).length,
      ).toBeGreaterThan(statusFetchesBefore);
    });
  });
});
