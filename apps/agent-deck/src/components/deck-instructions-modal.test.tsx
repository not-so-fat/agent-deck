import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Deck } from "@agent-deck/shared";
import { OPERATING_INSTRUCTIONS_MAX_LENGTH } from "@agent-deck/shared";

import DeckBuilder from "@/components/deck-builder";
import DeckManagementPanel from "@/components/deck-management-panel";
import {
  DECK_INSTRUCTIONS_DISCARD_MESSAGE,
} from "@/components/deck-instructions-modal";
import Home from "@/pages/home";
import { getQueryFn } from "@/lib/queryClient";

const { mockToast } = vi.hoisted(() => ({ mockToast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toasts: [], toast: mockToast, dismiss: vi.fn() }),
}));

const DECK_A_ID = "11111111-1111-4111-8111-111111111111";
const DECK_B_ID = "22222222-2222-4222-8222-222222222222";

const ALPHA_SAVED = "## Alpha rules\nPrefer pnpm.\n";
const BETA_SAVED = "Beta runs the demo stack.\n";

function makeDeck(overrides: Partial<Deck> & { id: string; name: string }): Deck {
  return {
    isActive: false,
    operatingInstructions: "",
    services: [],
    credentials: [],
    playbooks: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

interface ServerState {
  decks: Deck[];
  /** When set, PUT /api/decks/:id fails with this error message. */
  failPutWith?: string;
}

interface SeenRequests {
  puts: Array<{ url: string; body: unknown }>;
  deckGets: number;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function normalizeLikeServer(value: string): string {
  if (value === "" || value === "\n") {
    return "";
  }
  return value.endsWith("\n") ? value : `${value}\n`;
}

function mockDeckEndpoints(server: ServerState, seen: SeenRequests) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/decks" && method === "GET") {
      seen.deckGets += 1;
      return jsonResponse({ success: true, data: server.decks });
    }
    if (url.startsWith("/api/decks/") && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.puts.push({ url, body });
      if (server.failPutWith) {
        return jsonResponse({ success: false, error: server.failPutWith }, 500);
      }
      // Mirror the real server: the 16,000-character bound applies to the
      // normalized form, so 16,000 chars without a newline are rejected.
      const normalized = normalizeLikeServer(
        String(body.operatingInstructions ?? ""),
      );
      if (normalized.length > OPERATING_INSTRUCTIONS_MAX_LENGTH) {
        return jsonResponse(
          {
            success: false,
            error:
              "Deck operating instructions must be at most 16,000 characters",
          },
          400,
        );
      }
      const id = url.split("/")[3];
      const target = server.decks.find((deck) => deck.id === id);
      if (!target) {
        return jsonResponse({ success: false, error: "Deck not found" }, 404);
      }
      target.operatingInstructions = normalized;
      target.updatedAt = new Date().toISOString();
      return jsonResponse({ success: true, data: target });
    }
    if (url === "/api/scope/bindings") {
      return jsonResponse({ success: true, data: [] });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
}

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { queryFn: getQueryFn({ on401: "throw" }), retry: false },
      mutations: { retry: false },
    },
  });
}

/**
 * Minimal My Decks composition: the real deck list panel plus the real
 * selected-deck builder, with the same unsaved-draft switch guard Home uses.
 */
function Harness() {
  const { data } = useQuery<{ success: boolean; data: Deck[] }>({
    queryKey: ["/api/decks"],
  });
  const decks = data?.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const currentId = selectedId ?? decks[0]?.id ?? null;
  const deck = decks.find((candidate) => candidate.id === currentId) ?? null;

  const select = (id: string) => {
    if (id !== currentId && dirty && !window.confirm(DECK_INSTRUCTIONS_DISCARD_MESSAGE)) {
      return;
    }
    setSelectedId(id);
  };

  if (!deck) {
    return <p>Loading decks…</p>;
  }
  const noop = () => {};
  return (
    <div>
      <DeckManagementPanel
        decks={decks}
        editingDeckId={deck.id}
        onSelectDeck={select}
        isLoading={false}
      />
      <DeckBuilder
        deck={deck}
        services={[]}
        allServices={[]}
        onDrop={noop}
        onDragStart={noop}
        onCredentialDragStart={noop}
        onPlaybookDragStart={noop}
        onDragEnd={noop}
        onInstructionsDirtyChange={setDirty}
      />
    </div>
  );
}

