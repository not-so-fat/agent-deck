import { Deck } from "@agent-deck/shared";
import type { LiveBinding } from "@agent-deck/shared";
import { Button } from "@/components/ui/button";
import { Layers, Plus, Trash2, Copy, Download } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { createDeckErrorToast } from "@/lib/create-deck-error";
import { useToast } from "@/hooks/use-toast";
import { useMemo, useState } from "react";
import {
  downloadBundleJson,
  exportBundle,
  safeFilename,
} from "@/lib/export-import";
import {
  countSessionsByDeckId,
  formatDeckListSubtitle,
} from "@/lib/live-bindings";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface DeckManagementPanelProps {
  decks: Deck[];
  editingDeckId?: string | null;
  onSelectDeck: (deckId: string) => void;
  isLoading: boolean;
}

export default function DeckManagementPanel({
  decks,
  editingDeckId,
  onSelectDeck,
  isLoading,
}: DeckManagementPanelProps) {
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newDeckName, setNewDeckName] = useState("");

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: bindingsData } = useQuery<{ success: boolean; data: LiveBinding[] }>({
    queryKey: ['/api/scope/bindings'],
    refetchInterval: 3_000,
  });

  const sessionCountByDeckId = useMemo(
    () => countSessionsByDeckId(bindingsData?.data ?? []),
    [bindingsData],
  );

  const createDeckMutation = useMutation({
    mutationFn: async (name: string) => {
      return apiRequest("POST", "/api/decks", {
        name,
        isActive: false,
      });
    },
    onSuccess: async (response, name) => {
      const body = await response.json();
      await queryClient.invalidateQueries({ queryKey: ["/api/decks"] });
      if (body.data?.id) {
        onSelectDeck(body.data.id);
      }
      toast({
        title: "Deck created",
        description: `${name} has been created successfully.`,
      });
      setCreateModalOpen(false);
      setNewDeckName("");
    },
    onError: (error: Error) => {
      const { title, description } = createDeckErrorToast(error);
      toast({
        title,
        description,
        variant: "destructive",
      });
    },
  });

  const exportDeckMutation = useMutation({
    mutationFn: async (deck: Deck) => {
      const bundle = await exportBundle({ scope: "deck", deckId: deck.id });
      downloadBundleJson(bundle, `${safeFilename(deck.name)}.agent-deck.json`);
      return bundle;
    },
    onSuccess: (bundle, deck) => {
      toast({
        title: "Deck exported",
        description: `${deck.name}: ${bundle.services.length} services, ${bundle.playbooks.length} playbooks`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Export failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleExportDeck = (e: React.MouseEvent, deck: Deck) => {
    e.stopPropagation();
    exportDeckMutation.mutate(deck);
  };

  const deleteDeckMutation = useMutation({
    mutationFn: async (deckId: string) => {
      return apiRequest("DELETE", `/api/decks/${deckId}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/decks"] });
      toast({
        title: "Deck deleted",
        description: "Your deck has been deleted successfully.",
      });
    },
    onError: (error: Error) => {
      if (error.message.includes("Cannot delete the last deck")) {
        toast({
          title: "Cannot delete deck",
          description: "You cannot delete the last deck. Please create another deck first.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Failed to delete deck",
          description: error.message,
          variant: "destructive",
        });
      }
    },
  });

  const handleCopyDeckId = async (e: React.MouseEvent, deck: Deck) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(deck.id);
      toast({
        title: "Copied deck id",
        description: "Use with bind_workspace({ workspaceRoot, deckId }) in your agent.",
      });
    } catch (error) {
      toast({
        title: "Failed to copy deck id",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const handleDeleteDeck = (e: React.MouseEvent, deckId: string) => {
    e.stopPropagation();
    if (window.confirm("Are you sure you want to delete this deck? This action cannot be undone.")) {
      deleteDeckMutation.mutate(deckId);
    }
  };

  const handleCreateDeck = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newDeckName.trim();
    if (!name) {
      return;
    }
    createDeckMutation.mutate(name);
  };

  const deckCardCount = (deck: Deck) =>
    (deck.services?.length ?? 0) +
    (deck.credentials?.length ?? 0) +
    (deck.playbooks?.length ?? 0);

  if (isLoading) {
    return (
      <div className="bg-black/40 backdrop-blur-md rounded-2xl border border-white/10 p-6 shadow-2xl">
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-white/10 rounded"></div>
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-16 bg-white/5 rounded-lg"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="h-full flex flex-col" data-testid="deck-management-panel">
        <h2 className="text-lg font-bold mb-3 flex items-center">
          <Layers className="w-4 h-4 mr-2" style={{ color: "#92E4DD" }} />
          <span style={{ color: "#92E4DD" }}>My Decks</span>
        </h2>

        <div className="mb-3">
          <Button
            onClick={() => setCreateModalOpen(true)}
            className="w-full border text-sm py-2"
            style={{
              background: "#C4B643",
              borderColor: "#C4B643",
              color: "black",
            }}
            data-testid="create-deck-button"
          >
            <Plus className="w-3 h-3 mr-2" />
            Add Deck
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="space-y-2">
            {decks.map((deck) => {
              const isEditing = deck.id === editingDeckId;
              const count = deckCardCount(deck);
              const sessions = sessionCountByDeckId.get(deck.id) ?? 0;
              const subtitle = formatDeckListSubtitle(count, sessions);

              return (
                <div
                  key={deck.id}
                  className={`p-2 rounded-lg border cursor-pointer transition-all relative group ${
                    isEditing
                      ? "bg-gradient-to-r from-yellow-500/20 to-yellow-600/20 border-2 border-yellow-500/40 hover:border-yellow-400/60"
                      : "bg-white/5 border border-white/10 hover:border-white/20"
                  }`}
                  onClick={() => onSelectDeck(deck.id)}
                  data-testid={`deck-item-${deck.id}`}
                >
                  <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-5 w-5 p-0"
                      onClick={(e) => handleExportDeck(e, deck)}
                      title="Export this deck"
                      data-testid={`export-deck-${deck.id}`}
                    >
                      <Download className="w-2 h-2" />
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-5 w-5 p-0"
                      onClick={(e) => handleCopyDeckId(e, deck)}
                      title="Copy deck id for bind_workspace"
                    >
                      <Copy className="w-2 h-2" />
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="h-5 w-5 p-0 bg-red-500/80 hover:bg-red-500 border-red-400"
                      onClick={(e) => handleDeleteDeck(e, deck.id)}
                      title="Delete deck"
                    >
                      <Trash2 className="w-2 h-2" />
                    </Button>
                  </div>

                  <div>
                    <h3
                      className={`font-semibold text-sm pr-16 ${isEditing ? "text-yellow-300" : "text-white"}`}
                    >
                      {deck.name}
                    </h3>
                    <p className="text-xs text-gray-400 select-none pointer-events-none">
                      {subtitle}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <Dialog open={createModalOpen} onOpenChange={setCreateModalOpen}>
        <DialogContent className="sm:max-w-md border-border bg-[#161612] text-[#E8F6F4]">
          <DialogHeader>
            <DialogTitle className="flex items-center text-xl font-bold">
              <Layers className="mr-2 h-5 w-5" style={{ color: "#92E4DD" }} />
              Create New Deck
            </DialogTitle>
          </DialogHeader>

          <form onSubmit={handleCreateDeck} className="space-y-4" data-testid="form-create-deck">
            <div className="space-y-2">
              <Label htmlFor="deckName">Deck Name</Label>
              <Input
                id="deckName"
                placeholder="e.g., Hiring stack"
                value={newDeckName}
                onChange={(e) => setNewDeckName(e.target.value)}
                className="border-white/15 bg-[#0F0F0C] text-[#E8F6F4] placeholder:text-[#A8C4C0]/60"
                required
                data-testid="input-deck-name"
              />
            </div>

            <div className="flex gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1 rounded-full border-white/20 text-[#E8F6F4] hover:bg-white/10"
                onClick={() => setCreateModalOpen(false)}
                data-testid="button-cancel-create"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="flex-1 rounded-full border px-6 text-sm font-semibold hover:opacity-90"
                style={{
                  background: "#C4B643",
                  borderColor: "#C4B643",
                  color: "black",
                }}
                disabled={createDeckMutation.isPending}
                data-testid="button-submit-create"
              >
                {createDeckMutation.isPending ? "Creating…" : "Create Deck"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
