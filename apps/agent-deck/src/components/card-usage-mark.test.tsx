import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Credential, Playbook, Service } from "@agent-deck/shared";

import { CardActionArea, CardUsageMark } from "@/components/card-usage-mark";
import CardComponent from "@/components/card-component";
import CredentialCardComponent from "@/components/credential-card-component";
import PlaybookCardComponent from "@/components/playbook-card-component";
import type { CardUsageCardSummary } from "@/lib/card-usage";
import { createTestWrapper } from "@/test/setup";

const WINDOW_END = "2026-09-30T00:00:00.000Z";
const WINDOW_START = "2026-08-31T00:00:00.000Z";
const OLD = "2026-08-01T00:00:00.000Z";
const COLOR = "#92E4DD";

function row(overrides: Partial<CardUsageCardSummary>): CardUsageCardSummary {
  return {
    cardType: "service",
    cardId: "svc-1",
    category: "used",
    usageCount: 1,
    lastUsedAt: null,
    observedSince: OLD,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    ...overrides,
  };
}

const service: Service = {
  id: "svc-1",
  name: "GitHub",
  type: "mcp",
  url: "http://127.0.0.1:9/mcp",
  health: "unknown",
  cardColor: COLOR,
  disabledToolNames: [],
  isConnected: false,
  registeredAt: OLD,
  updatedAt: OLD,
};

const credential: Credential = {
  id: "cred_test",
  label: "Test key",
  scheme: "bearer",
  envName: "TEST_API_KEY",
  keychainAccount: "cred_test",
  tags: [],
  hasSecret: true,
  createdAt: OLD,
  updatedAt: OLD,
};

const playbook: Playbook = {
  id: "pb_test",
  title: "Test playbook",
  body: "",
  triggers: [],
  dependsOnCredentialIds: [],
  dependsOnServiceIds: [],
  createdAt: OLD,
  updatedAt: OLD,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fetch).mockClear();
});

function starFills(mark: HTMLElement): (string | null)[] {
  return Array.from(mark.querySelectorAll("svg")).map((svg) =>
    svg.getAttribute("fill"),
  );
}

describe("CardUsageMark (NOT-294)", () => {
  it("renders 3 filled stars for popular with the exact label and tooltip", () => {
    render(<CardUsageMark usage={row({ category: "popular", usageCount: 5 })} color={COLOR} />);

    const mark = screen.getByTestId("card-usage-mark");
    expect(mark).toHaveAttribute("data-category", "popular");
    expect(starFills(mark)).toEqual(["currentColor", "currentColor", "currentColor"]);
    expect(mark).toHaveAttribute("aria-label", "Popular · 5 uses in 30 days");
    expect(mark).toHaveAttribute("title", "Popular · 5 uses in 30 days");
    expect(screen.getByRole("img", { name: "Popular · 5 uses in 30 days" })).toBeInTheDocument();
  });

  it("renders 1 filled star for used", () => {
    render(<CardUsageMark usage={row({ category: "used", usageCount: 1 })} color={COLOR} />);

    const mark = screen.getByTestId("card-usage-mark");
    expect(mark).toHaveAttribute("data-category", "used");
    expect(starFills(mark)).toEqual(["currentColor"]);
    expect(mark).toHaveAttribute("aria-label", "Used · 1 uses in 30 days");
    expect(mark).toHaveAttribute("title", "Used · 1 uses in 30 days");
  });

  it("renders 1 outline star for unused", () => {
    render(<CardUsageMark usage={row({ category: "unused", usageCount: 0 })} color={COLOR} />);

    const mark = screen.getByTestId("card-usage-mark");
    expect(mark).toHaveAttribute("data-category", "unused");
    expect(starFills(mark)).toEqual(["none"]);
    expect(mark).toHaveAttribute("aria-label", "Unused · 0 uses in 30 days");
    expect(mark).toHaveAttribute("title", "Unused · 0 uses in 30 days");
  });

  it("renders a compact NEW mark with card-age tracking copy", () => {
    render(
      <CardUsageMark
        usage={row({ category: "new", usageCount: 0 })}
        createdAt="2026-09-20T00:00:00.000Z"
        color={COLOR}
      />,
    );

    const mark = screen.getByTestId("card-usage-mark");
    expect(mark).toHaveAttribute("data-category", "new");
    expect(mark).toHaveTextContent("New");
    expect(mark.querySelectorAll("svg")).toHaveLength(0);
    expect(mark).toHaveAttribute("aria-label", "New · tracking for 10 days");
    expect(mark).toHaveAttribute("title", "New · tracking for 10 days");
  });

  it("keeps the mark subtle and smaller than the top-left type label", () => {
    const { container } = render(
      <CardUsageMark usage={row({ category: "popular", usageCount: 5 })} color={COLOR} />,
    );

    const mark = screen.getByTestId("card-usage-mark");
    // Low visual emphasis via muted opacity on the existing card palette.
    expect(mark.className).toMatch(/opacity-60/);
    // 8px glyphs scaled to ~56% (~4.5px apparent), pinned top-right.
    expect(mark.style.transform).toBe("scale(0.56)");
    expect(mark.style.transformOrigin).toBe("top right");
    expect(container.querySelectorAll("svg")[0]).toHaveClass("h-2", "w-2");
  });

  it("omits the mark when usage is loading or failed (never infers unused)", () => {
    const { rerender } = render(<CardUsageMark usage={undefined} color={COLOR} />);
    expect(screen.queryByTestId("card-usage-mark")).not.toBeInTheDocument();

    rerender(<CardUsageMark usage={null} color={COLOR} />);
    expect(screen.queryByTestId("card-usage-mark")).not.toBeInTheDocument();
  });
});

