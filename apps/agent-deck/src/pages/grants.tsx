import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import type { Deck } from "@agent-deck/shared";
import { ArrowLeft, Check, Copy, KeyRound, ShieldOff } from "lucide-react";

import {
  createAgentGrant,
  revokeAgentGrant,
  type AgentGrant,
  type AgentGrantListResponse,
} from "@/lib/agent-grants";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

type DashboardContextResponse = {
  success: boolean;
  data: { hosted: boolean };
};

type DecksResponse = { success: boolean; data: Deck[] };
type ExpiryChoice = "none" | "30" | "90" | "custom";

const EMPTY_GRANTS: AgentGrant[] = [];

function formatDate(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function grantStatus(grant: AgentGrant): "active" | "expired" | "revoked" {
  if (grant.revokedAt) return "revoked";
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) return "expired";
  return "active";
}

function expiryTimestamp(choice: ExpiryChoice, customExpiry: string): string | undefined {
  if (choice === "none") return undefined;
  if (choice === "custom") return new Date(customExpiry).toISOString();
  const days = choice === "30" ? 30 : 90;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export default function GrantsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [label, setLabel] = useState("");
  const [defaultDeck, setDefaultDeck] = useState("");
  const [allowedDecks, setAllowedDecks] = useState<Set<string>>(new Set());
  const [expiry, setExpiry] = useState<ExpiryChoice>("none");
  const [customExpiry, setCustomExpiry] = useState("");
  const [issuedSecret, setIssuedSecret] = useState<{ label: string; token: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  const initializedDecks = useRef(false);

  const { data: contextResponse, isLoading: contextLoading, error: contextError } =
    useQuery<DashboardContextResponse>({
      queryKey: ["/api/dashboard-auth/context"],
    });
  const isHosted = contextResponse?.data.hosted === true;

  const { data: decksResponse } = useQuery<DecksResponse>({
    queryKey: ["/api/decks"],
    enabled: isHosted,
  });
  const decks = decksResponse?.data ?? [];

  const {
    data: grantsResponse,
    isLoading: grantsLoading,
    error: grantsError,
  } = useQuery<AgentGrantListResponse>({
    queryKey: ["/api/agent-grants"],
    enabled: isHosted,
  });
  const grants = grantsResponse?.data ?? EMPTY_GRANTS;

  useEffect(() => {
    if (initializedDecks.current || decks.length === 0) return;
    initializedDecks.current = true;
    setDefaultDeck(decks[0].id);
    setAllowedDecks(new Set(decks.map((deck) => deck.id)));
  }, [decks]);

  const deckNames = useMemo(
    () => new Map(decks.map((deck) => [deck.id, deck.name])),
    [decks],
  );

  const revokeMutation = useMutation({
    mutationFn: revokeAgentGrant,
    onSuccess: (_result, id) => {
      const revokedAt = new Date().toISOString();
      queryClient.setQueryData<AgentGrantListResponse>(
        ["/api/agent-grants"],
        (current) => current
          ? {
              ...current,
              data: current.data.map((grant) =>
                grant.id === id ? { ...grant, revokedAt } : grant,
              ),
            }
          : current,
      );
      setConfirmingRevoke(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/agent-grants"] });
      toast({ title: "Grant revoked", description: "The bearer stops working immediately." });
    },
    onError: (error: Error) => {
      toast({ title: "Revoke failed", description: error.message, variant: "destructive" });
    },
  });

  const toggleAllowedDeck = (deckId: string, checked: boolean) => {
    setAllowedDecks((current) => {
      const next = new Set(current);
      if (checked) next.add(deckId);
      else next.delete(deckId);
      return next;
    });
  };

  const handleDefaultDeck = (deckId: string) => {
    setDefaultDeck(deckId);
    setAllowedDecks((current) => new Set(current).add(deckId));
  };

  const handleCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError(null);
    if (!defaultDeck) {
      setCreateError("Choose a default deck.");
      return;
    }
    if (expiry === "custom" && !customExpiry) {
      setCreateError("Choose a custom expiry date.");
      return;
    }

    setCreating(true);
    try {
      // Deliberately avoid a React Query mutation here: mutation caches can
      // outlive this route, while the bearer must disappear when it unmounts.
      const issued = await createAgentGrant({
        label: label.trim(),
        defaultDeck,
        allowedDecks: [...allowedDecks],
        expiresAt: expiryTimestamp(expiry, customExpiry),
      });
      setIssuedSecret({ label: issued.grant.label, token: issued.token });
      queryClient.setQueryData<AgentGrantListResponse>(["/api/agent-grants"], (current) => ({
        success: true,
        data: current
          ? [...current.data.filter((grant) => grant.id !== issued.grant.id), issued.grant]
          : [issued.grant],
      }));
      setLabel("");
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Grant creation failed");
    } finally {
      setCreating(false);
    }
  };

  if (contextLoading) {
    return <PageMessage message="Loading grant settings…" />;
  }
  if (contextError) {
    return <PageMessage message="Owner sign-in is required to manage grants." isError />;
  }
  if (!isHosted) {
    return <PageMessage message="Remote agent grants are available in hosted mode only." />;
  }

  return (
    <div className="flex min-h-dvh flex-col bg-gray-950 text-gray-100">
      <header className="shrink-0 border-b border-gray-800 px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="sm" className="text-gray-300">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Deck
            </Button>
          </Link>
          <KeyRound className="h-5 w-5 text-[#C4B643]" aria-hidden />
          <h1 className="font-ui-display text-lg font-semibold">Remote agent grants</h1>
          <Badge variant="outline" className="border-gray-700 text-gray-300">
            {grants.length}
          </Badge>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 space-y-5 px-4 py-6 sm:px-6">
        <p className="max-w-3xl text-sm leading-6 text-gray-400">
          Issue a separate bearer for each remote agent. Deck access is fixed at creation;
          revoke and reissue when it needs to change.
        </p>

        {issuedSecret && (
          <section
            className="min-w-0 rounded-xl border border-amber-400/50 bg-amber-400/10 p-4"
            aria-label="New bearer secret"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-ui-display font-semibold text-amber-200">
                  Copy the bearer for {issuedSecret.label}
                </h2>
                <p className="mt-1 text-sm font-semibold text-amber-100">
                  This secret will not be shown again.
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-amber-100 hover:bg-amber-300/10 hover:text-amber-50"
                onClick={() => setIssuedSecret(null)}
              >
                <Check className="h-4 w-4" />
                Done — hide secret
              </Button>
            </div>
            <div className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row">
              <Input
                readOnly
                aria-label="Bearer secret"
                value={issuedSecret.token}
                className="min-w-0 flex-1 border-amber-300/30 bg-black/40 font-mono text-xs text-amber-50"
              />
              <Button
                type="button"
                variant="gold"
                className="w-full sm:w-auto"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(issuedSecret.token);
                    toast({ title: "Bearer copied" });
                  } catch {
                    toast({ title: "Copy failed", variant: "destructive" });
                  }
                }}
              >
                <Copy className="h-4 w-4" />
                Copy bearer
              </Button>
            </div>
          </section>
        )}

        <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(18rem,20rem)_minmax(0,1fr)]">
          <section className="h-fit min-w-0 rounded-xl border border-gray-800 bg-gray-900/50 p-4 sm:p-5">
            <h2 className="font-ui-display text-base font-semibold">Create grant</h2>
            <form className="mt-4 space-y-4" onSubmit={handleCreate}>
              <div className="space-y-1.5">
                <Label htmlFor="grant-label">Agent label</Label>
                <Input
                  id="grant-label"
                  required
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="Research agent"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="default-deck">Default deck</Label>
                <select
                  id="default-deck"
                  required
                  value={defaultDeck}
                  onChange={(event) => handleDefaultDeck(event.target.value)}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {decks.map((deck) => (
                    <option key={deck.id} value={deck.id}>{deck.name}</option>
                  ))}
                </select>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Allowed decks</legend>
                <p className="text-xs text-gray-500">All decks are selected by default.</p>
                <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-gray-800 p-3">
                  {decks.map((deck) => {
                    const isDefault = deck.id === defaultDeck;
                    return (
                      <div key={deck.id} className="flex items-center gap-2">
                        <Checkbox
                          id={`allowed-${deck.id}`}
                          checked={allowedDecks.has(deck.id)}
                          disabled={isDefault}
                          onCheckedChange={(checked) => toggleAllowedDeck(deck.id, checked === true)}
                          className="border-[#C4B643] data-[state=checked]:bg-[#C4B643] data-[state=checked]:text-[#0A0A07]"
                        />
                        <Label htmlFor={`allowed-${deck.id}`} className="min-w-0 break-words font-normal">
                          {deck.name}{isDefault ? " (default)" : ""}
                        </Label>
                      </div>
                    );
                  })}
                </div>
              </fieldset>

              <div className="space-y-1.5">
                <Label htmlFor="grant-expiry">Expiry</Label>
                <select
                  id="grant-expiry"
                  value={expiry}
                  onChange={(event) => setExpiry(event.target.value as ExpiryChoice)}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="none">None</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                  <option value="custom">Custom</option>
                </select>
              </div>

              {expiry === "custom" && (
                <div className="space-y-1.5">
                  <Label htmlFor="custom-expiry">Expires at</Label>
                  <Input
                    id="custom-expiry"
                    type="datetime-local"
                    required
                    value={customExpiry}
                    onChange={(event) => setCustomExpiry(event.target.value)}
                  />
                </div>
              )}

              {createError && <p role="alert" className="text-sm text-rose-300">{createError}</p>}
              <Button type="submit" variant="gold" className="w-full" disabled={creating || decks.length === 0}>
                {creating ? "Creating…" : "Create grant"}
              </Button>
            </form>
          </section>

          <section className="min-w-0 space-y-3" aria-label="Existing grants">
            <h2 className="font-ui-display text-base font-semibold">Existing grants</h2>
            {grantsLoading && <p className="text-sm text-gray-500">Loading grants…</p>}
            {grantsError && <p role="alert" className="text-sm text-rose-300">Could not load grants.</p>}
            {!grantsLoading && !grantsError && grants.length === 0 && (
              <div className="rounded-xl border border-dashed border-gray-800 p-8 text-center text-sm text-gray-500">
                No remote agent grants yet.
              </div>
            )}
            {grants.map((grant) => {
              const status = grantStatus(grant);
              const canRevoke = status !== "revoked";
              const confirming = confirmingRevoke === grant.id;
              return (
                <article key={grant.id} className="min-w-0 rounded-xl border border-gray-800 bg-gray-900/50 p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="break-words font-semibold text-gray-100">{grant.label}</h3>
                      <p className="mt-1 break-all font-mono text-xs text-gray-600">{grant.id}</p>
                    </div>
                    <StatusBadge status={status} />
                  </div>

                  <dl className="mt-4 grid min-w-0 gap-x-5 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
                    <GrantField label="Default deck" value={deckNames.get(grant.defaultDeck) ?? grant.defaultDeck} />
                    <GrantField
                      label="Allowed decks"
                      value={grant.allowedDecks.map((id) => deckNames.get(id) ?? id).join(", ") || "None"}
                    />
                    <GrantField label="Created" value={formatDate(grant.createdAt)} />
                    <GrantField label="Expires" value={formatDate(grant.expiresAt)} />
                    <GrantField label="Last used" value={grant.lastUsedAt ? formatDate(grant.lastUsedAt) : "Never"} />
                  </dl>

                  {canRevoke && (
                    <div className="mt-4 border-t border-gray-800 pt-4">
                      {confirming ? (
                        <div className="flex flex-wrap items-center justify-between gap-3" role="group" aria-label={`Confirm revoke ${grant.label}`}>
                          <p className="text-sm text-rose-200">Revoke {grant.label} now? This is immediate.</p>
                          <div className="flex w-full gap-2 sm:w-auto">
                            <Button type="button" variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={() => setConfirmingRevoke(null)}>
                              Cancel
                            </Button>
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              className="flex-1 sm:flex-none"
                              disabled={revokeMutation.isPending}
                              onClick={() => revokeMutation.mutate(grant.id)}
                            >
                              Confirm revoke
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button type="button" variant="outline" size="sm" className="border-rose-900 text-rose-200 hover:bg-rose-950" onClick={() => setConfirmingRevoke(grant.id)}>
                          <ShieldOff className="h-4 w-4" />
                          Revoke
                        </Button>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        </div>
      </main>
    </div>
  );
}

function StatusBadge({ status }: { status: "active" | "expired" | "revoked" }) {
  const className = status === "active"
    ? "border-emerald-500/40 text-emerald-200"
    : status === "expired"
      ? "border-amber-500/40 text-amber-200"
      : "border-rose-500/40 text-rose-200";
  return <Badge variant="outline" className={className}>{status}</Badge>;
}

function GrantField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-ui-display text-xs text-gray-500">{label}</dt>
      <dd className="mt-1 break-words text-gray-300">{value}</dd>
    </div>
  );
}

function PageMessage({ message, isError = false }: { message: string; isError?: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          <Link href="/"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" />Deck</Button></Link>
          <h1 className="font-ui-display text-lg font-semibold">Remote agent grants</h1>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
        <p role={isError ? "alert" : "status"} className={isError ? "text-rose-300" : "text-gray-400"}>{message}</p>
      </main>
    </div>
  );
}

