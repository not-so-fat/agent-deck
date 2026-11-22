import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { Service } from "@agent-deck/shared";

import ServiceDetailsModal from "@/components/service-details-modal";
import { OAUTH_EXPIRED_MESSAGE } from "@/lib/collection-warnings";
import { createTestWrapper } from "@/test/setup";

const GOOGLE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINEAR_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

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

const linearService: Service = {
  id: LINEAR_ID,
  name: "Linear",
  type: "mcp",
  url: "https://mcp.linear.app/mcp",
  health: "healthy",
  cardColor: "#92E4DD",
  disabledToolNames: [],
  isConnected: false,
  registeredAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  oauthClientId: "linear-client",
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

const DYNAMIC_SETUP = {
  success: true,
  data: {
    guide: {
      provider: "Linear",
      setupMode: "dynamic",
      title: "Linear setup",
      redirectUri: "http://127.0.0.1:8000/api/oauth/callback",
      steps: ["Click Connect to authorize with Linear."],
    },
    hasSavedCredentials: false,
  },
};

type MockServer = {
  /** "reject" makes POST /api/mcp/discover throw. */
  discover: "reject" | { required: boolean };
  status: Record<string, unknown>;
  seen: string[];
  service: Service;
  setup: unknown;
  /** HTTP status for GET /api/oauth/:id/status (default 200). */
  statusCode?: number;
  /** Card-face collection warnings for GET /api/collection/warnings. */
  faceWarnings?: Record<string, Array<{ kind: string; message: string; severity: string }>>;
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
    if (url === `/api/oauth/${server.service.id}/status`) {
      if (server.statusCode && server.statusCode >= 400) {
        return jsonResponse({ success: false, error: "boom" }, server.statusCode);
      }
      return jsonResponse({ success: true, data: server.status });
    }
    if (url === "/api/collection/warnings") {
      return jsonResponse({
        success: true,
        data: {
          total: Object.keys(server.faceWarnings ?? {}).length,
          byKind: {},
          services: server.faceWarnings ?? {},
          credentials: {},
          playbooks: {},
        },
      });
    }
    if (url === `/api/oauth/${server.service.id}/setup`) {
      return jsonResponse(server.setup);
    }
    if (url === `/api/services/${server.service.id}/tools`) {
      return jsonResponse({ success: true, data: [] });
    }
    if (url === `/api/services/${server.service.id}`) {
      return jsonResponse({ success: true, data: server.service });
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
      service: googleService,
      setup: MANUAL_SETUP,
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
      service: googleService,
      setup: MANUAL_SETUP,
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

  it("mirrors the card face oauth_expired warning when the Google status read fails (HTTP 500)", async () => {
    const server: MockServer = {
      discover: { required: false },
      status: {},
      statusCode: 500,
      faceWarnings: {
        [GOOGLE_ID]: [
          { kind: "oauth_expired", message: OAUTH_EXPIRED_MESSAGE, severity: "error" },
        ],
      },
      seen: [],
      service: googleService,
      setup: MANUAL_SETUP,
    };
    mockOAuthEndpoints(server);

    render(
      <ServiceDetailsModal service={googleService} isOpen onClose={() => {}} />,
      { wrapper: createTestWrapper() },
    );

    const warning = await screen.findByText(OAUTH_EXPIRED_MESSAGE);
    expect(warning).not.toBeNull();
    expect(screen.queryByText("Healthy")).toBeNull();
    expect(
      server.seen.some((entry) => entry.includes(`/api/oauth/${GOOGLE_ID}/status`)),
    ).toBe(true);
  });

  it("does not read card face warnings for a non-Google card", async () => {
    const server: MockServer = {
      discover: { required: false },
      status: {},
      statusCode: 500,
      faceWarnings: {
        [LINEAR_ID]: [
          { kind: "oauth_expired", message: OAUTH_EXPIRED_MESSAGE, severity: "error" },
        ],
      },
      seen: [],
      service: linearService,
      setup: DYNAMIC_SETUP,
    };
    mockOAuthEndpoints(server);

    render(
      <ServiceDetailsModal service={linearService} isOpen onClose={() => {}} />,
      { wrapper: createTestWrapper() },
    );

    await waitFor(() => {
      expect(server.seen.some((entry) => entry.includes("/api/mcp/discover"))).toBe(true);
    });
    expect(server.seen.some((entry) => entry.includes("/api/collection/warnings"))).toBe(false);
    expect(screen.queryByText(OAUTH_EXPIRED_MESSAGE)).toBeNull();
  });

  it("never shows a healthy pill for a needs_reconnect card", async () => {
    const server: MockServer = {
      discover: { required: false },
      status: NEEDS_RECONNECT_STATUS,
      seen: [],
      service: googleService,
      setup: MANUAL_SETUP,
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
      service: googleService,
      setup: MANUAL_SETUP,
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
      service: googleService,
      setup: MANUAL_SETUP,
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

describe("ServiceDetailsModal non-Google cards (NOT-655 round 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps Authentication Required for a first-time Linear card even when authState is needs_reconnect", async () => {
    const server: MockServer = {
      discover: { required: true },
      status: {
        hasToken: false,
        isExpired: false,
        authenticated: false,
        hasRefreshToken: false,
        refreshFailed: false,
        authState: "needs_reconnect",
        reason: "no_token",
      },
      seen: [],
      service: linearService,
      setup: DYNAMIC_SETUP,
    };
    mockOAuthEndpoints(server);

    render(
      <ServiceDetailsModal service={linearService} isOpen onClose={() => {}} />,
      { wrapper: createTestWrapper() },
    );

    // The authState override is Google-only: a configured first-time
    // Linear card keeps the pre-NOT-655 Authentication Required state.
    await screen.findByText("🔐 Authentication Required");
    const section = screen.getByTestId("oauth-connect-section");
    expect(
      within(section).getByText("OAuth 2.0 Authentication Required"),
    ).not.toBeNull();
    expect(screen.queryByText("⏰ Token Expired")).toBeNull();
    expect(screen.queryByText(OAUTH_EXPIRED_MESSAGE)).toBeNull();
  });

  it("still shows Token Expired for a Linear card with an expired stored token", async () => {
    const server: MockServer = {
      discover: { required: true },
      status: {
        hasToken: true,
        isExpired: true,
        authenticated: false,
        hasRefreshToken: false,
        refreshFailed: false,
        authState: "needs_reconnect",
        reason: "no_refresh_token",
      },
      seen: [],
      service: linearService,
      setup: DYNAMIC_SETUP,
    };
    mockOAuthEndpoints(server);

    render(
      <ServiceDetailsModal service={linearService} isOpen onClose={() => {}} />,
      { wrapper: createTestWrapper() },
    );

    // Same visible outcome as before, reached via the probe-gated legacy
    // path (token present but expired), not the authState override.
    await screen.findByText("⏰ Token Expired");
    expect(await screen.findByText(OAUTH_EXPIRED_MESSAGE)).not.toBeNull();
  });

  it("shows no warning and skips the status read when the probe says not required", async () => {
    const server: MockServer = {
      discover: { required: false },
      status: {
        hasToken: false,
        isExpired: false,
        authenticated: false,
        hasRefreshToken: false,
        refreshFailed: false,
        authState: "needs_reconnect",
        reason: "no_token",
      },
      seen: [],
      service: linearService,
      setup: DYNAMIC_SETUP,
    };
    mockOAuthEndpoints(server);

    render(
      <ServiceDetailsModal service={linearService} isOpen onClose={() => {}} />,
      { wrapper: createTestWrapper() },
    );

    await screen.findByText("How to connect");
    // Wait until the probe resolved, then assert the status endpoint was
    // never consulted (pre-NOT-655 probe-gated read).
    await waitFor(() => {
      expect(
        server.seen.some((entry) => entry.includes("/api/mcp/discover")),
      ).toBe(true);
    });
    expect(
      server.seen.some((entry) =>
        entry.includes(`/api/oauth/${LINEAR_ID}/status`),
      ),
    ).toBe(false);
    expect(screen.queryByText("⏰ Token Expired")).toBeNull();
    expect(screen.queryByText("🔐 Authentication Required")).toBeNull();
    expect(screen.queryByText(OAUTH_EXPIRED_MESSAGE)).toBeNull();
  });
});