describe("CardActionArea hover/focus swap (NOT-294)", () => {
  function renderArea(usage: CardUsageCardSummary | null | undefined) {
    const onDelete = vi.fn();
    const view = render(
      <div className="relative group">
        <CardActionArea
          usage={usage}
          createdAt={OLD}
          color={COLOR}
          onDelete={onDelete}
          deleteTitle="Delete thing"
        />
      </div>,
    );
    return { onDelete, ...view };
  }

  it("hides the mark on hover/focus-within and reveals delete without shifting layout", () => {
    renderArea(row({ category: "used", usageCount: 2 }));

    const usageSlot = screen.getByTestId("card-usage-slot");
    expect(usageSlot.className).toMatch(/group-hover:opacity-0/);
    expect(usageSlot.className).toMatch(/group-focus-within:opacity-0/);

    const deleteSlot = screen.getByTestId("card-delete-slot");
    expect(deleteSlot.className).toMatch(/absolute/);
    expect(deleteSlot.className).toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(deleteSlot.className).toMatch(/group-hover:opacity-100/);
    expect(deleteSlot.className).toMatch(/group-focus-within:opacity-100/);
  });

  it("keeps the delete action working and restores the mark slot", () => {
    const { onDelete } = renderArea(row({ category: "popular", usageCount: 5 }));

    const deleteButton = screen.getByTitle("Delete thing");
    fireEvent.click(deleteButton);
    expect(onDelete).toHaveBeenCalledTimes(1);
    // The mark is still in the DOM behind the hover state.
    expect(screen.getByTestId("card-usage-mark")).toBeInTheDocument();
  });

  it("leaves a functional delete action with no mark while loading or on error", () => {
    renderArea(undefined);

    expect(screen.queryByTestId("card-usage-mark")).not.toBeInTheDocument();
    expect(screen.queryByTestId("card-usage-slot")).not.toBeInTheDocument();
    expect(screen.getByTitle("Delete thing")).toBeInTheDocument();
  });
});

describe("Collection cards render the API category mark (NOT-294)", () => {
  it("service card shows 3 filled stars for popular", () => {
    render(
      <CardComponent
        service={service}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        isInActiveDeck={false}
        isInCollection
        usage={row({ cardType: "service", cardId: "svc-1", category: "popular", usageCount: 5 })}
      />,
      { wrapper: createTestWrapper() },
    );

    const card = screen.getByTestId("card-svc-1");
    const mark = within(card).getByTestId("card-usage-mark");
    expect(mark).toHaveAttribute("data-category", "popular");
    expect(starFills(mark)).toHaveLength(3);
  });

  it("credential card shows the NEW mark", () => {
    render(
      <CredentialCardComponent
        credential={credential}
        isInActiveDeck={false}
        isInCollection
        usage={row({
          cardType: "credential",
          cardId: "cred_test",
          category: "new",
          usageCount: 0,
        })}
      />,
      { wrapper: createTestWrapper() },
    );

    const card = screen.getByTestId("card-cred_test");
    const mark = within(card).getByTestId("card-usage-mark");
    expect(mark).toHaveAttribute("data-category", "new");
    expect(mark).toHaveTextContent("New");
  });

  it("playbook card shows 1 outline star for unused", () => {
    render(
      <PlaybookCardComponent
        playbook={playbook}
        isInActiveDeck={false}
        isInCollection
        usage={row({
          cardType: "playbook",
          cardId: "pb_test",
          category: "unused",
          usageCount: 0,
        })}
      />,
      { wrapper: createTestWrapper() },
    );

    const card = screen.getByTestId("card-pb_test");
    const mark = within(card).getByTestId("card-usage-mark");
    expect(mark).toHaveAttribute("data-category", "unused");
    expect(starFills(mark)).toEqual(["none"]);
  });

  it("cards omit the mark while usage is loading and keep delete working", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

    render(
      <CardComponent
        service={service}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        isInActiveDeck={false}
        isInCollection
        usage={undefined}
      />,
      { wrapper: createTestWrapper() },
    );

    const card = screen.getByTestId("card-svc-1");
    expect(within(card).queryByTestId("card-usage-mark")).not.toBeInTheDocument();

    // Settle the delete mutation (confirm -> DELETE -> toast/invalidate)
    // inside act so no state update escapes the test.
    await act(async () => {
      fireEvent.click(within(card).getByTitle("Delete GitHub"));
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/services/svc-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
