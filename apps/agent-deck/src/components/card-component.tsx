import { memo } from "react";
import type { CollectionCardWarning } from "@/lib/collection-warnings";
import { Service, Deck } from "@agent-deck/shared";
import { getServiceCardColor } from "@/lib/card-colors";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import CardWarningBadge from "@/components/card-warning-badge";
import ServiceCardIcon from "@/components/service-card-icon";
import { CardActionArea } from "@/components/card-usage-mark";
import { CARD_USAGE_QUERY_KEY, type CardUsageCardSummary } from "@/lib/card-usage";
import { inDeckCollectionClass, InDeckCornerBadge } from "@/lib/in-deck-card-style";

interface CardComponentProps {
  service: Service;
  onDragStart: (e: React.DragEvent, service: Service) => void;
  onDragEnd: (e: React.DragEvent) => void;
  isInActiveDeck: boolean;
  onCardClick?: (service: Service) => void;
  isInCollection?: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  activeDeck?: Deck;
  warnings?: CollectionCardWarning[];
  usage?: CardUsageCardSummary | null;
}

function CardComponent({
  service,
  onDragStart,
  onDragEnd,
  isInActiveDeck,
  onCardClick,
  isInCollection = false,
  onMouseEnter,
  onMouseLeave,
  activeDeck,
  warnings,
  usage,
}: CardComponentProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const cardColor = getServiceCardColor(service);

  const addToDeckMutation = useMutation({
    mutationFn: async () => {
      if (!activeDeck) {
        throw new Error("No active deck found");
      }

      return apiRequest("POST", `/api/decks/${activeDeck.id}/services`, {
        serviceId: service.id,
        position: 0,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/decks"] });
      toast({
        title: "Service added to deck",
        description: `${service.name} has been added to your active deck.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to add service",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteServiceMutation = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/services/${service.id}`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/services"] });
      queryClient.invalidateQueries({ queryKey: ["/api/collection/warnings"] });
      queryClient.invalidateQueries({ queryKey: [...CARD_USAGE_QUERY_KEY] });
      queryClient.invalidateQueries({ queryKey: ["/api/decks"] });
      toast({
        title: "Service deleted",
        description: `${service.name} has been deleted successfully.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to delete service",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleAddToDeck = (e: React.MouseEvent) => {
    e.stopPropagation();
    addToDeckMutation.mutate();
  };

  const handleDeleteService = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(`Are you sure you want to delete ${service.name}? This action cannot be undone.`)) {
      deleteServiceMutation.mutate();
    }
  };

  return (
    <div
      className="relative group cursor-pointer"
      draggable={!isInActiveDeck}
      onDragStart={(e) => onDragStart(e, service)}
      onDragEnd={onDragEnd}
      onClick={() => onCardClick?.(service)}
      data-testid={`card-${service.id}`}
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
          <div className="leading-none" style={{ color: cardColor }}>
            {service.type === "mcp" ? "RM" : service.type === "local-mcp" ? "LM" : "A"}
          </div>
        </div>

        <div className="absolute bottom-1 right-1 text-xs font-bold rotate-180">
          <div className="leading-none" style={{ color: cardColor }}>
            {service.type === "mcp" ? "RM" : service.type === "local-mcp" ? "LM" : "A"}
          </div>
        </div>

        <CardActionArea
          usage={usage}
          createdAt={service.registeredAt}
          color={cardColor}
          onDelete={handleDeleteService}
          deleteTitle={`Delete ${service.name}`}
        />

        <div className="absolute inset-x-2 top-6 bottom-8 flex flex-col items-center justify-center text-center">
          <div className="mb-2" style={{ color: cardColor }}>
            <ServiceCardIcon service={service} />
          </div>

          <h3
            className="font-bold text-xs mb-1 line-clamp-2"
            data-testid={`text-service-name-${service.id}`}
            style={{ color: cardColor }}
          >
            {service.name}
          </h3>

          <div
            className="text-[8px] px-1 py-0.5 rounded border opacity-70"
            style={{ color: cardColor, borderColor: cardColor }}
          >
            {service.type === "mcp"
              ? "Remote MCP"
              : service.type === "local-mcp"
                ? "Local MCP"
                : "A2A"}
          </div>
        </div>

        <div className="absolute bottom-6 inset-x-1">
          <Button
            size="sm"
            className="w-full text-[8px] px-1 py-1 h-5 bg-black/20 hover:bg-black/40 border"
            style={{ color: cardColor, borderColor: cardColor }}
            onClick={handleAddToDeck}
            disabled={isInActiveDeck || addToDeckMutation.isPending}
            data-testid={`button-add-to-deck-${service.id}`}
          >
            {isInActiveDeck ? "IN DECK" : "ADD"}
          </Button>
        </div>

        <div className="absolute inset-0 rounded-lg bg-gradient-to-br from-transparent via-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-all duration-500 pointer-events-none" />
      </div>
    </div>
  );
}

export default memo(CardComponent);
