import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { deckSwitchApproveFailure } from "@/lib/deck-switch-approve-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export type DeckSwitchDecision = "session" | "workspace-default" | "decline";

type SwitchRequestDetail = {
  requestId: string;
  status: string;
  createdAt?: string;
  expiresAt?: string;
  resolvedAt?: string | null;
  runtimeSessionId?: string;
  currentDeckId?: string;
  currentDeckName?: string;
  requestedDeckId?: string;
  requestedDeckName?: string;
  workspaceRoot?: string;
};

type Resolution = {
  decision: DeckSwitchDecision;
  deckName?: string;
  workspaceRoot?: string;
};

type PageState = "loading" | "pending" | "submitting" | "success" | "error";

function readApprovalContext(): { requestId: string; runtimeSessionId: string } {
  const params = new URLSearchParams(window.location.search);
  const requestId = (params.get("request") ?? params.get("requestId") ?? "").trim();
  const runtimeSessionId = (
    params.get("session") ??
    params.get("runtimeSessionId") ??
    ""
  ).trim();
  return { requestId, runtimeSessionId };
}

function terminalStatusCopy(status: string): string {
  if (status === "expired") {
    return "This deck-switch request expired. The session and workspace default were not changed. Ask the agent to request the switch again.";
  }
  if (status === "declined") {
    return "This deck-switch request was already declined. Nothing was changed.";
  }
  return "This deck-switch request was already resolved. The switch was not applied twice — check the current deck before requesting again.";
}

function successCopy(resolution: Resolution): string {
  const deck = resolution.deckName ? ` “${resolution.deckName}”` : "";
  if (resolution.decision === "session") {
    return `Approved for this session only. This session now uses${deck}. The workspace default was not changed.`;
  }
  if (resolution.decision === "workspace-default") {
    const where = resolution.workspaceRoot ? ` in ${resolution.workspaceRoot}` : "";
    return `Approved. Future sessions${where} will use${deck} as the new default. This session was switched too.`;
  }
  return "Declined. Nothing was changed — the session and workspace default are untouched.";
}

