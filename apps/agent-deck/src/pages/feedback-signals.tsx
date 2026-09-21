import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import type { FeedbackSignal, Playbook } from "@agent-deck/shared";
import {
  buildCurationPromptForAgent,
  discardFeedbackSignals,
  listFeedbackSignals,
  signalLooksInProposal,
} from "@/lib/feedback-signals";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Copy, Trash2 } from "lucide-react";

/** Match home deck accents — avoid browser accent / one-off sky. */
const CHECKBOX_CLASS =
  "border-[#C4B643] data-[state=checked]:bg-[#C4B643] data-[state=checked]:text-[#0A0A07] data-[state=indeterminate]:bg-[#C4B643] data-[state=indeterminate]:text-[#0A0A07]";

type StatusFilter = "open" | "actioned" | "discarded" | "all";

export default function FeedbackSignalsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [playbookId, setPlaybookId] = useState<string>("");
  const [includeInProposal, setIncludeInProposal] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Same key + envelope as home (default queryFn returns ApiResponse) — do not unwrap
  // in queryFn or a warm cache from home crashes: "playbooks is not iterable".
  const { data: playbooksResponse } = useQuery<{ success: boolean; data: Playbook[] }>({
    queryKey: ["/api/playbooks/vault"],
  });
  const playbooks = playbooksResponse?.data ?? [];

  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of playbooks) map.set(p.id, p.title);
    return map;
  }, [playbooks]);

  const listFilters = {
    status: statusFilter === "all" ? undefined : statusFilter,
    playbookId: playbookId || undefined,
    excludeInProposal: statusFilter === "open" ? !includeInProposal : undefined,
  };

  const { data: signals = [], isLoading } = useQuery({
    queryKey: ["/api/feedback-signals", listFilters],
    queryFn: () => listFeedbackSignals(listFilters),
  });

  const discardMutation = useMutation({
    mutationFn: (ids: string[]) => discardFeedbackSignals(ids),
    onSuccess: (result) => {
      toast({ title: `Discarded ${result.discarded} signal(s)` });
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ["/api/feedback-signals"] });
    },
    onError: (error: Error) => {
      toast({ title: "Discard failed", description: error.message, variant: "destructive" });
    },
  });

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyForAgent = async () => {
    const chosen =
      selected.size > 0 ? signals.filter((s) => selected.has(s.id)) : signals;
    if (chosen.length === 0) return;
    if (chosen.some((s) => !s.id)) {
      toast({
        title: "Copy blocked",
        description: "Every signal must include an id for tracking.",
        variant: "destructive",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(buildCurationPromptForAgent(chosen));
      toast({
        title: "Copied curation prompt",
        description: `${chosen.length} signal id(s) included — paste into your IDE agent.`,
      });
    } catch (error) {
      toast({
        title: "Copy failed",
        description: error instanceof Error ? error.message : "Clipboard unavailable",
        variant: "destructive",
      });
    }
  };

  const openSelected = [...selected].filter((id) => {
    const s = signals.find((row) => row.id === id);
    return s?.status === "open";
  });

  const allVisibleSelected =
    signals.length > 0 && signals.every((s) => selected.has(s.id));
  const someVisibleSelected = signals.some((s) => selected.has(s.id));

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(signals.map((s) => s.id)));
  };

  return (
    <div className="flex min-h-dvh flex-col bg-gray-950 text-gray-100">
      <header className="shrink-0 border-b border-gray-800 px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="sm" className="text-gray-300">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Home
            </Button>
          </Link>
          <h1 className="font-ui-display text-lg font-semibold">Feedback</h1>
          <Badge variant="outline">{signals.length}</Badge>
          <Link
            href="/playbook-patches"
            className="ml-auto text-sm hover:underline"
            style={{ color: "#92E4DD" }}
          >
            Playbook proposals →
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 space-y-4 px-4 py-6 sm:px-6">
        <p className="text-sm text-gray-400">
          Durable correction data for playbook enhancement. Filter by playbook, copy rows (with ids)
          for an IDE agent to propose, then accept the proposal to mark feedback solved.
        </p>

        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-800 bg-gray-900/40 p-3">
          <label className="text-xs text-gray-500">
            Playbook
            <select
              className="mt-1 block min-w-[12rem] rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-100"
              value={playbookId}
              onChange={(e) => {
                setPlaybookId(e.target.value);
                setSelected(new Set());
              }}
            >
              <option value="">All</option>
              {playbooks.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-wrap gap-1">
            {(
              [
                ["open", "Open"],
                ["actioned", "Actioned"],
                ["discarded", "Discarded"],
                ["all", "All"],
              ] as const
            ).map(([value, label]) => {
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
                  onClick={() => {
                    setStatusFilter(value);
                    setSelected(new Set());
                  }}
                >
                  {label}
                </Button>
              );
            })}
          </div>

          {statusFilter === "open" && (
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={includeInProposal}
                onChange={(e) => setIncludeInProposal(e.target.checked)}
              />
              Include already in an open proposal
            </label>
          )}

          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={signals.length === 0}
              onClick={() => void copyForAgent()}
            >
              <Copy className="mr-1 h-3.5 w-3.5" />
              Copy for agent
              {selected.size > 0 ? ` (${selected.size})` : ""}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={openSelected.length === 0 || discardMutation.isPending}
              onClick={() => discardMutation.mutate(openSelected)}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              Discard selected
            </Button>
          </div>
        </div>

        {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
        {!isLoading && signals.length === 0 && (
          <p className="text-sm text-gray-500">No signals match these filters.</p>
        )}

        {!isLoading && signals.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-gray-800">
            <table className="w-full min-w-[48rem] text-left text-sm">
              <thead className="border-b border-gray-800 bg-gray-900/80 text-xs uppercase text-gray-500">
                <tr>
                  <th className="w-10 px-3 py-2">
                    <Checkbox
                      checked={
                        allVisibleSelected
                          ? true
                          : someVisibleSelected
                            ? "indeterminate"
                            : false
                      }
                      onCheckedChange={toggleSelectAll}
                      aria-label="Select all visible signals"
                      disabled={signals.length === 0}
                      className={CHECKBOX_CLASS}
                    />
                  </th>
                  <th className="px-3 py-2">Excerpt</th>
                  <th className="px-3 py-2">Failure</th>
                  <th className="px-3 py-2">Playbook</th>
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">When</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((signal: FeedbackSignal) => {
                  const inProposal = signalLooksInProposal(signal);
                  return (
                    <tr key={signal.id} className="border-b border-gray-800/80 align-top">
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={selected.has(signal.id)}
                          onCheckedChange={() => toggle(signal.id)}
                          aria-label={`Select ${signal.id}`}
                          className={CHECKBOX_CLASS}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <p className="font-mono text-[11px] text-gray-600">{signal.id}</p>
                        <p className="text-gray-200">&ldquo;{signal.userFeedbackExcerpt}&rdquo;</p>
                        {inProposal && (
                          <Badge variant="outline" className="mt-1 text-[10px]">
                            In proposal
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-400">{signal.failureSummary}</td>
                      <td className="px-3 py-2 text-gray-300">
                        {signal.candidatePlaybookId
                          ? (titleById.get(signal.candidatePlaybookId) ??
                            signal.candidatePlaybookId)
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-gray-500">{signal.source}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-500">
                        {new Date(signal.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
