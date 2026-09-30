import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";
import type { CardUsageCardSummary } from "@/lib/card-usage";
import { cardUsageLabel } from "@/lib/card-usage";

interface CardUsageMarkProps {
  /** Classification row for this card; omit (loading/error) to render nothing. */
  usage?: CardUsageCardSummary | null;
  /** Card creation timestamp (service `registeredAt`, otherwise `createdAt`). */
  createdAt?: string;
  /** Card accent from the existing palette; kept muted via low opacity. */
  color: string;
}

/**
 * Shared Collection-card usage mark (NOT-294). One semantic mapping for
 * service, credential, and playbook cards:
 * popular = 3 filled stars, used = 1 filled star, unused = 1 outline star,
 * new = restrained uppercase NEW. Glyphs render at 8px scaled to 75%
 * (~6px apparent) so the group stays clearly smaller than the card's
 * top-left type label; NEW is ~7px. Meaning is carried by shape + the
 * accessible label/tooltip, never by color alone.
 */
export function CardUsageMark({ usage, createdAt, color }: CardUsageMarkProps) {
  if (!usage) {
    return null;
  }

  const label = cardUsageLabel(usage, createdAt);

  if (usage.category === "new") {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        data-testid="card-usage-mark"
        data-category="new"
        className="text-[7px] font-semibold uppercase leading-none tracking-wide opacity-60"
        style={{ color }}
      >
        New
      </span>
    );
  }

  const filledCount = usage.category === "popular" ? 3 : 1;
  const outline = usage.category === "unused";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="card-usage-mark"
      data-category={usage.category}
      className="inline-flex items-center gap-[1px] opacity-60"
      style={{
        color,
        // Render at 8px for glyph quality, scale the whole group to ~75%
        // (~6px apparent). Origin top-right preserves the alignment.
        transform: "scale(0.75)",
        transformOrigin: "top right",
      }}
    >
      {Array.from({ length: filledCount }).map((_, i) => (
        <Star
          key={i}
          aria-hidden
          className="h-2 w-2 shrink-0"
          fill={outline ? "none" : "currentColor"}
          strokeWidth={outline ? 2.5 : 2}
        />
      ))}
    </span>
  );
}

interface CardActionAreaProps extends CardUsageMarkProps {
  onDelete: (e: React.MouseEvent) => void;
  deleteTitle: string;
}

/**
 * Top-right card action slot shared by all Collection card types. Shows the
 * subtle usage mark by default and swaps it for the delete action on
 * pointer hover or keyboard focus within the action area itself
 * (named `group/action`, so hovering elsewhere on the card leaves the mark
 * — and its tooltip — alone), restoring the mark afterwards. The delete
 * button's tooltip carries the usage copy too, so the classification stays
 * pointer-reachable after the swap. Absolute positioning keeps card content
 * unshifted; omitting `usage` leaves existing delete behavior untouched.
 */
export function CardActionArea({
  usage,
  createdAt,
  color,
  onDelete,
  deleteTitle,
}: CardActionAreaProps) {
  const usageLabel = usage ? cardUsageLabel(usage, createdAt) : null;
  // Keep the usage classification reachable once the mark swaps out: the
  // delete control's visible tooltip (title) carries the same copy that the
  // mark exposes via its own title/aria-label.
  const deleteTooltip = usageLabel ? `${usageLabel} · ${deleteTitle}` : deleteTitle;
  return (
    <div
      data-testid="card-action-area"
      className="absolute top-1 right-1 z-10 flex h-5 min-w-5 items-start justify-end group/action"
    >
      {usage ? (
        <span
          data-testid="card-usage-slot"
          className="transition-opacity duration-200 group-hover/action:opacity-0 group-focus-within/action:opacity-0 group-hover/action:pointer-events-none"
        >
          <CardUsageMark usage={usage} createdAt={createdAt} color={color} />
        </span>
      ) : null}
      <span
        data-testid="card-delete-slot"
        className="absolute right-0 top-0 opacity-0 pointer-events-none transition-opacity duration-200 group-hover/action:opacity-100 group-hover/action:pointer-events-auto group-focus-within/action:opacity-100 group-focus-within/action:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto"
      >
        <Button
          size="sm"
          variant="destructive"
          className="h-5 w-5 p-0 bg-red-500/80 hover:bg-red-500 border-red-400"
          onClick={onDelete}
          title={deleteTooltip}
          aria-label={deleteTooltip}
        >
          <Trash2 className="w-3 h-3" />
        </Button>
      </span>
    </div>
  );
}