export default function DeckSwitchApprovePage() {
  const [{ requestId, runtimeSessionId }] = useState(readApprovalContext);
  const [state, setState] = useState<PageState>("loading");
  const [detail, setDetail] = useState<SwitchRequestDetail | null>(null);
  const [message, setMessage] = useState("");
  const [retryable, setRetryable] = useState(true);
  const [deciding, setDeciding] = useState<DeckSwitchDecision | null>(null);
  // Ref guard: two clicks in the same tick see the same state, so state
  // alone cannot prevent a double submission.
  const inFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (!requestId) {
      setState("error");
      setRetryable(false);
      setMessage("This link is incomplete. Ask the agent to request the deck switch again.");
      return;
    }
    setState("loading");
    setMessage("");
    try {
      const res = await apiRequest("GET", `/api/trusted-session/deck-switch/${requestId}`);
      const body = (await res.json()) as { data?: SwitchRequestDetail };
      const record = body.data;
      if (!record || record.requestId !== requestId) {
        throw new Error("Approval lookup returned an unexpected response");
      }
      setDetail(record);
      if (record.status === "pending") {
        setState("pending");
      } else {
        setState("error");
        setRetryable(false);
        setMessage(terminalStatusCopy(record.status));
      }
    } catch (error) {
      const failure = deckSwitchApproveFailure(error);
      setState("error");
      setRetryable(failure.retryable);
      setMessage(failure.message);
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(decision: DeckSwitchDecision) {
    if (inFlightRef.current) {
      return;
    }
    const sessionId = runtimeSessionId || detail?.runtimeSessionId || "";
    if (!requestId || !sessionId) {
      setState("error");
      setRetryable(false);
      setMessage("This link is incomplete. Ask the agent to request the deck switch again.");
      return;
    }
    inFlightRef.current = true;
    setDeciding(decision);
    setState("submitting");
    try {
      const res = await apiRequest("POST", `/api/trusted-session/deck-switch/${requestId}/resolve`, {
        runtimeSessionId: sessionId,
        decision,
      });
      const body = (await res.json()) as {
        data?: { deckName?: string; workspaceRoot?: string };
      };
      const next: Resolution = {
        decision,
        deckName: body.data?.deckName ?? detail?.requestedDeckName,
        workspaceRoot: body.data?.workspaceRoot ?? detail?.workspaceRoot,
      };
      setMessage(successCopy(next));
      setState("success");
    } catch (error) {
      const failure = deckSwitchApproveFailure(error);
      setRetryable(failure.retryable);
      setMessage(failure.message);
      if (failure.retryable && detail) {
        // Recoverable failure (e.g. sign-in, network): keep the loaded
        // request so the human can retry the decision directly.
        setState("pending");
      } else {
        setState("error");
      }
    } finally {
      inFlightRef.current = false;
      setDeciding(null);
    }
  }

  function retry() {
    setMessage("");
    if (detail && retryable) {
      setState("pending");
    } else {
      void load();
    }
  }

  const busy = state === "loading" || state === "submitting";
  const currentDeck = detail?.currentDeckName ?? detail?.currentDeckId;
  const requestedDeck = detail?.requestedDeckName ?? detail?.requestedDeckId;
  const sessionLabel = runtimeSessionId || detail?.runtimeSessionId;

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-muted/30">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Approve deck switch</CardTitle>
          <CardDescription>
            Choose whether the requested deck applies to this session only or becomes the workspace
            default. Declining leaves everything unchanged.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {detail && (currentDeck || requestedDeck) ? (
            <dl className="text-sm space-y-1 text-muted-foreground">
              {currentDeck ? (
                <div>
                  <dt className="inline font-medium text-foreground">Current deck </dt>
                  <dd className="inline">{currentDeck}</dd>
                </div>
              ) : null}
              {requestedDeck ? (
                <div>
                  <dt className="inline font-medium text-foreground">Requested deck </dt>
                  <dd className="inline">{requestedDeck}</dd>
                </div>
              ) : null}
              {detail.workspaceRoot ? (
                <div>
                  <dt className="inline font-medium text-foreground">Workspace </dt>
                  <dd className="inline font-mono text-xs">{detail.workspaceRoot}</dd>
                </div>
              ) : null}
              {sessionLabel ? (
                <div>
                  <dt className="inline font-medium text-foreground">Session </dt>
                  <dd className="inline font-mono text-xs">{sessionLabel}</dd>
                </div>
              ) : null}
            </dl>
          ) : requestId ? (
            <p className="text-sm text-muted-foreground">
              Request <span className="font-mono text-xs">{requestId}</span>
            </p>
          ) : null}

          {state === "loading" ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading the deck-switch request…
            </p>
          ) : null}

          {state === "success" ? (
            <p role="status" className="text-sm text-green-700 dark:text-green-400">
              {message}
            </p>
          ) : null}

          {(state === "error" || state === "pending") && message ? (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ) : null}

          {(state === "pending" || state === "submitting") && detail ? (
            <div className="space-y-2">
              <Button
                onClick={() => void resolve("session")}
                disabled={busy}
                className="w-full"
              >
                {deciding === "session" ? "Approving…" : "This session only"}
              </Button>
              <Button
                onClick={() => void resolve("workspace-default")}
                disabled={busy}
                variant="secondary"
                className="w-full"
              >
                {deciding === "workspace-default" ? "Approving…" : "This workspace by default"}
              </Button>
              <Button
                onClick={() => void resolve("decline")}
                disabled={busy}
                variant="outline"
                className="w-full"
              >
                {deciding === "decline" ? "Declining…" : "Decline"}
              </Button>
            </div>
          ) : null}

          {state === "error" ? (
            retryable ? (
              <Button onClick={retry} variant="outline" className="w-full">
                Try again
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                No further action is possible on this link. You can close this tab.
              </p>
            )
          ) : null}

          {state === "success" ? (
            <p className="text-sm text-muted-foreground">You can close this tab and return to the agent.</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
