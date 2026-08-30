import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LiveBinding } from '@agent-deck/shared';
import { Radio, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  formatActivityAge,
  groupLiveBindings,
  liveSessionRowSubtitle,
  sessionModeClass,
  sessionModeLabel,
  truncateDeckName,
} from '@/lib/live-bindings';
import { MCP_CARD_COLOR } from '@/lib/card-colors';
import { cn } from '@/lib/utils';

const POPOVER_WIDTH_CLASS = 'w-[min(22rem,calc(100vw-2rem))]';

type LiveSessionBadgesPanelProps = {
  bindings: LiveBinding[];
  now?: Date;
  highlightDeckId?: string;
  showContainmentNote?: boolean;
  scrollClassName?: string;
};

export function LiveSessionBadgesPanel({
  bindings,
  now = new Date(),
  highlightDeckId,
  showContainmentNote = false,
  scrollClassName = 'max-h-64 overflow-y-auto',
}: LiveSessionBadgesPanelProps) {
  const onThisDeckCount = highlightDeckId
    ? bindings.filter((row) => row.deckId === highlightDeckId).length
    : 0;

  const grouped = useMemo(() => groupLiveBindings(bindings), [bindings]);

  return (
    <>
      <div className="border-b border-white/10 px-3 py-2.5">
        <p className="text-sm font-semibold leading-snug" style={{ color: MCP_CARD_COLOR }}>
          Live sessions
          <span className="ml-1 font-normal text-gray-400">· match ⌘badge to chat opener</span>
        </p>
      </div>
      {showContainmentNote ? (
        <div className="border-b border-white/10 px-3 py-2 text-xs text-gray-400">
          <div className="flex items-start gap-2">
            <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden />
            <p>
              Agents are bound to one deck per workspace. Cross-deck service calls return{' '}
              <span className="font-mono text-gray-300">RESOURCE_OUT_OF_SCOPE</span>.
            </p>
          </div>
        </div>
      ) : null}
      {highlightDeckId && onThisDeckCount > 1 ? (
        <div className="border-b border-[#92E4DD]/20 bg-[#92E4DD]/5 px-3 py-1.5 text-xs text-gray-300">
          {onThisDeckCount} sessions on this deck
        </div>
      ) : null}
      <div className={cn(scrollClassName, 'p-2')}>
        {grouped.map(({ key, label, isWorkspaceGroup, rows }) => (
          <div key={key} className="mb-2 last:mb-0">
            <p className="px-1 pb-1 text-[10px] uppercase tracking-wide text-gray-500">
              {label}
            </p>
            <ul className="space-y-1">
              {rows.map((row) => {
                const client = row.clientName ?? 'agent';
                const age = formatActivityAge(row.lastActivityAt, now);
                const clientMeta = age ? `${client} · ${age}` : client;
                const highlighted = highlightDeckId === row.deckId;
                const subtitle = liveSessionRowSubtitle(row, {
                  isWorkspaceGroup,
                  highlighted,
                  clientMeta,
                });
                return (
                  <li
                    key={row.badge}
                    className={cn(
                      'rounded-md border-l-2 py-1.5 pl-2 pr-2 font-mono text-xs',
                      highlighted
                        ? 'border-[#92E4DD] bg-[#92E4DD]/5'
                        : 'border-transparent bg-white/5',
                    )}
                    data-testid={`live-session-row-${row.badge}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span style={{ color: MCP_CARD_COLOR }}>⌘{row.badge}</span>
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-wide',
                          sessionModeClass(row.mode),
                        )}
                      >
                        {sessionModeLabel(row.mode)}
                      </span>
                    </div>
                    <span className="mt-0.5 block font-sans text-[10px] text-gray-400">
                      {subtitle}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}

type LiveSessionBadgesProps = {
  highlightDeckId?: string;
};

export default function LiveSessionBadges({ highlightDeckId }: LiveSessionBadgesProps) {
  const { data } = useQuery<{ success: boolean; data: LiveBinding[] }>({
    queryKey: ['/api/scope/bindings'],
    refetchInterval: 3_000,
  });

  const bindings = data?.data ?? [];

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
        className={cn(
          POPOVER_WIDTH_CLASS,
          'border-white/10 bg-gray-950/95 p-0 text-gray-100',
        )}
        data-testid="live-session-badges-panel"
      >
        <LiveSessionBadgesPanel bindings={bindings} highlightDeckId={highlightDeckId} />
      </PopoverContent>
    </Popover>
  );
}
