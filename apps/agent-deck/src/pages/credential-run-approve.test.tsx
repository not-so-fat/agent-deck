import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError, apiRequest } from "@/lib/queryClient";
import CredentialRunApprovePage from "@/pages/credential-run-approve";

vi.mock("@/lib/queryClient", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/queryClient")>();
  return { ...mod, apiRequest: vi.fn() };
});

const apiRequestMock = vi.mocked(apiRequest);

const DETAIL = {
  requestId: "crn_1",
  status: "pending",
  createdAt: "2026-09-21T00:00:00.000Z",
  expiresAt: "2026-09-21T00:10:00.000Z",
  resolvedAt: null,
  runtimeSessionId: "sess_1",
  deckId: "deck-a",
  deckName: "Alpha",
  argv: ["hf", "jobs", "run", "--secrets", "HF_TOKEN"],
  credentialIds: ["cred_huggingface"],
  env: { HF_TOKEN: "cred_huggingface" },
  cwd: "/work/ws",
  timeoutSec: 300,
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
  goTo("/credential-run/approve?request=crn_1&session=sess_1");
});

describe("CredentialRunApprovePage", () => {
  it("shows the exact binding under approval and both actions", async () => {
    mockPendingDetail();
    render(<CredentialRunApprovePage />);

    expect(await screen.findByText("hf jobs run --secrets HF_TOKEN")).toBeInTheDocument();
    expect(screen.getByText("cred_huggingface")).toBeInTheDocument();
    expect(screen.getByText('{"HF_TOKEN":"cred_huggingface"}')).toBeInTheDocument();
    expect(screen.getByText("/work/ws")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("sess_1")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Approve and run" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
  });

  it("approves with the session-bound decision body", async () => {
    mockPendingDetail();
    apiRequestMock.mockImplementation(async (method: string, url: string) => {
      if (method === "GET") {
        return jsonResponse({ success: true, data: DETAIL });
      }
      expect(url).toBe("/api/trusted-session/credential-run/crn_1/resolve");
      return jsonResponse({
        success: true,
        data: { requestId: "crn_1", decision: "approve", status: "approved" },
      });
    });
    render(<CredentialRunApprovePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve and run" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("secret values stay daemon-side");
    expect(apiRequestMock).toHaveBeenCalledWith(
      "POST",
      "/api/trusted-session/credential-run/crn_1/resolve",
      { runtimeSessionId: "sess_1", decision: "approve" },
    );
  });

  it("declines without executing", async () => {
    mockPendingDetail();
    apiRequestMock.mockImplementation(async (method: string) => {
      if (method === "GET") {
        return jsonResponse({ success: true, data: DETAIL });
      }
      return jsonResponse({
        success: true,
        data: { requestId: "crn_1", decision: "decline", status: "declined" },
      });
    });
    render(<CredentialRunApprovePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("no secrets were resolved");
    expect(apiRequestMock).toHaveBeenCalledWith(
      "POST",
      "/api/trusted-session/credential-run/crn_1/resolve",
      { runtimeSessionId: "sess_1", decision: "decline" },
    );
  });

  it("never claims success for an expired request and offers no approval buttons", async () => {
    mockPendingDetail({ ...DETAIL, status: "expired" });
    render(<CredentialRunApprovePage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/expired/i);
    expect(document.body.textContent).not.toMatch(/approved/i);
    expect(screen.queryByRole("button", { name: "Approve and run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decline" })).not.toBeInTheDocument();
    expect(screen.getByText(/close this tab/i)).toBeInTheDocument();
  });

  it("maps a consumed resolve failure to a terminal state without retry", async () => {
    mockPendingDetail();
    apiRequestMock.mockImplementation(async (method: string) => {
      if (method === "GET") {
        return jsonResponse({ success: true, data: DETAIL });
      }
      throw new ApiError("already resolved", 409, "CREDENTIAL_RUN_CONSUMED");
    });
    render(<CredentialRunApprovePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("already resolved");
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
    render(<CredentialRunApprovePage />);
    const approveButton = await screen.findByRole("button", { name: "Approve and run" });
    const declineButton = screen.getByRole("button", { name: "Decline" });

    // Two clicks before the first submission settles must collapse to one request.
    fireEvent.click(approveButton);
    fireEvent.click(approveButton);
    await waitFor(() => {
      expect(apiRequestMock.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
    });
    expect(approveButton).toBeDisabled();
    expect(declineButton).toBeDisabled();

    releasePost(
      jsonResponse({
        success: true,
        data: { requestId: "crn_1", decision: "approve", status: "approved" },
      }),
    );
    expect((await screen.findByRole("status")).textContent).toContain("secret values stay daemon-side");
    expect(apiRequestMock.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
  });

  it("reports an incomplete link without approval buttons", async () => {
    goTo("/credential-run/approve");
    render(<CredentialRunApprovePage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("incomplete");
    expect(apiRequestMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Approve and run" })).not.toBeInTheDocument();
  });
});
