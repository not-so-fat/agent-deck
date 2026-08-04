import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import type { PlaybookPatch } from "@agent-deck/shared";
import { patchPreviewHasChanges } from "@/lib/patch-preview";
import {
  acceptPlaybookPatch,
  formatPatchDeckNames,
  getPlaybookPatchPreview,
  listPlaybookPatches,
  rejectPlaybookPatch,
} from "@/lib/playbook-patches";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { PlaybookPatchDiff } from "@/components/playbook-patch-diff";
import {
  PlaybookPatchTriggerConflicts,
  parseTriggerConflicts,
} from "@/components/playbook-patch-trigger-conflicts";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";

const PAGE_SIZE = 8;

type StatusFilter = PlaybookPatch["status"] | "all";

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "proposed", label: "Waiting" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
  { value: "superseded", label: "Superseded" },
  { value: "stale", label: "Stale" },
  { value: "all", label: "All" },
];

function parseEvidence(patch: PlaybookPatch) {
  if (!patch.evidenceJson) return null;
  try {
    return JSON.parse(patch.evidenceJson) as {
      failure_summary?: string;
      user_feedback_excerpt?: string;
      corrected_output_hint?: string;
    };
  } catch {
    return null;
  }
}

function statusBadgeClass(status: PlaybookPatch["status"]): string {
  switch (status) {
    case "proposed":
      return "border-blue-500/40 text-blue-200";
    case "accepted":
      return "border-emerald-500/40 text-emerald-200";
    case "rejected":
      return "border-rose-500/40 text-rose-200";
    case "superseded":
      return "border-violet-500/40 text-violet-200";
    case "stale":
      return "border-amber-500/40 text-amber-200";
  }
}

