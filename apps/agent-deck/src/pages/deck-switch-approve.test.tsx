import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError, apiRequest } from "@/lib/queryClient";
import DeckSwitchApprovePage from "@/pages/deck-switch-approve";

vi.mock("@/lib/queryClient", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/queryClient")>();
  return { ...mod, apiRequest: vi.fn() };
});

const apiRequestMock = vi.mocked(apiRequest);

const DETAIL = {
  requestId: "req_1",
  status: "pending",
  createdAt: "2026-09-21T00:00:00.000Z",
  expiresAt: "2026-09-21T00:15:00.000Z",
  resolvedAt: null,
  runtimeSessionId: "sess_1",
  currentDeckId: "deck-a",
  currentDeckName: "Alpha",
  requestedDeckId: "deck-b",
  requestedDeckName: "Beta",
  workspaceRoot: "/work/ws",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockPendingDetail(detail: unknown = DETAIL): void {
  apiRequestMock.mockImplementation(async (method: string) => {
    if (method === "GET") {
      return jsonResponse({ success: true, data: detail });
    }
    throw new Error(`unexpected ${method} call`);
  });
}

function goTo(url: string): void {
  window.history.replaceState({}, "", url);
}

beforeEach(() => {
  apiRequestMock.mockReset();
  goTo("/deck-switch/approve?request=req_1&session=sess_1");
});

describe("DeckSwitchApprovePage", () => {
  it("shows current/requested decks, workspace context, and all three actions", async () => {
    mockPendingDetail();
    render(<DeckSwitchApprovePage />);

    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("/work/ws")).toBeInTheDocument();
    expect(screen.getByText("sess_1")).toBeInTheDocument();

    // Both approval scopes plus decline are visible without hidden menus.
    expect(screen.getByRole("button", { name: "This session only" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "This workspace by default" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
  });

  it("says the workspace default was not changed after session-only approval", async () => {
    mockPendingDetail();
    apiRequestMock.mockImplementation(async (method: string, url: string) => {
      if (method === "GET") {
        return jsonResponse({ success: true, data: DETAIL });
      }
      expect(url).toBe("/api/trusted-session/deck-switch/req_1/resolve");
      return jsonResponse({
        success: true,
        data: { requestId: "req_1", decision: "session", status: "consumed", deckId: "deck-b", deckName: "Beta" },
      });
    });
    render(<DeckSwitchApprovePage />);
    fireEvent.click(await screen.findByRole("button", { name: "This session only" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("workspace default was not changed");
    expect(apiRequestMock).toHaveBeenCalledWith(
      "POST",
      "/api/trusted-session/deck-switch/req_1/resolve",
      { runtimeSessionId: "sess_1", decision: "session" },
    );
  });

  it("says future sessions use the new default after workspace-default approval", async () => {
    mockPendingDetail();
    apiRequestMock.mockImplementation(async (method: string) => {
      if (method === "GET") {
        return jsonResponse({ success: true, data: DETAIL });
      }
      return jsonResponse({
        success: true,
        data: {
          requestId: "req_1",
          decision: "workspace-default",
          status: "consumed",
          deckId: "deck-b",
          deckName: "Beta",
          workspaceRoot: "/work/ws",
        },
      });
    });
    render(<DeckSwitchApprovePage />);
    fireEvent.click(await screen.findByRole("button", { name: "This workspace by default" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/future sessions.*new default/i);
  });

  it("never claims success for an expired request and offers no approval buttons", async () => {
    mockPendingDetail({ ...DETAIL, status: "expired" });
    render(<DeckSwitchApprovePage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/expired/i);
    expect(document.body.textContent).not.toMatch(/approved/i);
    expect(screen.queryByRole("button", { name: "This session only" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "This workspace by default" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decline" })).not.toBeInTheDocument();
    expect(screen.getByText(/close this tab/i)).toBeInTheDocument();
  });

  it("maps a consumed resolve failure to a terminal state without retry", async () => {
    mockPendingDetail();
    apiRequestMock.mockImplementation(async (method: string) => {
      if (method === "GET") {
        return jsonResponse({ success: true, data: DETAIL });
      }
      throw new ApiError("already resolved", 409, "DECK_SWITCH_CONSUMED");
    });
    render(<DeckSwitchApprovePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("already resolved");
    expect(document.body.textContent).not.toMatch(/approved for this session/i);
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByText(/close this tab/i)).toBeInTheDocument();
  });

  it("sends only one resolution request on rapid double clicks", async () => {
    let releasePost!: (value: Response) => void;
    const postGate = new Promise<Response>((resolvePromise) => {
      releasePost = resolvePromise;
    });
    apiRequestMock.mockImplementation(async (method: string) => {
      if (method === "GET") {
        return jsonResponse({ success: true, data: DETAIL });
      }
      return postGate;
    });
    render(<DeckSwitchApprovePage />);
    const sessionButton = await screen.findByRole("button", { name: "This session only" });
    const defaultButton = screen.getByRole("button", { name: "This workspace by default" });
    const declineButton = screen.getByRole("button", { name: "Decline" });

    // Two clicks before the first submission settles must collapse to one request.
    fireEvent.click(sessionButton);
    fireEvent.click(sessionButton);
    await waitFor(() => {
      expect(apiRequestMock.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
    });
    expect(sessionButton).toBeDisabled();
    expect(defaultButton).toBeDisabled();
    expect(declineButton).toBeDisabled();

    releasePost(
      jsonResponse({
        success: true,
        data: { requestId: "req_1", decision: "session", status: "consumed", deckName: "Beta" },
      }),
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      "workspace default was not changed",
    );
    expect(apiRequestMock.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
  });

  it("reports an incomplete link without approval buttons", async () => {
    goTo("/deck-switch/approve");
    render(<DeckSwitchApprovePage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("incomplete");
    expect(apiRequestMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "This session only" })).not.toBeInTheDocument();
  });
});
