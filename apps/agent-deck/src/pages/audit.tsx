import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ScrollText } from "lucide-react";
import { Link } from "wouter";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listAudit, type AuditEntry } from "@/lib/audit";

type DashboardContextResponse = {
  success: boolean;
  data: { hosted: boolean };
};

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

function Outcome({ entry }: { entry: AuditEntry }) {
  return (
    <Badge
      variant="outline"
      className={entry.outcome === "succeeded"
        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
        : "border-rose-500/40 bg-rose-500/10 text-rose-300"}
    >
      {entry.outcome}
    </Badge>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="font-ui-display text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-1 break-all text-sm text-gray-200">{children}</dd>
    </div>
  );
}

export default function AuditPage() {
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const before = cursors.at(-1);
  const { data: context, isLoading: contextLoading, error: contextError } =
    useQuery<DashboardContextResponse>({ queryKey: ["/api/dashboard-auth/context"] });
  const hosted = context?.data.hosted === true;
  const { data: page, isLoading, error } = useQuery({
    queryKey: ["audit", before ?? "newest"],
    queryFn: () => listAudit(before),
    enabled: hosted,
  });

  if (contextLoading) return <PageMessage message="Loading audit history…" />;
  if (contextError) return <PageMessage message="Owner sign-in is required to view audit history." isError />;
  if (!hosted) return <PageMessage message="Audit history is available in hosted mode only." />;

  return (
    <div className="flex min-h-dvh flex-col bg-gray-950 text-gray-100">
      <header className="shrink-0 border-b border-gray-800 px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="sm" className="text-gray-300">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Deck
            </Button>
          </Link>
          <ScrollText className="h-5 w-5 text-[#C4B643]" aria-hidden />
          <h1 className="font-ui-display text-lg font-semibold">Audit history</h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 space-y-5 px-4 py-6 sm:px-6">
        <p className="max-w-3xl text-sm leading-6 text-gray-400">
          Security-relevant grant, sign-in, deck-selection and elevation activity from the last 90 days.
        </p>

        {isLoading ? <p className="text-sm text-gray-400">Loading events…</p> : null}
        {error ? <p role="alert" className="text-sm text-rose-300">Audit history could not be loaded.</p> : null}
        {page?.data.length === 0 ? (
          <div className="rounded-xl border border-gray-800 bg-gray-900/70 p-8 text-center text-sm text-gray-400">
            No audit events on this page.
          </div>
        ) : null}

        {page?.data.length ? (
          <>
            <div className="hidden overflow-hidden rounded-xl border border-gray-800 bg-gray-900/70 md:block">
              <Table>
                <TableHeader>
                  <TableRow className="border-gray-800 hover:bg-transparent">
                    <TableHead>Time</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.data.map((entry) => (
                    <TableRow key={entry.id} className="border-gray-800 hover:bg-white/[0.03]">
                      <TableCell className="whitespace-nowrap text-xs text-gray-400">{formatTimestamp(entry.timestamp)}</TableCell>
                      <TableCell className="font-medium text-[#E8F6F4]">{entry.event}</TableCell>
                      <TableCell className="max-w-48 break-all font-mono text-xs">{entry.actor}</TableCell>
                      <TableCell className="max-w-56 break-all font-mono text-xs">{entry.targetId}</TableCell>
                      <TableCell><Outcome entry={entry} /></TableCell>
                      <TableCell className="text-xs text-gray-400">{entry.reasonCode ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <ol className="space-y-3 md:hidden" aria-label="Audit events">
              {page.data.map((entry) => (
                <li key={entry.id} className="min-w-0 rounded-xl border border-gray-800 bg-gray-900/70 p-4">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0 break-words font-medium text-[#E8F6F4]">{entry.event}</div>
                    <Outcome entry={entry} />
                  </div>
                  <dl className="mt-4 grid min-w-0 grid-cols-1 gap-3">
                    <Field label="Time">{formatTimestamp(entry.timestamp)}</Field>
                    <Field label="Actor">{entry.actor}</Field>
                    <Field label="Target">{entry.targetId}</Field>
                    <Field label="Reason">{entry.reasonCode ?? "—"}</Field>
                  </dl>
                </li>
              ))}
            </ol>
          </>
        ) : null}

        {page ? (
          <nav className="flex items-center justify-between gap-3" aria-label="Audit pagination">
            <Button
              variant="outline"
              disabled={cursors.length === 1}
              onClick={() => setCursors((current) => current.slice(0, -1))}
            >
              Newer
            </Button>
            <span className="text-xs text-gray-500">Page {cursors.length}</span>
            <Button
              variant="outline"
              disabled={!page.paging.nextBefore}
              onClick={() => page.paging.nextBefore && setCursors((current) => [...current, page.paging.nextBefore!])}
            >
              Older
            </Button>
          </nav>
        ) : null}
      </main>
    </div>
  );
}

function PageMessage({ message, isError = false }: { message: string; isError?: boolean }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-gray-950 px-4 text-center">
      <p className={isError ? "text-rose-300" : "text-gray-300"}>{message}</p>
    </div>
  );
}