export default function PlaybookPatchesPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("proposed");
  const [page, setPage] = useState(0);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  function selectPatch(id: string) {
    setSelectedId(id);
  }

  function setFilter(next: StatusFilter) {
    setStatusFilter(next);
    setPage(0);
    setSelectedId(null);
  }

  const { data: proposedPatches = [] } = useQuery({
    queryKey: ["/api/playbook-patches", "proposed"],
    queryFn: () => listPlaybookPatches("proposed"),
  });

  const listStatus = statusFilter === "all" ? undefined : statusFilter;
  const { data: patches = [], isLoading } = useQuery({
    queryKey: ["/api/playbook-patches", statusFilter],
    queryFn: () => listPlaybookPatches(listStatus),
  });

  const pageCount = Math.max(1, Math.ceil(patches.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pagePatches = useMemo(() => {
    const start = safePage * PAGE_SIZE;
    return patches.slice(start, start + PAGE_SIZE);
  }, [patches, safePage]);

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  const {
    data: preview,
    isLoading: previewLoading,
    isError: previewError,
    error: previewErrorDetail,
  } = useQuery({
    queryKey: ["/api/playbook-patches", selectedId, "preview"],
    queryFn: () => getPlaybookPatchPreview(selectedId!),
    enabled: Boolean(selectedId),
  });

  const previewHasChanges = preview ? patchPreviewHasChanges(preview) : false;

  const selected = patches.find((p) => p.id === selectedId) ?? null;
  const canDecide = selected?.status === "proposed";

  const acceptMutation = useMutation({
    mutationFn: (id: string) => acceptPlaybookPatch(id),
    onSuccess: () => {
      toast({ title: "Patch accepted" });
      setSelectedId(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/playbook-patches"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/playbooks"] });
      // Stale-conflict accept reopens linked signals — refresh badge/backlog.
      void queryClient.invalidateQueries({ queryKey: ["/api/feedback-signals"] });
    },
    onError: (error: Error) => {
      toast({ title: "Accept failed", description: error.message, variant: "destructive" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => rejectPlaybookPatch(id),
    onSuccess: () => {
      toast({ title: "Patch rejected" });
      setSelectedId(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/playbook-patches"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/feedback-signals"] });
    },
    onError: (error: Error) => {
      toast({ title: "Reject failed", description: error.message, variant: "destructive" });
    },
  });

  const emptyMessage =
    statusFilter === "proposed"
      ? "No proposals waiting for review."
      : statusFilter === "all"
        ? "No playbook patches yet."
        : `No ${statusFilter} patches.`;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-gray-950 text-gray-100">
      <header className="shrink-0 border-b border-gray-800 px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="sm" className="text-gray-300">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Deck
            </Button>
          </Link>
          <h1 className="text-lg font-semibold">Playbook review queue</h1>
          <Badge variant="secondary">{proposedPatches.length} waiting</Badge>
          <Link
            href="/feedback-signals"
            className="ml-auto text-sm hover:underline"
            style={{ color: "#92E4DD" }}
          >
            Feedback data →
          </Link>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-7xl min-h-0 flex-1 gap-6 overflow-hidden px-4 py-6 sm:px-6 lg:grid-cols-[minmax(18rem,20rem)_minmax(0,1fr)] lg:items-stretch">
        <section className="flex min-h-0 min-w-0 flex-col">
          <h2 className="mb-3 shrink-0 text-sm font-medium text-gray-400">Proposals</h2>

          <div className="mb-3 flex shrink-0 flex-wrap gap-1">
            {STATUS_FILTERS.map(({ value, label }) => {
              const active = statusFilter === value;
              return (
                <Button
                  key={value}
                  size="sm"
                  variant={active ? "gold" : "outline"}
                  className={
                    active
                      ? undefined
                      : "border-gray-600 bg-transparent text-gray-300 hover:bg-gray-800 hover:text-gray-100"
                  }
                  aria-pressed={active}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </Button>
              );
            })}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
            {!isLoading && patches.length === 0 && (
              <p className="text-sm text-gray-500">{emptyMessage}</p>
            )}
            <ul className="space-y-2">
              {pagePatches.map((patch) => (
                <li key={patch.id}>
                  <button
                    type="button"
                    onClick={() => selectPatch(patch.id)}
                    className={`w-full rounded-lg border p-3 text-left transition ${
                      selectedId === patch.id
                        ? "border-blue-500 bg-gray-900"
                        : "border-gray-800 bg-gray-900/50 hover:border-gray-700"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <span className="block font-medium leading-snug">
                          {patch.kind === "create" ? `New: ${patch.displayTitle}` : patch.displayTitle}
                        </span>
                        {patch.playbookId && patch.kind !== "create" && (
                          <span className="mt-0.5 block truncate font-mono text-xs text-gray-600">
                            {patch.playbookId}
                          </span>
                        )}
                        {formatPatchDeckNames(patch.deckNames) && (
                          <span className="mt-1 block text-xs text-gray-500">
                            Decks: {formatPatchDeckNames(patch.deckNames)}
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <Badge variant="outline" className="shrink-0">
                          {patch.kind}
                        </Badge>
                        {statusFilter !== "proposed" && (
                          <Badge
                            variant="outline"
                            className={`shrink-0 ${statusBadgeClass(patch.status)}`}
                          >
                            {patch.status}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-gray-400">{patch.rationale}</p>
                    <p className="mt-1 text-xs text-gray-600">
                      {patch.source} · {new Date(patch.createdAt).toLocaleString()}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {patches.length > PAGE_SIZE && (
            <div className="mt-3 flex shrink-0 items-center justify-between gap-2 border-t border-gray-800 pt-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="border-gray-600 bg-transparent text-gray-300 hover:bg-gray-800"
                disabled={safePage <= 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                Newer
              </Button>
              <span className="text-xs text-gray-500">
                {safePage + 1} / {pageCount}
                <span className="ml-1 text-gray-600">({patches.length})</span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="border-gray-600 bg-transparent text-gray-300 hover:bg-gray-800"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              >
                Older
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          )}
        </section>

        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <h2 className="mb-3 shrink-0 text-sm font-medium text-gray-400">Detail</h2>
          {!selected && (
            <p className="text-sm text-gray-500">Select a proposal to preview the diff.</p>
          )}
          {selected && (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-gray-800 bg-gray-900/50">
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-5">
                <div className="min-w-0 space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={statusBadgeClass(selected.status)}>
                      {selected.status}
                    </Badge>
                    {selected.resolvedAt && (
                      <span className="text-xs text-gray-500">
                        Resolved {new Date(selected.resolvedAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  <p className="text-sm leading-relaxed text-gray-300">{selected.rationale}</p>
                  {selected.status === "rejected" && selected.rejectionReason && (
                    <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-100">
                      <p className="text-xs font-medium uppercase tracking-wide text-rose-300/80">
                        Rejection reason
                      </p>
                      <p className="mt-1">{selected.rejectionReason}</p>
                    </div>
                  )}
                  {selected.status === "superseded" && selected.supersededBy && (
                    <div className="rounded-md border border-violet-500/40 bg-violet-500/10 p-3 text-sm text-violet-100">
                      <p className="text-xs font-medium uppercase tracking-wide text-violet-300/80">
                        Superseded by
                      </p>
                      <button
                        type="button"
                        className="mt-1 font-mono text-sm underline-offset-2 hover:underline"
                        onClick={() => {
                          const successorId = selected.supersededBy!;
                          setStatusFilter("all");
                          setPage(0);
                          selectPatch(successorId);
                        }}
                      >
                        {selected.supersededBy}
                      </button>
                    </div>
                  )}
                  {(() => {
                    const evidence = parseEvidence(selected);
                    if (!evidence) return null;
                    return (
                      <div className="rounded-md border border-gray-700 bg-gray-950 p-4 text-sm">
                        <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                          Your correction
                        </p>
                        <p className="mt-2 italic text-gray-200">
                          &ldquo;{evidence.user_feedback_excerpt}&rdquo;
                        </p>
                        {evidence.failure_summary && (
                          <p className="mt-2 text-gray-400">{evidence.failure_summary}</p>
                        )}
                      </div>
                    );
                  })()}
                  {(() => {
                    const storedConflicts = parseTriggerConflicts(selected.conflictsJson);
                    const previewConflicts = preview?.trigger_conflicts ?? [];
                    const conflicts =
                      previewConflicts.length > 0 ? previewConflicts : storedConflicts;
                    return <PlaybookPatchTriggerConflicts conflicts={conflicts} />;
                  })()}
                  {previewLoading && <p className="text-sm text-gray-500">Loading preview…</p>}
                  {previewError && (
                    <div className="rounded-md border border-rose-500/50 bg-rose-500/10 p-3 text-sm text-rose-100">
                      Preview failed —{" "}
                      {previewErrorDetail?.message ?? "could not apply ops to the current playbook."}
                      {canDecide
                        ? " Reject and re-propose with exact list anchors or rewrite_body."
                        : " Historical preview may be incomplete if the playbook changed."}
                    </div>
                  )}
                  {preview && <PlaybookPatchDiff preview={preview} />}
                  {selected.status === "stale" && (
                    <p className="text-sm text-amber-400">
                      Stale — playbook changed since proposal. Re-propose from a fresh session.
                    </p>
                  )}
                </div>
              </div>

              {canDecide ? (
                <div className="relative z-10 shrink-0 space-y-3 border-t border-gray-800 bg-gray-950 p-4 shadow-[0_-16px_32px_rgba(0,0,0,0.55)] sm:p-5">
                  <h3 className="text-sm font-medium text-gray-400">Your decision</h3>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="gold"
                      onClick={() => acceptMutation.mutate(selected.id)}
                      disabled={acceptMutation.isPending || previewError || !previewHasChanges}
                    >
                      Accept
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => rejectMutation.mutate(selected.id)}
                      disabled={rejectMutation.isPending}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="shrink-0 border-t border-gray-800 bg-gray-950 px-4 py-3 text-sm text-gray-500 sm:px-5">
                  Read-only — already {selected.status}. Switch to Waiting to review open proposals.
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
