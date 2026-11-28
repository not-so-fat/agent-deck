import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { credentialRunApproveFailure } from "@/lib/credential-run-approve-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export type CredentialRunDecision = "approve" | "decline";

type CredentialRunRequestDetail = {
  requestId: string;
  status: string;
  createdAt?: string;
  expiresAt?: string;
  resolvedAt?: string | null;
  runtimeSessionId?: string;
  deckId?: string;
  deckName?: string;
  argv?: string[];
  credentialIds?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutSec?: number;
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
    return "This credential-run request expired. Nothing executed and no secrets were resolved. Ask the agent to request the run again.";
  }
  if (status === "declined") {
    return "This credential-run request was already declined. Nothing executed and no secrets were resolved.";
  }
  if (status === "approved") {
    return "This credential-run request was already approved and is waiting for the agent's identical retry to execute it.";
  }
  return "This credential-run request was already resolved. The command was not run twice — check with the agent before requesting again.";
}

function formatArgv(argv: string[] | undefined): string {
  if (!argv || argv.length === 0) {
    return "(no command)";
  }
  return argv.join(" ");
}

export default function CredentialRunApprovePage() {
  const [{ requestId, runtimeSessionId }] = useState(readApprovalContext);
  const [state, setState] = useState<PageState>("loading");
  const [detail, setDetail] = useState<CredentialRunRequestDetail | null>(null);
  const [message, setMessage] = useState("");
  const [retryable, setRetryable] = useState(true);
  const [deciding, setDeciding] = useState<CredentialRunDecision | null>(null);
  // Ref guard: two clicks in the same tick see the same state, so state
  // alone cannot prevent a double submission.
  const inFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (!requestId) {
      setState("error");
      setRetryable(false);
      setMessage("This link is incomplete. Ask the agent to request the run again.");
      return;
    }
    setState("loading");
    setMessage("");
    try {
      const res = await apiRequest("GET", `/api/trusted-session/credential-run/${requestId}`);
      const body = (await res.json()) as { data?: CredentialRunRequestDetail };
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
      const failure = credentialRunApproveFailure(error);
      setState("error");
      setRetryable(failure.retryable);
      setMessage(failure.message);
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(decision: CredentialRunDecision) {
    if (inFlightRef.current) {
      return;
    }
    const sessionId = runtimeSessionId || detail?.runtimeSessionId || "";
    if (!requestId || !sessionId) {
      setState("error");
      setRetryable(false);
      setMessage("This link is incomplete. Ask the agent to request the run again.");
      return;
    }
    inFlightRef.current = true;
    setDeciding(decision);
    setState("submitting");
    try {
      await apiRequest("POST", `/api/trusted-session/credential-run/${requestId}/resolve`, {
        runtimeSessionId: sessionId,
        decision,
      });
      setMessage(
        decision === "approve"
          ? "Approved. The agent's identical retry will now run this exact command with the deck credentials; the secret values stay daemon-side and never reach the agent."
          : "Declined. Nothing executed and no secrets were resolved.",
      );
      setState("success");
    } catch (error) {
      const failure = credentialRunApproveFailure(error);
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
  const sessionLabel = runtimeSessionId || detail?.runtimeSessionId;
  const deckLabel = detail?.deckName ?? detail?.deckId;

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-muted/30">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Approve credential run</CardTitle>
          <CardDescription>
            The agent wants to run the exact command below with deck credentials in its environment.
            Approving runs it once; secrets resolve daemon-side and never reach the agent. Declining
            leaves everything unchanged.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {detail ? (
            <dl className="text-sm space-y-1 text-muted-foreground">
              <div>
                <dt className="inline font-medium text-foreground">Command </dt>
                <dd className="inline font-mono text-xs break-all">{formatArgv(detail.argv)}</dd>
              </div>
              {detail.credentialIds && detail.credentialIds.length > 0 ? (
                <div>
                  <dt className="inline font-medium text-foreground">Credentials </dt>
                  <dd className="inline font-mono text-xs">{detail.credentialIds.join(", ")}</dd>
                </div>
              ) : null}
              {detail.env ? (
                <div>
                  <dt className="inline font-medium text-foreground">Env aliases </dt>
                  <dd className="inline font-mono text-xs break-all">{JSON.stringify(detail.env)}</dd>
                </div>
              ) : null}
              {detail.cwd ? (
                <div>
                  <dt className="inline font-medium text-foreground">Working directory </dt>
                  <dd className="inline font-mono text-xs break-all">{detail.cwd}</dd>
                </div>
              ) : null}
              {typeof detail.timeoutSec === "number" ? (
                <div>
                  <dt className="inline font-medium text-foreground">Timeout </dt>
                  <dd className="inline">{detail.timeoutSec}s</dd>
                </div>
              ) : null}
              {deckLabel ? (
                <div>
                  <dt className="inline font-medium text-foreground">Deck </dt>
                  <dd className="inline">{deckLabel}</dd>
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
              Loading the credential-run request…
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
                onClick={() => void resolve("approve")}
                disabled={busy}
                className="w-full"
              >
                {deciding === "approve" ? "Approving…" : "Approve and run"}
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
