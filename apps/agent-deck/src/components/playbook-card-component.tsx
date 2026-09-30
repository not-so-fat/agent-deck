import { memo } from "react";
import type { CollectionCardWarning } from "@/lib/collection-warnings";
import { Deck, Playbook } from "@agent-deck/shared";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { BookOpen } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PLAYBOOK_CARD_COLOR } from "@/lib/card-colors";
import CardWarningBadge from "@/components/card-warning-badge";
import { CardActionArea } from "@/components/card-usage-mark";
import { CARD_USAGE_QUERY_KEY, type CardUsageCardSummary } from "@/lib/card-usage";
import { inDeckCollectionClass, InDeckCornerBadge } from "@/lib/in-deck-card-style";

interface PlaybookCardComponentProps {
  playbook: Playbook;
  isInActiveDeck: boolean;
  activeDeck?: Deck;
  isInCollection?: boolean;
  onDragStart?: (e: React.DragEvent, playbook: Playbook, fromDeck?: boolean) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onCardClick?: (playbook: Playbook) => void;
  warnings?: CollectionCardWarning[];
  usage?: CardUsageCardSummary | null;
}

function PlaybookCardComponent({
  playbook,
  isInActiveDeck,
  activeDeck,
  isInCollection = true,
  onDragStart,
  onDragEnd,
  onMouseEnter,
  onMouseLeave,
  onCardClick,
  warnings,
  usage,
}: PlaybookCardComponentProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const cardColor = PLAYBOOK_CARD_COLOR;
  const depCount =
    playbook.dependsOnCredentialIds.length + playbook.dependsOnServiceIds.length;

  const addToDeckMutation = useMutation({
    mutationFn: async () => {
      if (!activeDeck) {
        throw new Error("No deck selected");
      }

      return apiRequest("POST", `/api/decks/${activeDeck.id}/playbooks`, {
        playbookId: playbook.id,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/decks"] });
      toast({
        title: "Playbook added to deck",
        description: `${playbook.title} is on this deck.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to add playbook",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deletePlaybookMutation = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/playbooks/${playbook.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/playbooks/vault"] });
      queryClient.invalidateQueries({ queryKey: [...CARD_USAGE_QUERY_KEY] });
      queryClient.invalidateQueries({ queryKey: ["/api/decks"] });
      toast({
        title: "Playbook deleted",
        description: `${playbook.title} was removed from your collection.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to delete playbook",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleDeletePlaybook = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(`Delete playbook "${playbook.title}"?`)) {
      deletePlaybookMutation.mutate();
    }
  };

  return (
    <div
      className="relative group cursor-pointer"
      draggable={!isInActiveDeck && Boolean(onDragStart)}
      onDragStart={onDragStart ? (e) => onDragStart(e, playbook) : undefined}
      onDragEnd={onDragEnd}
      onClick={() => onCardClick?.(playbook)}
      data-testid={`card-${playbook.id}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div
        className={`
        w-32 h-48 aspect-[2/3] rounded-lg border-2 p-3 
        transform transition-all duration-300 shadow-lg hover:shadow-2xl
        bg-gradient-to-b from-gray-900 via-gray-800 to-gray-900
        relative overflow-hidden
        ${inDeckCollectionClass(isInActiveDeck)}
        ${isInCollection ? "hover:scale-110 hover:rotate-0" : "hover:scale-105"}
      `}
        style={{
          borderColor: cardColor,
          boxShadow: `0 0 20px ${cardColor}20`,
        }}
      >
        <CardWarningBadge warnings={warnings} />
        {isInActiveDeck && <InDeckCornerBadge />}

        <div className="absolute top-1 left-1 text-xs font-bold">
          <div className="leading-none" style={{ color: cardColor }}>PB</div>
        </div>

        <div className="absolute bottom-1 right-1 text-xs font-bold rotate-180">
          <div className="leading-none" style={{ color: cardColor }}>PB</div>
        </div>

        <CardActionArea
          usage={usage}
          createdAt={playbook.createdAt}
          color={cardColor}
          onDelete={handleDeletePlaybook}
          deleteTitle={`Delete ${playbook.title}`}
        />

        <div className="absolute inset-x-2 top-6 bottom-8 flex flex-col items-center justify-center text-center">
          <div className="mb-2" style={{ color: cardColor }}>
            <BookOpen className="h-7 w-7" strokeWidth={2.25} />
          </div>

          <h3
            className="font-bold text-xs mb-1 line-clamp-2"
            style={{ color: cardColor }}
          >
            {playbook.title}
          </h3>

          <div
            className="text-[8px] px-1 py-0.5 rounded border opacity-70"
            style={{ color: cardColor, borderColor: cardColor }}
          >
            Playbook{depCount > 0 ? ` · ${depCount} deps` : ""}
          </div>
        </div>

        <div className="absolute bottom-6 inset-x-1">
          <Button
            size="sm"
            className="w-full text-[8px] px-1 py-1 h-5 bg-black/20 hover:bg-black/40 border"
            style={{ color: cardColor, borderColor: cardColor }}
            onClick={(e) => {
              e.stopPropagation();
              addToDeckMutation.mutate();
            }}
            disabled={isInActiveDeck || addToDeckMutation.isPending || !activeDeck}
          >
            {isInActiveDeck ? "IN DECK" : "ADD"}
          </Button>
        </div>

        <div className="absolute inset-0 rounded-lg bg-gradient-to-br from-transparent via-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-all duration-500 pointer-events-none" />
      </div>
    </div>
  );
}

export default memo(PlaybookCardComponent);
