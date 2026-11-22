import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { Service } from "@agent-deck/shared";

import ServiceDetailsModal from "@/components/service-details-modal";
import { OAUTH_EXPIRED_MESSAGE } from "@/lib/collection-warnings";
import { createTestWrapper } from "@/test/setup";

const GOOGLE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const googleService: Service = {
  id: GOOGLE_ID,
  name: "Gmail",
  type: "mcp",
  url: "https://gmailmcp.googleapis.com/mcp",
  health: "healthy",
  cardColor: "#92E4DD",
  disabledToolNames: [],
  isConnected: true,
  registeredAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  oauthClientId: "google-client",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

type MockServer = {
  /** "reject" makes POST /api/mcp/discover throw. */
  discover: "reject" | { required: boolean };
  status: Record<string, unknown>;
  seen: string[];
};

function mockOAuthEndpoints(server: MockServer) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    server.seen.push(`${method} ${url}`);
    if (url === "/api/mcp/discover" && method === "POST") {
      if (server.discover === "reject") {
        throw new Error("probe failed");
      }
      return jsonResponse({
        success: true,
        data: { oauth: { required: server.discover.required } },
      });
    }
    if (url === `/api/oauth/${GOOGLE_ID}/status`) {
      return jsonResponse({ success: true, data: server.status });
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
}

const NEEDS_RECONNECT_STATUS = {
  hasToken: true,
  isExpired: true,
  authenticated: false,
  hasRefreshToken: false,
  refreshFailed: false,
  expiresAt: "2020-01-01T00:00:00.000Z",
  authState: "needs_reconnect",
  reason: "no_refresh_token",
};

describe("ServiceDetailsModal OAuth authState (NOT-655)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the needs_reconnect warning even when the discovery probe rejects", async () => {
    const server: MockServer = {
      discover: "reject",
      status: NEEDS_RECONNECT_STATUS,
      seen: [],
    };
    mockOAuthEndpoints(server);

    render(
      <ServiceDetailsModal service={googleService} isOpen onClose={() => {}} />,
      { wrapper: createTestWrapper() },
    );

    // Same state and message as the card face badge.
    const warning = await screen.findByText(OAUTH_EXPIRED_MESSAGE);
    expect(warning).not.toBeNull();
    // The OAuth status was read without waiting on the failed probe.
    expect(
      server.seen.some((entry) =>
        entry.includes(`/api/oauth/${GOOGLE_ID}/status`),
      ),
    ).toBe(true);
  });

  it("shows the needs_reconnect warning when the probe reports oauth.required:false", async () => {
    const server: MockServer = {
      discover: { required: false },
      status: NEEDS_RECONNECT_STATUS,
      seen: [],
    };
    mockOAuthEndpoints(server);

    render(
      <ServiceDetailsModal service={googleService} isOpen onClose={() => {}} />,
      { wrapper: createTestWrapper() },
    );

    const warning = await screen.findByText(OAUTH_EXPIRED_MESSAGE);
    expect(warning).not.toBeNull();
    expect(screen.getByTestId("oauth-connect-section")).not.toBeNull();
  });

  it("never shows a healthy pill for a needs_reconnect card", async () => {
    const server: MockServer = {
      discover: { required: false },
      status: NEEDS_RECONNECT_STATUS,
      seen: [],
    };
    mockOAuthEndpoints(server);

    render(
      <ServiceDetailsModal service={googleService} isOpen onClose={() => {}} />,
      { wrapper: createTestWrapper() },
    );

    await screen.findByText(OAUTH_EXPIRED_MESSAGE);
    expect(screen.getByText("Auth required")).not.toBeNull();
    expect(screen.queryByText("Healthy")).toBeNull();
  });

  it("shows no warning for an expired-but-refreshable token with authState ok", async () => {
    const server: MockServer = {
      discover: { required: true },
      status: {
        hasToken: true,
        isExpired: true,
        authenticated: false,
        hasRefreshToken: true,
        refreshFailed: false,
        expiresAt: "2020-01-01T00:00:00.000Z",
        authState: "ok",
      },
      seen: [],
    };
    mockOAuthEndpoints(server);

    render(
      <ServiceDetailsModal service={googleService} isOpen onClose={() => {}} />,
      { wrapper: createTestWrapper() },
    );

    // Wait until the status read settled (tools load only when auth is usable).
    await waitFor(() => {
      expect(
        server.seen.some((entry) =>
          entry.includes(`/api/services/${GOOGLE_ID}/tools`),
        ),
      ).toBe(true);
    });
    expect(screen.queryByText(OAUTH_EXPIRED_MESSAGE)).toBeNull();
    expect(screen.queryByText("Authentication Required")).toBeNull();
    expect(screen.queryByText("Token Expired")).toBeNull();
  });

  it("focuses the connect panel when focusConnect is set", async () => {
    const server: MockServer = {
      discover: { required: false },
      status: NEEDS_RECONNECT_STATUS,
      seen: [],
    };
    mockOAuthEndpoints(server);

    render(
      <ServiceDetailsModal
        service={googleService}
        isOpen
        focusConnect
        onClose={() => {}}
      />,
      { wrapper: createTestWrapper() },
    );

    await screen.findByText(OAUTH_EXPIRED_MESSAGE);
    await waitFor(() => {
      expect(
        document.activeElement?.getAttribute("data-testid"),
      ).toBe("oauth-connect-section");
    });
  });
});
