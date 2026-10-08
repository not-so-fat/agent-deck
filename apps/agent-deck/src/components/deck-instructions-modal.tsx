import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Deck,
  OPERATING_INSTRUCTIONS_MAX_LENGTH,
  normalizeOperatingInstructions,
} from "@agent-deck/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

/**
 * Confirmation text shared by the modal close path and the My Decks
 * deck-switch guard so both read as one discard decision.
 */
export const DECK_INSTRUCTIONS_DISCARD_MESSAGE =
  "You have unsaved deck instructions. Discard them?";

interface DeckInstructionsModalProps {
  deck: Deck;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Reports open-and-dirty state so the parent can guard deck switches. */
  onDirtyChange?: (dirty: boolean) => void;
}

export default function DeckInstructionsModal({
  deck,
  open,
  onOpenChange,
  onDirtyChange,
}: DeckInstructionsModalProps) {
  const saved = deck.operatingInstructions ?? "";
  const [draft, setDraft] = useState(saved);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Prefill from the saved value whenever the modal opens or the selected
  // deck changes. The saved value is intentionally not a dependency: a
  // background refetch of the same deck must not clobber an in-progress
  // draft.
  useEffect(() => {
    if (open) {
      setDraft(deck.operatingInstructions ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, deck.id]);

  const dirty = open && draft !== saved;
  // The server validates the normalized form (non-empty drafts gain a
  // trailing newline), so the counter and the limit check must use the
  // normalized length: 16,000 chars without a newline is already over.
  const normalizedLength = normalizeOperatingInstructions(draft).length;
  const overLimit = normalizedLength > OPERATING_INSTRUCTIONS_MAX_LENGTH;

  useEffect(() => {
    onDirtyChange?.(dirty);
    // Clear the parent's guard if this modal unmounts with a draft unsaved
    // (e.g. the deck is deleted), so later deck switches never prompt needlessly.
    return () => {
      onDirtyChange?.(false);
    };
  }, [dirty, onDirtyChange]);

  const saveMutation = useMutation({
    mutationFn: async (value: string) => {
      const response = await apiRequest("PUT", `/api/decks/${deck.id}`, {
        operatingInstructions: value,
      });
      return response.json() as Promise<{
        success: boolean;
        data?: Deck;
        error?: string;
      }>;
    },
    onSuccess: async (body, value) => {
      if (!body.success) {
        // A 200 with success:false never reaches onError, so report it here
        // and keep the draft for retry, same as a rejected save.
        toast({
          title: "Could not save deck instructions",
          description: body.error || "Save failed",
          variant: "destructive",
        });
        return;
      }
      // The server normalizes the stored form (trailing newline), so track
      // the returned value until the invalidated query refetches.
      setDraft(body.data?.operatingInstructions ?? value);
      // Await the refetch before closing so an immediate reopen prefills the
      // saved value instead of the stale one the query still holds.
      await queryClient
        .invalidateQueries({ queryKey: ["/api/decks"] })
        .catch(() => {});
      toast({
        title: "Deck instructions saved",
        description: `New sessions using ${deck.name} will receive the updated instructions.`,
      });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      // The draft is intentionally preserved so the user can retry.
      toast({
        title: "Could not save deck instructions",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const requestClose = () => {
    if (draft !== saved && !window.confirm(DECK_INSTRUCTIONS_DISCARD_MESSAGE)) {
      return;
    }
    setDraft(saved);
    onOpenChange(false);
  };

  const limitLabel = OPERATING_INSTRUCTIONS_MAX_LENGTH.toLocaleString("en-US");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          requestClose();
        }
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto border-white/10 bg-[#161612] text-[#E8F6F4] sm:max-w-2xl"
        data-testid="deck-instructions-modal"
      >
        <DialogHeader>
          <DialogTitle>Deck instructions</DialogTitle>
          <DialogDescription className="text-[#A8C4C0]">
            Markdown instructions for agent sessions using {deck.name}. They are
            stored in this deck&apos;s Git-synced deck file and cannot override
            host safety or authorization policy.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="deck-instructions">Instructions (Markdown)</Label>
            <span
              className={`shrink-0 text-xs tabular-nums ${overLimit ? "font-semibold text-red-400" : "text-gray-400"}`}
              data-testid="deck-instructions-count"
            >
              {normalizedLength.toLocaleString("en-US")} / {limitLabel}
            </span>
          </div>
          <Textarea
            id="deck-instructions"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={"e.g. Prefer pnpm. Never push without asking.\n\nLeave empty for no deck instructions."}
            rows={12}
            aria-label="Deck instructions (Markdown)"
            data-testid="input-deck-instructions"
            className="min-h-48 border-white/15 bg-[#0F0F0C] font-mono text-sm text-[#E8F6F4] placeholder:text-[#A8C4C0]/60"
          />
          {overLimit && (
            <p className="text-sm text-red-400" data-testid="deck-instructions-over-limit">
              Instructions exceed the {limitLabel}-character limit and cannot be
              saved. Non-empty instructions are stored with a trailing newline,
              which counts toward the limit.
            </p>
          )}
          <p className="text-xs text-gray-400">
            Saving does not rewrite active host system prompts. New sessions —
            and existing sessions on their next supported session-context
            refresh — receive the saved value.
          </p>
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={requestClose}
            data-testid="button-cancel-deck-instructions"
            className="rounded-full border-white/20 text-[#E8F6F4] hover:bg-white/10"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => saveMutation.mutate(draft)}
            disabled={draft === saved || overLimit || saveMutation.isPending}
            data-testid="button-save-deck-instructions"
            className="rounded-full border px-6 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
            style={{
              background: "#C4B643",
              borderColor: "#C4B643",
              color: "black",
            }}
          >
            {saveMutation.isPending ? "Saving…" : "Save instructions"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
