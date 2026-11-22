import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Service } from "@agent-deck/shared";

import CardComponent from "@/components/card-component";
import type { CollectionCardWarning } from "@/lib/collection-warnings";
import { OAUTH_EXPIRED_MESSAGE } from "@/lib/collection-warnings";
import {
  createServiceCardClickHandler,
  hasNeedsReconnectWarning,
  isGoogleMcpServiceUrl,
} from "@/lib/google-card-reconnect";
import { createTestWrapper } from "@/test/setup";

const GOOGLE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LINEAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x";

function makeService(overrides: Partial<Service> & { id: string }): Service {
  return {
    name: "Card",
    type: "mcp",
    url: "https://example.com/mcp",
    health: "unknown",
    cardColor: "#92E4DD",
    disabledToolNames: [],
    isConnected: false,
    registeredAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

const googleService = makeService({
  id: GOOGLE_ID,
  name: "Gmail",
  url: "https://gmailmcp.googleapis.com/mcp",
  health: "unhealthy",
  oauthClientId: "google-client",
});

const linearService = makeService({
  id: LINEAR_ID,
  name: "Linear",
  url: "https://mcp.linear.app/mcp",
});

const expiredWarning: CollectionCardWarning = {
  kind: "oauth_expired",
  message: OAUTH_EXPIRED_MESSAGE,
  severity: "error",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makePopup() {
  return {
    location: { href: "about:blank" },
    close: vi.fn(),
    closed: false,
  };
}

describe("isGoogleMcpServiceUrl / hasNeedsReconnectWarning", () => {
  it("detects Google MCP hosts", () => {
    expect(isGoogleMcpServiceUrl("https://gmailmcp.googleapis.com/mcp")).toBe(true);
    expect(isGoogleMcpServiceUrl("https://mcp.linear.app/mcp")).toBe(false);
    expect(isGoogleMcpServiceUrl("not a url")).toBe(false);
    expect(isGoogleMcpServiceUrl(null)).toBe(false);
  });

  it("reads needs_reconnect from the face warning", () => {
    expect(hasNeedsReconnectWarning([expiredWarning])).toBe(true);
    expect(
      hasNeedsReconnectWarning([
        { kind: "oauth_required", message: "x", severity: "error" },
      ]),
    ).toBe(false);
    expect(hasNeedsReconnectWarning(undefined)).toBe(false);
  });
});

describe("service card click (NOT-655)", () => {
  const openServiceDetails = vi.fn();
  const toast = vi.fn();
  const noop = () => {};

  function renderCard(
    service: Service,
    warnings: CollectionCardWarning[] | undefined,
  ) {
    const handleCardClick = createServiceCardClickHandler({
      getServiceWarnings: (serviceId) =>
        serviceId === service.id ? warnings : undefined,
      openServiceDetails,
      toast,
    });
    return render(
      <CardComponent
        service={service}
        onDragStart={noop}
        onDragEnd={noop}
        isInActiveDeck={false}
        onCardClick={handleCardClick}
        isInCollection
        warnings={warnings}
      />,
      { wrapper: createTestWrapper() },
    );
  }

  function connectPosts(): string[] {
    return vi
      .mocked(fetch)
      .mock.calls.map((call) => String(call[0]))
      .filter((url) => url.includes("/api/oauth/") && url.endsWith("/connect"));
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("one click on a needs_reconnect Google card POSTs connect and navigates the popup", async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (
        String(input) === `/api/oauth/${GOOGLE_ID}/connect` &&
        init?.method === "POST"
      ) {
        return jsonResponse({
          success: true,
          data: { authorizationUrl: AUTH_URL, state: "s", mode: "manual" },
        });
      }
      throw new Error(`Unexpected request: ${init?.method} ${String(input)}`);
    });
    const popup = makePopup();
    const windowOpen = vi
      .spyOn(window, "open")
      .mockReturnValue(popup as unknown as Window);

    renderCard(googleService, [expiredWarning]);
    fireEvent.click(screen.getByTestId(`card-${GOOGLE_ID}`));

    // The popup opens synchronously in the click handler (popup blockers).
    expect(windowOpen).toHaveBeenCalledTimes(1);
    expect(windowOpen).toHaveBeenCalledWith("about:blank", "_blank");

    await waitFor(() => {
      expect(connectPosts()).toHaveLength(1);
    });
    expect(popup.location.href).toBe(AUTH_URL);
    expect(popup.close).not.toHaveBeenCalled();
    expect(openServiceDetails).not.toHaveBeenCalled();
  });

  it("opens the details modal (focused) when the Google card has no saved client", () => {
    const windowOpen = vi.spyOn(window, "open");
    const noClient = makeService({
      id: GOOGLE_ID,
      name: "Gmail",
      url: "https://gmailmcp.googleapis.com/mcp",
    });

    renderCard(noClient, [expiredWarning]);
    fireEvent.click(screen.getByTestId(`card-${GOOGLE_ID}`));

    expect(openServiceDetails).toHaveBeenCalledTimes(1);
    expect(openServiceDetails).toHaveBeenCalledWith(noClient, true);
    expect(windowOpen).not.toHaveBeenCalled();
    expect(connectPosts()).toHaveLength(0);
  });

  it("opens the details modal (focused) when the server reports missing credentials", async () => {
    vi.mocked(fetch).mockImplementation(async () => {
      return jsonResponse(
        {
          success: false,
          error: "OAuth client secret is missing",
          data: { needsCredentials: true, setupMode: "manual" },
        },
        400,
      );
    });
    const popup = makePopup();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);

    renderCard(googleService, [expiredWarning]);
    fireEvent.click(screen.getByTestId(`card-${GOOGLE_ID}`));

    await waitFor(() => {
      expect(openServiceDetails).toHaveBeenCalledTimes(1);
    });
    expect(openServiceDetails).toHaveBeenCalledWith(googleService, true);
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });

  it("opens the details modal for a non-Google card and leaves its badges alone", () => {
    const windowOpen = vi.spyOn(window, "open");
    const linearWarning: CollectionCardWarning = {
      kind: "oauth_required",
      message: "OAuth authentication required",
      severity: "error",
    };

    renderCard(linearService, [linearWarning]);
    expect(screen.getByTestId("card-warning-badge")).not.toBeNull();
    fireEvent.click(screen.getByTestId(`card-${LINEAR_ID}`));

    expect(openServiceDetails).toHaveBeenCalledTimes(1);
    expect(openServiceDetails).toHaveBeenCalledWith(linearService, false);
    expect(windowOpen).not.toHaveBeenCalled();
    expect(connectPosts()).toHaveLength(0);
  });

  it("opens the details modal for a Google card that is not in needs_reconnect", () => {
    const windowOpen = vi.spyOn(window, "open");

    renderCard(googleService, undefined);
    fireEvent.click(screen.getByTestId(`card-${GOOGLE_ID}`));

    expect(openServiceDetails).toHaveBeenCalledTimes(1);
    expect(openServiceDetails).toHaveBeenCalledWith(googleService, false);
    expect(windowOpen).not.toHaveBeenCalled();
    expect(connectPosts()).toHaveLength(0);
  });
});
