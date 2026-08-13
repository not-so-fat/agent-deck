import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LiveBinding } from '@agent-deck/shared';
import { Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  formatActivityAge,
  truncateDeckName,
  workspaceBasename,
} from '@/lib/live-bindings';
import { MCP_CARD_COLOR } from '@/lib/card-colors';
import { cn } from '@/lib/utils';

const POLL_MS = 3_000;

type LiveSessionBadgesProps = {
  /** Highlight rows bound to the deck open in the builder. */
  highlightDeckId?: string;
};

export default function LiveSessionBadges({ highlightDeckId }: LiveSessionBadgesProps) {
  const { data } = useQuery<{ success: boolean; data: LiveBinding[] }>({
    queryKey: ['/api/scope/bindings'],
    refetchInterval: POLL_MS,
  });

  const bindings = data?.data ?? [];
  const now = useMemo(() => new Date(), [data]);

  const grouped = useMemo(() => {
    // Group by workspace; header/auto-bound sessions have no folder, so group
    // those under their deck name instead.
    const byGroup = new Map<string, { label: string; rows: LiveBinding[] }>();
    for (const row of bindings) {
      const key = row.workspaceRoot || `deck:${row.deckId}`;
      const label = row.workspaceRoot
        ? `${workspaceBasename(row.workspaceRoot)}/`
        : `◆ ${row.deckName}`;
      const group = byGroup.get(key) ?? { label, rows: [] };
      group.rows.push(row);
      byGroup.set(key, group);
    }
    return [...byGroup.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, { label, rows }]) => ({
        key,
        label,
        rows: [...rows].sort((a, b) =>
          a.lastActivityAt < b.lastActivityAt ? 1 : -1,
        ),
      }));
  }, [bindings]);

  if (bindings.length === 0) {
    return null;
  }

  const onThisDeck = highlightDeckId
    ? bindings.filter((row) => row.deckId === highlightDeckId).length
    : 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 border-white/20 bg-black/30 px-2 text-xs text-gray-200 hover:bg-white/10 hover:text-white"
          data-testid="live-session-badges-trigger"
          title="Live MCP session binds — click for badges"
        >
          <Radio className="mr-1 h-3 w-3" style={{ color: MCP_CARD_COLOR }} aria-hidden />
          <span className="font-mono">⌘{bindings.length}</span>
          {onThisDeck > 0 && onThisDeck < bindings.length ? (
            <span className="ml-1 text-gray-400">({onThisDeck} here)</span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 border-white/10 bg-gray-950/95 p-0 text-gray-100"
        data-testid="live-session-badges-panel"
      >
        <div className="border-b border-white/10 px-3 py-2">
          <p className="text-sm font-semibold" style={{ color: MCP_CARD_COLOR }}>
            Live sessions
          </p>
          <p className="text-xs text-gray-400">
            Match <span className="font-mono">⌘badge</span> to the chat opener
          </p>
        </div>
        <div className="max-h-64 overflow-y-auto p-2">
          {grouped.map(({ key, label, rows }) => (
            <div key={key} className="mb-2 last:mb-0">
              <p className="px-1 pb-1 text-[10px] uppercase tracking-wide text-gray-500">
                {label}
              </p>
              <ul className="space-y-1">
                {rows.map((row) => {
                  const client = row.clientName ?? 'agent';
                  const age = formatActivityAge(row.lastActivityAt, now);
                  const meta = age ? `${client} · ${age}` : client;
                  const highlighted = highlightDeckId === row.deckId;
                  return (
                    <li
                      key={row.badge}
                      className={cn(
                        'rounded-md px-2 py-1.5 font-mono text-xs',
                        highlighted
                          ? 'bg-[#92E4DD]/10 ring-1 ring-[#92E4DD]/40'
                          : 'bg-white/5',
                      )}
                      data-testid={`live-session-row-${row.badge}`}
                    >
                      <span className="text-gray-100">
                        {truncateDeckName(row.deckName)}
                      </span>{' '}
                      <span style={{ color: MCP_CARD_COLOR }}>⌘{row.badge}</span>
                      <span className="mt-0.5 block font-sans text-[10px] text-gray-400">
                        {meta}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
