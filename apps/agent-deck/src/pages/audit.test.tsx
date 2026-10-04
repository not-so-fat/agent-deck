import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getQueryFn } from "@/lib/queryClient";
import AuditPage from "@/pages/audit";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { queryFn: getQueryFn({ on401: "throw" }), retry: false } },
  });
  const { hook } = memoryLocation({ path: "/audit" });
  return render(
    <Router hook={hook}>
      <QueryClientProvider client={client}><AuditPage /></QueryClientProvider>
    </Router>,
  );
}

describe("AuditPage", () => {
  beforeEach(() => vi.mocked(fetch).mockReset());

  it("renders desktop columns and a non-clipping mobile card view", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      // jsdom/React may issue an empty resource probe while mounting links.
      if (input === undefined) return jsonResponse({});
      if (String(input) === "/api/dashboard-auth/context") {
        return jsonResponse({ success: true, data: { hosted: true } });
      }
      if (String(input) === "/api/audit?limit=50") {
        return jsonResponse({
          success: true,
          data: [{
            id: "aud_1",
            timestamp: "2026-10-04T12:00:00.000Z",
            installationId: "owner",
            actor: "ag_11111111-1111-4111-8111-111111111111",
            event: "grant.created",
            targetId: "ag_22222222-2222-4222-8222-222222222222",
            outcome: "succeeded",
            reasonCode: null,
          }],
          paging: { limit: 50, nextBefore: null },
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    renderPage();
    expect(await screen.findAllByText("grant.created")).toHaveLength(2);
    expect(screen.getByRole("table")).toBeInTheDocument();
    const mobile = screen.getByRole("list", { name: "Audit events" });
    expect(mobile).toHaveClass("md:hidden");
    expect(mobile.querySelector(".break-all")).not.toBeNull();
    expect(document.body.textContent).not.toContain("Authorization");
  });
});
