import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { deckAssignmentApproveFailure } from "@/lib/deck-assignment-approve-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export type DeckAssignmentDecision = "session" | "workspace-default" | "decline";

type AssignmentRequestDetail = {
  requestId: string;
  status: string;
  createdAt?: string;
  expiresAt?: string;
  resolvedAt?: string | null;
  mcpSessionId?: string;
  workspaceRoot?: string;
  reason?: string;
  deckId?: string;
  deckName?: string;
};

type DeckOption = {
  id: string;
  name: string;
};

type Resolution = {
  decision: DeckAssignmentDecision;
  deckName?: string;
  workspaceRoot?: string;
};

type PageState = "loading" | "pending" | "submitting" | "success" | "error";

function readApprovalContext(): { requestId: string } {
  const params = new URLSearchParams(window.location.search);
  const requestId = (params.get("request") ?? params.get("requestId") ?? "").trim();
  return { requestId };
}

function terminalStatusCopy(status: string): string {
  if (status === "expired") {
    return "This deck-assignment request expired. Nothing was assigned. Ask the agent to request the assignment again.";
  }
  if (status === "declined") {
    return "This deck-assignment request was already declined. Nothing was changed.";
  }
  return "This deck-assignment request was already resolved. The assignment was not applied twice — check the current deck before requesting again.";
}

function successCopy(resolution: Resolution): string {
  const deck = resolution.deckName ? ` "${resolution.deckName}"` : "";
  if (resolution.decision === "session") {
    return `Approved for this session only. This session now uses${deck}. The folder was not assigned on disk.`;
  }
  if (resolution.decision === "workspace-default") {
    const where = resolution.workspaceRoot ? ` in ${resolution.workspaceRoot}` : "";
    return `Approved. Future sessions${where} will use${deck} as the default. This session was bound too.`;
  }
  return "Declined. Nothing was changed — the session stays unassigned and the folder is untouched.";
}

export default function DeckAssignmentApprovePage() {
  const [{ requestId }] = useState(readApprovalContext);
  const [state, setState] = useState<PageState>("loading");
  const [detail, setDetail] = useState<AssignmentRequestDetail | null>(null);
  const [decks, setDecks] = useState<DeckOption[]>([]);
  const [deckId, setDeckId] = useState("");
  const [message, setMessage] = useState("");
  const [retryable, setRetryable] = useState(true);
  const [deciding, setDeciding] = useState<DeckAssignmentDecision | null>(null);
  const inFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (!requestId) {
      setState("error");
      setRetryable(false);
      setMessage("This link is incomplete. Ask the agent to request the deck assignment again.");
      return;
    }
    setState("loading");
    setMessage("");
    try {
      const res = await apiRequest("GET", `/api/trusted-session/deck-assignment/${requestId}`);
      const body = (await res.json()) as { data?: AssignmentRequestDetail };
      const record = body.data;
      if (!record || record.requestId !== requestId) {
        throw new Error("Approval lookup returned an unexpected response");
      }
      setDetail(record);
      if (record.status !== "pending") {
        setState("error");
        setRetryable(false);
        setMessage(terminalStatusCopy(record.status));
        return;
      }
      const decksRes = await apiRequest("GET", "/api/decks");
      const decksBody = (await decksRes.json()) as { data?: DeckOption[] } | DeckOption[];
      const list = Array.isArray(decksBody) ? decksBody : (decksBody.data ?? []);
      setDecks(list.filter((deck) => deck?.id && deck?.name));
      setState("pending");
    } catch (error) {
      const failure = deckAssignmentApproveFailure(error);
      setState("error");
      setRetryable(failure.retryable);
      setMessage(failure.message);
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(decision: DeckAssignmentDecision) {
    if (inFlightRef.current) {
      return;
    }
    if (!requestId) {
      setState("error");
      setRetryable(false);
      setMessage("This link is incomplete. Ask the agent to request the deck assignment again.");
      return;
    }
    if (decision !== "decline" && !deckId) {
      setMessage("Pick a deck first, or decline the request.");
      return;
    }
    inFlightRef.current = true;
    setDeciding(decision);
    setState("submitting");
    try {
      const res = await apiRequest(
        "POST",
        `/api/trusted-session/deck-assignment/${requestId}/resolve`,
        decision === "decline" ? { decision } : { deckId, decision },
      );
      const body = (await res.json()) as {
        data?: { deckName?: string; workspaceRoot?: string };
      };
      const chosen = decks.find((deck) => deck.id === deckId);
      const next: Resolution = {
        decision,
        deckName: body.data?.deckName ?? chosen?.name,
        workspaceRoot: body.data?.workspaceRoot ?? detail?.workspaceRoot,
      };
      setMessage(successCopy(next));
      setState("success");
    } catch (error) {
      const failure = deckAssignmentApproveFailure(error);
      setRetryable(failure.retryable);
      setMessage(failure.message);
      if (failure.retryable && detail) {
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

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-muted/30">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Assign a deck to this folder</CardTitle>
          <CardDescription>
            Pick the deck for the folder below. Verify the full path before approving — the
            assignment writes only inside it. Declining leaves everything unchanged.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {detail?.workspaceRoot ? (
            <dl className="text-sm space-y-1 text-muted-foreground">
              <div>
                <dt className="inline font-medium text-foreground">Folder </dt>
                <dd className="inline font-mono text-xs break-all">{detail.workspaceRoot}</dd>
              </div>
              {detail.reason ? (
                <div>
                  <dt className="inline font-medium text-foreground">Note </dt>
                  <dd className="inline">{detail.reason}</dd>
                </div>
              ) : null}
              {detail.mcpSessionId ? (
                <div>
                  <dt className="inline font-medium text-foreground">Session </dt>
                  <dd className="inline font-mono text-xs">{detail.mcpSessionId}</dd>
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
              Loading the deck-assignment request…
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
              <label className="block text-sm font-medium" htmlFor="deck-assignment-deck">
                Deck
              </label>
              <select
                id="deck-assignment-deck"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={deckId}
                disabled={busy}
                onChange={(event) => setDeckId(event.target.value)}
              >
                <option value="">Pick a deck…</option>
                {decks.map((deck) => (
                  <option key={deck.id} value={deck.id}>
                    {deck.name}
                  </option>
                ))}
              </select>
              <Button
                onClick={() => void resolve("session")}
                disabled={busy || !deckId}
                className="w-full"
              >
                {deciding === "session" ? "Approving…" : "This session only"}
              </Button>
              <Button
                onClick={() => void resolve("workspace-default")}
                disabled={busy || !deckId}
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
