import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Deck, Service, Credential, Playbook } from "@agent-deck/shared";
import { getServiceCardColor, API_KEY_CARD_COLOR, PLAYBOOK_CARD_COLOR } from "@/lib/card-colors";
import { BookOpen, Plus } from "lucide-react";
import ServiceCardIcon from "@/components/service-card-icon";
import CardWarningBadge from "@/components/card-warning-badge";
import CredentialCardIcon from "@/components/credential-card-icon";
import DeckFan, { CARD_HEIGHT, CARD_WIDTH, FAN_SLOT_MIN_HEIGHT } from "@/components/deck-fan";
import type { CollectionWarningsView } from "@/lib/collection-warnings";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface DeckBuilderProps {
  deck: Deck;
  services: Service[];
  credentials?: Credential[];
  playbooks?: Playbook[];
  allServices: Service[];
  collectionWarnings?: CollectionWarningsView;
  onDrop: (e: React.DragEvent) => void;
  onDragStart: (e: React.DragEvent, service: Service, fromDeck?: boolean) => void;
  onCredentialDragStart: (e: React.DragEvent, credential: Credential, fromDeck?: boolean) => void;
  onPlaybookDragStart: (e: React.DragEvent, playbook: Playbook, fromDeck?: boolean) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onCardClick?: (service: Service) => void;
  onPlaybookClick?: (playbook: Playbook) => void;
  onCredentialClick?: (credential: Credential) => void;
}