function renderHarness() {
  return render(
    <QueryClientProvider client={makeClient()}>
      <Harness />
    </QueryClientProvider>,
  );
}

function twoDeckServer(): ServerState {
  return {
    decks: [
      makeDeck({ id: DECK_A_ID, name: "Alpha", operatingInstructions: ALPHA_SAVED }),
      makeDeck({ id: DECK_B_ID, name: "Beta", operatingInstructions: BETA_SAVED }),
    ],
  };
}

async function openInstructions(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByTestId("button-deck-instructions"));
  return screen.findByTestId("deck-instructions-modal");
}

const confirmSpies: Array<{ mockRestore: () => void }> = [];

function stubConfirm(value: boolean) {
  const spy = vi.spyOn(window, "confirm").mockReturnValue(value);
  confirmSpies.push(spy);
  return spy;
}

beforeEach(() => {
  vi.mocked(fetch).mockReset();
  mockToast.mockClear();
  localStorage.clear();
});

afterEach(() => {
  // Restore only the confirm spies: a blanket restoreAllMocks would also
  // strip the global WebSocket/fetch mock implementations from test setup.
  for (const spy of confirmSpies.splice(0)) {
    spy.mockRestore();
  }
});

describe("Deck instructions modal (NOT-376)", () => {
  it("exposes an Instructions action beside the deck name without adding list cards", async () => {
    const server = twoDeckServer();
    const seen: SeenRequests = { puts: [], deckGets: 0 };
    mockDeckEndpoints(server, seen);
    renderHarness();

    const action = await screen.findByTestId("button-deck-instructions");
    expect(action).toHaveTextContent("Instructions");
    // The header keeps its existing controls; the action sits beside them.
    expect(screen.getByTestId("button-rename-deck")).toHaveTextContent("Alpha");
    expect(screen.getByTestId("deck-drop-zone")).toBeInTheDocument();
    // The My Decks list gains no instruction card or text block.
    expect(screen.getAllByTestId(/deck-item-/)).toHaveLength(2);
  });

  it("opens an empty-state modal with guidance, counter, Save, and Cancel", async () => {
    const server: ServerState = {
      decks: [makeDeck({ id: DECK_A_ID, name: "Alpha", operatingInstructions: "" })],
    };
    const seen: SeenRequests = { puts: [], deckGets: 0 };
    mockDeckEndpoints(server, seen);
    renderHarness();

    const modal = await openInstructions();
    expect(within(modal).getByText("Deck instructions")).toBeInTheDocument();
    expect(within(modal).getByTestId("input-deck-instructions")).toHaveValue("");
    expect(within(modal).getByTestId("deck-instructions-count")).toHaveTextContent(
      "0 / 16,000",
    );
    // Empty is a supported state, so an unchanged empty draft cannot save.
    expect(within(modal).getByTestId("button-save-deck-instructions")).toBeDisabled();
    expect(
      within(modal).getByTestId("button-cancel-deck-instructions"),
    ).toBeInTheDocument();
    expect(within(modal).getByText(/agent sessions using Alpha/)).toBeInTheDocument();
    expect(within(modal).getByText(/Git-synced deck file/)).toBeInTheDocument();
    expect(
      within(modal).getByText(/cannot override host safety or authorization/),
    ).toBeInTheDocument();
    expect(
      within(modal).getByText(/does not rewrite active host system prompts/),
    ).toBeInTheDocument();
    expect(
      within(modal).getByText(/next supported session-context refresh/),
    ).toBeInTheDocument();
  });

  it("prefills the saved Markdown and enables Save only once edited", async () => {
    const server = twoDeckServer();
    const seen: SeenRequests = { puts: [], deckGets: 0 };
    mockDeckEndpoints(server, seen);
    renderHarness();

    const modal = await openInstructions();
    const textarea = within(modal).getByTestId("input-deck-instructions");
    const save = within(modal).getByTestId("button-save-deck-instructions");
    expect(textarea).toHaveValue(ALPHA_SAVED);
    expect(within(modal).getByTestId("deck-instructions-count")).toHaveTextContent(
      `${ALPHA_SAVED.length} / 16,000`,
    );
    expect(save).toBeDisabled();

    fireEvent.change(textarea, { target: { value: `${ALPHA_SAVED}More.\n` } });
    expect(save).toBeEnabled();

    fireEvent.change(textarea, { target: { value: ALPHA_SAVED } });
    expect(save).toBeDisabled();
  });

  it("saves only operatingInstructions, refreshes the deck query, and reopens with the saved value", async () => {
    const server = twoDeckServer();
    const seen: SeenRequests = { puts: [], deckGets: 0 };
    mockDeckEndpoints(server, seen);
    renderHarness();

    const modal = await openInstructions();
    const textarea = within(modal).getByTestId("input-deck-instructions");
    fireEvent.change(textarea, { target: { value: "Ship it" } });
    fireEvent.click(within(modal).getByTestId("button-save-deck-instructions"));

    await waitFor(() => expect(seen.puts).toHaveLength(1));
    expect(seen.puts[0].url).toBe(`/api/decks/${DECK_A_ID}`);
    expect(seen.puts[0].body).toEqual({ operatingInstructions: "Ship it" });
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Deck instructions saved" }),
      ),
    );
    // The save invalidates the deck query, so the list refetches.
    await waitFor(() => expect(seen.deckGets).toBeGreaterThanOrEqual(2));
    await waitFor(() =>
      expect(screen.queryByTestId("deck-instructions-modal")).not.toBeInTheDocument(),
    );

    const reopened = await openInstructions();
    expect(
      within(reopened).getByTestId("input-deck-instructions"),
    ).toHaveValue("Ship it\n");
  });

  it("enforces the normalized bound: 15,999 allowed, 16,000 without a newline blocked", async () => {
    expect(OPERATING_INSTRUCTIONS_MAX_LENGTH).toBe(16_000);
    const server = twoDeckServer();
    const seen: SeenRequests = { puts: [], deckGets: 0 };
    mockDeckEndpoints(server, seen);
    renderHarness();

    const modal = await openInstructions();
    const textarea = within(modal).getByTestId("input-deck-instructions");
    const save = within(modal).getByTestId("button-save-deck-instructions");

    // 16,001 raw chars normalize to 16,002: blocked.
    fireEvent.change(textarea, {
      target: { value: "x".repeat(OPERATING_INSTRUCTIONS_MAX_LENGTH + 1) },
    });
    expect(within(modal).getByTestId("deck-instructions-count")).toHaveTextContent(
      "16,002 / 16,000",
    );
    expect(
      within(modal).getByTestId("deck-instructions-over-limit"),
    ).toBeInTheDocument();
    expect(save).toBeDisabled();
    expect(seen.puts).toHaveLength(0);

    // 16,000 raw chars without a trailing newline normalize to 16,001, which
    // the server rejects: blocked client-side so it cannot be submitted.
    fireEvent.change(textarea, {
      target: { value: "x".repeat(OPERATING_INSTRUCTIONS_MAX_LENGTH) },
    });
    expect(within(modal).getByTestId("deck-instructions-count")).toHaveTextContent(
      "16,001 / 16,000",
    );
    expect(
      within(modal).getByTestId("deck-instructions-over-limit"),
    ).toBeInTheDocument();
    expect(save).toBeDisabled();
    expect(seen.puts).toHaveLength(0);

    // 15,999 chars normalize to exactly 16,000: allowed.
    fireEvent.change(textarea, {
      target: { value: "x".repeat(OPERATING_INSTRUCTIONS_MAX_LENGTH - 1) },
    });
    expect(within(modal).getByTestId("deck-instructions-count")).toHaveTextContent(
      "16,000 / 16,000",
    );
    expect(
      within(modal).queryByTestId("deck-instructions-over-limit"),
    ).not.toBeInTheDocument();
    expect(save).toBeEnabled();

    // 15,999 chars plus the trailing newline itself (16,000 stored): allowed.
    fireEvent.change(textarea, {
      target: {
        value: `${"x".repeat(OPERATING_INSTRUCTIONS_MAX_LENGTH - 1)}\n`,
      },
    });
    expect(within(modal).getByTestId("deck-instructions-count")).toHaveTextContent(
      "16,000 / 16,000",
    );
    expect(
      within(modal).queryByTestId("deck-instructions-over-limit"),
    ).not.toBeInTheDocument();
    expect(save).toBeEnabled();
  });

  it("preserves the draft and shows an actionable toast when the save is rejected", async () => {
    const server = twoDeckServer();
    server.failPutWith = "database is locked";
    const seen: SeenRequests = { puts: [], deckGets: 0 };
    mockDeckEndpoints(server, seen);
    renderHarness();

    const modal = await openInstructions();
    const textarea = within(modal).getByTestId("input-deck-instructions");
    fireEvent.change(textarea, { target: { value: "Keep me" } });
    fireEvent.click(within(modal).getByTestId("button-save-deck-instructions"));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Could not save deck instructions",
          description: expect.stringContaining("database is locked"),
          variant: "destructive",
        }),
      ),
    );
    // The failed save neither closes the modal nor loses the draft.
    expect(screen.getByTestId("deck-instructions-modal")).toBeInTheDocument();
    expect(screen.getByTestId("input-deck-instructions")).toHaveValue("Keep me");
  });

  it("requires confirmation before discarding a draft on close", async () => {
    const server = twoDeckServer();
    const seen: SeenRequests = { puts: [], deckGets: 0 };
    mockDeckEndpoints(server, seen);
    renderHarness();

    const modal = await openInstructions();
    const textarea = within(modal).getByTestId("input-deck-instructions");
    fireEvent.change(textarea, { target: { value: "Draft me" } });

    const confirm = stubConfirm(false);
    fireEvent.click(within(modal).getByTestId("button-cancel-deck-instructions"));
    expect(confirm).toHaveBeenCalledWith(DECK_INSTRUCTIONS_DISCARD_MESSAGE);
    expect(screen.getByTestId("deck-instructions-modal")).toBeInTheDocument();
    expect(screen.getByTestId("input-deck-instructions")).toHaveValue("Draft me");

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByTestId("button-cancel-deck-instructions"));
    await waitFor(() =>
      expect(screen.queryByTestId("deck-instructions-modal")).not.toBeInTheDocument(),
    );

    const reopened = await openInstructions();
    expect(within(reopened).getByTestId("input-deck-instructions")).toHaveValue(
      ALPHA_SAVED,
    );
  });

  it("requires confirmation when switching decks with an unsaved draft", async () => {
    const server = twoDeckServer();
    const seen: SeenRequests = { puts: [], deckGets: 0 };
    mockDeckEndpoints(server, seen);
    renderHarness();

    const modal = await openInstructions();
    fireEvent.change(within(modal).getByTestId("input-deck-instructions"), {
      target: { value: `${ALPHA_SAVED}Unscheduled.\n` },
    });

    const confirm = stubConfirm(false);
    fireEvent.click(screen.getByTestId(`deck-item-${DECK_B_ID}`));
    expect(confirm).toHaveBeenCalledWith(DECK_INSTRUCTIONS_DISCARD_MESSAGE);
    // Declining keeps the selected deck and the draft.
    expect(screen.getByTestId("button-rename-deck")).toHaveTextContent("Alpha");
    expect(screen.getByTestId("deck-instructions-modal")).toBeInTheDocument();
    expect(screen.getByTestId("input-deck-instructions")).toHaveValue(
      `${ALPHA_SAVED}Unscheduled.\n`,
    );

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByTestId(`deck-item-${DECK_B_ID}`));
    await waitFor(() =>
      expect(screen.getByTestId("button-rename-deck")).toHaveTextContent("Beta"),
    );
    // Accepting switches decks and shows only the new deck's instructions.
    expect(screen.getByTestId("input-deck-instructions")).toHaveValue(BETA_SAVED);
  });

  it("runs the full flow from the real My Decks page", async () => {
    const server = twoDeckServer();
    const seen: SeenRequests = { puts: [], deckGets: 0 };
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/decks" && method === "GET") {
        seen.deckGets += 1;
        return jsonResponse({ success: true, data: server.decks });
      }
      if (url.startsWith("/api/decks/") && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        seen.puts.push({ url, body });
        const target = server.decks.find((deck) => deck.id === url.split("/")[3]);
        if (target) {
          target.operatingInstructions = normalizeLikeServer(
            String(body.operatingInstructions ?? ""),
          );
        }
        return jsonResponse({ success: true, data: target });
      }
      if (url === "/api/services") {
        return jsonResponse({ success: true, data: [] });
      }
      if (url === "/api/credentials/vault") {
        return jsonResponse({ success: true, data: [] });
      }
      if (url === "/api/playbooks/vault") {
        return jsonResponse({ success: true, data: [] });
      }
      if (url === "/api/collection/warnings") {
        return jsonResponse({
          success: true,
          data: {
            total: 0,
            byKind: {},
            services: {},
            credentials: {},
            playbooks: {},
          },
        });
      }
      if (url === "/api/usage/cards") {
        return jsonResponse({ success: true, data: { cards: [] } });
      }
      if (url === "/api/playbook-patches?status=proposed") {
        return jsonResponse({ success: true, data: [] });
      }
      if (url === "/api/feedback-signals/count?available=1") {
        return jsonResponse({ success: true, data: { open: 0 } });
      }
      if (url === "/api/dashboard-auth/context") {
        return jsonResponse({ success: true, data: { hosted: false } });
      }
      if (url === "/api/scope/bindings") {
        return jsonResponse({ success: true, data: [] });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    render(
      <QueryClientProvider client={makeClient()}>
        <Home />
      </QueryClientProvider>,
    );

    const modal = await openInstructions();
    fireEvent.change(within(modal).getByTestId("input-deck-instructions"), {
      target: { value: "From the home page" },
    });
    fireEvent.click(within(modal).getByTestId("button-save-deck-instructions"));

    await waitFor(() => expect(seen.puts).toHaveLength(1));
    expect(seen.puts[0].body).toEqual({ operatingInstructions: "From the home page" });
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Deck instructions saved" }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("deck-instructions-modal")).not.toBeInTheDocument(),
    );

    // The home page guards deck switches with the same confirmation.
    const reopened = await openInstructions();
    fireEvent.change(within(reopened).getByTestId("input-deck-instructions"), {
      target: { value: "Unsaved home draft" },
    });
    const confirm = stubConfirm(false);
    fireEvent.click(screen.getByTestId(`deck-item-${DECK_B_ID}`));
    expect(confirm).toHaveBeenCalledWith(DECK_INSTRUCTIONS_DISCARD_MESSAGE);
    expect(screen.getByTestId("button-rename-deck")).toHaveTextContent("Alpha");

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByTestId(`deck-item-${DECK_B_ID}`));
    await waitFor(() =>
      expect(screen.getByTestId("button-rename-deck")).toHaveTextContent("Beta"),
    );
  });
});
