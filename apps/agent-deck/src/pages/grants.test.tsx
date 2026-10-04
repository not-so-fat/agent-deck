import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import GrantsPage from "@/pages/grants";
import { getQueryFn } from "@/lib/queryClient";

const DECKS = [
  { id: "deck-a", name: "Alpha", isActive: true, services: [], createdAt: "", updatedAt: "" },
  { id: "deck-b", name: "Beta", isActive: false, services: [], createdAt: "", updatedAt: "" },
];

const ACTIVE_GRANT = {
  id: "ag_11111111-1111-4111-8111-111111111111",
  label: "Worker",
  defaultDeck: "deck-a",
  allowedDecks: ["deck-a", "deck-b"],
  installationId: "owner",
  createdAt: "2026-10-01T12:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
};

const ONE_TIME_TOKEN = `${ACTIVE_GRANT.id.replace(/^ag_/, "adg_ag_")}_secret-shown-once`;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { queryFn: getQueryFn({ on401: "throw" }), retry: false },
      mutations: { retry: false },
    },
  });
  const { hook } = memoryLocation({ path: "/grants" });
  return render(
    <Router hook={hook}>
      <QueryClientProvider client={client}>
        <GrantsPage />
      </QueryClientProvider>
    </Router>,
  );
}

describe("GrantsPage", () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset();
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("shows a created bearer once, then a reload renders only secret-free list data", async () => {
    let created = false;
    let createPayload: Record<string, unknown> | undefined;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/dashboard-auth/context") {
        return jsonResponse({ success: true, data: { hosted: true } });
      }
      if (url === "/api/decks") {
        return jsonResponse({ success: true, data: DECKS });
      }
      if (url === "/api/agent-grants" && method === "GET") {
        return jsonResponse({ success: true, data: created ? [ACTIVE_GRANT] : [] });
      }
      if (url === "/api/agent-grants" && method === "POST") {
        createPayload = JSON.parse(String(init?.body));
        created = true;
        return jsonResponse({
          success: true,
          data: { grant: ACTIVE_GRANT, token: ONE_TIME_TOKEN },
        }, 201);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    const first = renderPage();
    fireEvent.change(await screen.findByLabelText("Agent label"), {
      target: { value: "Worker" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create grant" }));

    expect(await screen.findByDisplayValue(ONE_TIME_TOKEN)).toBeInTheDocument();
    expect(screen.getByText("This secret will not be shown again.")).toBeInTheDocument();
    expect(createPayload).toMatchObject({
      label: "Worker",
      defaultDeck: "deck-a",
      allowedDecks: ["deck-a", "deck-b"],
    });

    first.unmount();
    renderPage();
    expect(await screen.findByText("Worker")).toBeInTheDocument();
    expect(screen.queryByDisplayValue(ONE_TIME_TOKEN)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("secret-shown-once");
    expect(document.body.textContent).not.toContain("verifier");
  });

  it("requires confirmation, calls revoke, and immediately shows the row as revoked", async () => {
    let revoked = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/dashboard-auth/context") {
        return jsonResponse({ success: true, data: { hosted: true } });
      }
      if (url === "/api/decks") {
        return jsonResponse({ success: true, data: DECKS });
      }
      if (url === "/api/agent-grants" && method === "GET") {
        return jsonResponse({
          success: true,
          data: [{ ...ACTIVE_GRANT, revokedAt: revoked ? "2026-10-04T12:00:00.000Z" : null }],
        });
      }
      if (url.endsWith(`/api/agent-grants/${ACTIVE_GRANT.id}/revoke`) && method === "POST") {
        revoked = true;
        return jsonResponse({ success: true, data: { revoked: true, sessionsRevoked: 1 } });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    renderPage();
    expect(await screen.findByText("Worker")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    expect(screen.getByText("Revoke Worker now? This is immediate.")).toBeInTheDocument();
    expect(
      vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST"),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => {
      expect(
        vi.mocked(fetch).mock.calls.some(([input, init]) =>
          String(input).endsWith(`/${ACTIVE_GRANT.id}/revoke`) && init?.method === "POST",
        ),
      ).toBe(true);
    });
    expect(await screen.findByText("revoked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("does not load grant data outside hosted mode", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      expect(String(input)).toBe("/api/dashboard-auth/context");
      return jsonResponse({ success: true, data: { hosted: false } });
    });

    renderPage();
    expect(await screen.findByText("Remote agent grants are available in hosted mode only.")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