export default function DeckBuilder({
  deck,
  services,
  credentials = [],
  playbooks = [],
  collectionWarnings,
  onDrop,
  onDragStart,
  onCredentialDragStart,
  onPlaybookDragStart,
  onDragEnd,
  onCardClick,
  onPlaybookClick,
  onCredentialClick,
}: DeckBuilderProps) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(deck.name);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    setNameDraft(deck.name);
    setEditingName(false);
  }, [deck.id, deck.name]);

  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [editingName]);

  const renameMutation = useMutation({
    mutationFn: async (name: string) => {
      const response = await apiRequest("PUT", `/api/decks/${deck.id}`, { name });
      return response.json() as Promise<{ success: boolean; data?: Deck; error?: string }>;
    },
    onSuccess: (body) => {
      if (!body.success) {
        throw new Error(body.error || "Rename failed");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/decks"] });
      setEditingName(false);
    },
    onError: (error: Error) => {
      setNameDraft(deck.name);
      setEditingName(false);
      toast({
        title: "Could not rename deck",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const commitRename = () => {
    const next = nameDraft.trim();
    if (!next || next === deck.name) {
      setNameDraft(deck.name);
      setEditingName(false);
      return;
    }
    renameMutation.mutate(next);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    onDrop(e);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const deckCards = services.length + credentials.length + playbooks.length;

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <h3 className="mb-4 flex min-w-0 shrink-0 items-center text-lg font-bold">
        <i className="fas fa-layer-group mr-2 text-blue-400"></i>
        <span className="font-ui-display">Deck</span>
        {editingName ? (
          <Input
            ref={nameInputRef}
            value={nameDraft}
            disabled={renameMutation.isPending}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setNameDraft(deck.name);
                setEditingName(false);
              }
            }}
            className="ml-2 h-7 max-w-[12rem] border-white/20 bg-white/10 px-2 text-sm font-normal text-white sm:max-w-[16rem]"
            data-testid="input-deck-name"
            aria-label="Deck name"
          />
        ) : (
          <button
            type="button"
            className="ml-2 min-w-0 truncate text-left text-sm font-normal text-gray-400 hover:text-white hover:underline"
            title="Click to rename"
            onClick={() => setEditingName(true)}
            data-testid="button-rename-deck"
          >
            {deck.name}
          </button>
        )}
        <span className="ml-2 shrink-0 text-sm font-normal text-gray-400">
          ({deckCards} cards)
        </span>
      </h3>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl border-2 border-dashed px-4 py-2 min-w-0"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        style={{
          background: "linear-gradient(135deg, rgba(196, 182, 67, 0.1), rgba(212, 199, 96, 0.1))",
          borderColor: "rgba(196, 182, 67, 0.3)",
        }}
        data-testid="deck-drop-zone"
      >
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden min-w-0">
          {deckCards === 0 ? (
            <div
              className="flex items-center justify-center"
              style={{ minHeight: FAN_SLOT_MIN_HEIGHT }}
            >
              <div
                className="flex items-center justify-center rounded-lg border-2 border-dashed border-gray-500 opacity-50 transition-opacity hover:opacity-75"
                style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}
                data-testid="deck-empty-placeholder"
              >
                <Plus className="h-8 w-8 text-gray-500" />
              </div>
            </div>
          ) : (
            <DeckFan cardCount={deckCards}>
              {credentials.map((credential, index) => (
                  <div
                    key={credential.id}
                    className="w-32 h-48 aspect-[2/3] rounded-lg border-2 p-3 transition-shadow duration-500 shadow-lg hover:shadow-2xl bg-gradient-to-b from-gray-900 via-gray-800 to-gray-900 relative overflow-hidden cursor-pointer"
                    style={{
                      borderColor: API_KEY_CARD_COLOR,
                      boxShadow: `0 0 20px ${API_KEY_CARD_COLOR}20`,
                    }}
                    draggable
                    onDragStart={(e) => onCredentialDragStart(e, credential, true)}
                    onDragEnd={onDragEnd}
                    onClick={() => onCredentialClick?.(credential)}
                    data-testid={`deck-card-${credential.id}`}
                  >
                    <CardWarningBadge
                      warnings={collectionWarnings?.credentialWarnings.get(credential.id)}
                    />

                    <div className="absolute top-1 left-1 text-xs font-bold">
                      <div className="leading-none" style={{ color: API_KEY_CARD_COLOR }}>AK</div>
                    </div>
                    <div className="absolute bottom-1 right-1 text-xs font-bold rotate-180">
                      <div className="leading-none" style={{ color: API_KEY_CARD_COLOR }}>AK</div>
                    </div>
                    <div className="absolute inset-x-2 top-6 bottom-8 flex flex-col items-center justify-center text-center">
                      <div className="mb-2" style={{ color: API_KEY_CARD_COLOR }}>
                        <CredentialCardIcon credential={credential} color={API_KEY_CARD_COLOR} />
                      </div>
                      <h3 className="font-bold text-xs mb-1 line-clamp-2" style={{ color: API_KEY_CARD_COLOR }}>
                        {credential.label}
                      </h3>
                      <div
                        className="text-[8px] px-1 py-0.5 rounded border opacity-70"
                        style={{ color: API_KEY_CARD_COLOR, borderColor: API_KEY_CARD_COLOR }}
                      >
                        {credential.hasSecret ? "API Key" : "Missing key"}
                      </div>
                    </div>
                  </div>
              ))}
              {playbooks.map((playbook, index) => (
                    <div
                      key={playbook.id}
                      className="w-32 h-48 aspect-[2/3] rounded-lg border-2 p-3 transition-shadow duration-500 shadow-lg hover:shadow-2xl bg-gradient-to-b from-gray-900 via-gray-800 to-gray-900 relative overflow-hidden cursor-pointer"
                      style={{
                        borderColor: PLAYBOOK_CARD_COLOR,
                        boxShadow: `0 0 20px ${PLAYBOOK_CARD_COLOR}20`,
                      }}
                      draggable
                      onDragStart={(e) => onPlaybookDragStart(e, playbook, true)}
                      onDragEnd={onDragEnd}
                      onClick={() => onPlaybookClick?.(playbook)}
                      data-testid={`deck-card-${playbook.id}`}
                    >
                      <CardWarningBadge
                        warnings={collectionWarnings?.playbookWarnings.get(playbook.id)}
                      />

                      <div className="absolute top-1 left-1 text-xs font-bold">
                        <div className="leading-none" style={{ color: PLAYBOOK_CARD_COLOR }}>PB</div>
                      </div>
                      <div className="absolute bottom-1 right-1 text-xs font-bold rotate-180">
                        <div className="leading-none" style={{ color: PLAYBOOK_CARD_COLOR }}>PB</div>
                      </div>
                      <div className="absolute inset-x-2 top-6 bottom-8 flex flex-col items-center justify-center text-center">
                        <div className="mb-2" style={{ color: PLAYBOOK_CARD_COLOR }}>
                          <BookOpen className="h-7 w-7" strokeWidth={2.25} />
                        </div>
                        <h3
                          className="font-bold text-xs mb-1 line-clamp-2"
                          style={{ color: PLAYBOOK_CARD_COLOR }}
                        >
                          {playbook.title}
                        </h3>
                        <div
                          className="text-[8px] px-1 py-0.5 rounded border opacity-70"
                          style={{ color: PLAYBOOK_CARD_COLOR, borderColor: PLAYBOOK_CARD_COLOR }}
                        >
                          Playbook
                        </div>
                      </div>
                    </div>
              ))}
              {services.map((service) => (
                    <div
                      key={service.id}
                      className="w-32 h-48 aspect-[2/3] rounded-lg border-2 p-3 transition-shadow duration-500 shadow-lg hover:shadow-2xl bg-gradient-to-b from-gray-900 via-gray-800 to-gray-900 relative overflow-hidden cursor-pointer"
                      style={{
                        borderColor: getServiceCardColor(service),
                        boxShadow: `0 0 20px ${getServiceCardColor(service)}20`,
                      }}
                      draggable
                      onDragStart={(e) => onDragStart(e, service, true)}
                      onDragEnd={onDragEnd}
                      onClick={() => onCardClick?.(service)}
                      data-testid={`deck-card-${service.id}`}
                    >
                      <CardWarningBadge
                        warnings={collectionWarnings?.serviceWarnings.get(service.id)}
                      />

                      <div className="absolute top-1 left-1 text-xs font-bold">
                        <div className="leading-none" style={{ color: getServiceCardColor(service) }}>
                          {service.type === "mcp" ? "RM" : service.type === "local-mcp" ? "LM" : "A"}
                        </div>
                      </div>
                      <div className="absolute bottom-1 right-1 text-xs font-bold rotate-180">
                        <div className="leading-none" style={{ color: getServiceCardColor(service) }}>
                          {service.type === "mcp" ? "RM" : service.type === "local-mcp" ? "LM" : "A"}
                        </div>
                      </div>
                      <div className="absolute inset-x-2 top-6 bottom-8 flex flex-col items-center justify-center text-center">
                        <div className="mb-2" style={{ color: getServiceCardColor(service) }}>
                          <ServiceCardIcon service={service} />
                        </div>
                        <h3
                          className="font-bold text-xs mb-1 line-clamp-2"
                          style={{ color: getServiceCardColor(service) }}
                        >
                          {service.name}
                        </h3>
                        <div
                          className="text-[8px] px-1 py-0.5 rounded border opacity-70"
                          style={{
                            color: getServiceCardColor(service),
                            borderColor: getServiceCardColor(service),
                          }}
                        >
                          {service.type === "mcp"
                            ? "Remote MCP"
                            : service.type === "local-mcp"
                              ? "Local MCP"
                              : "A2A"}
                        </div>
                      </div>
                    </div>
              ))}
            </DeckFan>
          )}
        </div>
      </div>
    </div>
  );
}
