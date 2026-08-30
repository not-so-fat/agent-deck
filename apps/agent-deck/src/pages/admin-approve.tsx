import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type ApproveState = "idle" | "loading" | "success" | "error";

export default function AdminApprovePage() {
  const params = new URLSearchParams(window.location.search);
  const challengeId = params.get("challenge") ?? "";
  const runtimeSessionId = params.get("session") ?? "";

  const [state, setState] = useState<ApproveState>("idle");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    if (!challengeId || !runtimeSessionId) {
      setState("error");
      setMessage("Missing challenge or session in URL.");
    }
  }, [challengeId, runtimeSessionId]);

  async function approve() {
    if (!challengeId || !runtimeSessionId) {
      return;
    }
    setState("loading");
    try {
      await apiRequest("POST", "/api/trusted-session/admin/approve", {
        challengeId,
        runtimeSessionId,
      });
      setState("success");
      setMessage("Admin elevation approved for this MCP session. Return to the agent.");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Approval failed");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-muted/30">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Approve agent-admin elevation</CardTitle>
          <CardDescription>
            Grants ephemeral deck-admin mode to one MCP session (30-minute lease). This does not change
            the persistent workspace grant.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {challengeId && runtimeSessionId ? (
            <dl className="text-sm space-y-1 text-muted-foreground">
              <div>
                <dt className="inline font-medium text-foreground">Session </dt>
                <dd className="inline font-mono text-xs">{runtimeSessionId}</dd>
              </div>
              <div>
                <dt className="inline font-medium text-foreground">Challenge </dt>
                <dd className="inline font-mono text-xs">{challengeId}</dd>
              </div>
            </dl>
          ) : null}

          {state === "success" ? (
            <p className="text-sm text-green-700 dark:text-green-400">{message}</p>
          ) : state === "error" ? (
            <p className="text-sm text-destructive">{message}</p>
          ) : null}

          {state !== "success" && challengeId && runtimeSessionId ? (
            <Button onClick={() => void approve()} disabled={state === "loading"} className="w-full">
              {state === "loading" ? "Approving…" : "Approve elevation"}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
