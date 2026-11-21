import {
  Children,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export const CARD_WIDTH = 128;
export const CARD_HEIGHT = 192;
export const CARD_OVERLAP = 48;
/** How many cards fit in the visible deck window at once. */
export const VISIBLE_CARD_SLOTS = 10;
export const FAN_HORIZONTAL_PAD_PX = 12;
const EDGE_ZONE_PX = 64;
const SCROLL_SPEED_MIN = 4;
const SCROLL_SPEED_MAX = 14;
const MAX_TILT_DEG = 12;
const HOVER_SCALE = 1.08;

/** Min wrapper height so tilted + scaled cards are not clipped vertically. */
export function fanCardSlotMinHeight(
  maxTiltDeg = MAX_TILT_DEG,
  hoverScale = HOVER_SCALE,
): number {
  const rad = (maxTiltDeg * Math.PI) / 180;
  const rotatedHeight =
    CARD_WIDTH * Math.sin(rad) + CARD_HEIGHT * Math.cos(rad);
  return Math.ceil(rotatedHeight * hoverScale) + 8;
}

export const FAN_SLOT_MIN_HEIGHT = fanCardSlotMinHeight();

interface DeckFanProps {
  cardCount: number;
  children: ReactNode;
}

export function fanContentWidth(cardCount: number, overlap = CARD_OVERLAP): number {
  if (cardCount === 0) {
    return 0;
  }
  return CARD_WIDTH + Math.max(0, cardCount - 1) * (CARD_WIDTH - overlap);
}

/** Viewport width including horizontal padding so the last card's edge is not clipped. */
export function fanViewportWidth(
  cardSlots = VISIBLE_CARD_SLOTS,
  overlap = CARD_OVERLAP,
  padPx = FAN_HORIZONTAL_PAD_PX,
): number {
  return fanContentWidth(cardSlots, overlap) + 2 * padPx;
}

export function fanScrollContentWidth(cardCount: number, overlap = CARD_OVERLAP): number {
  return fanContentWidth(cardCount, overlap) + 2 * FAN_HORIZONTAL_PAD_PX;
}

export const visibleFanWidth = fanViewportWidth();

export function tiltFromViewportPosition(
  cardCenterX: number,
  viewportLeft: number,
  viewportWidth: number,
  maxTilt = MAX_TILT_DEG,
): number {
  const centerX = viewportLeft + viewportWidth / 2;
  const halfWidth = viewportWidth / 2;
  if (halfWidth <= 0) {
    return 0;
  }
  const normalized = (cardCenterX - centerX) / halfWidth;
  return Math.max(-maxTilt, Math.min(maxTilt, normalized * maxTilt));
}

export function deckFanCardStyle(cardIndex: number) {
  return {
    flexShrink: 0 as const,
    marginLeft: cardIndex === 0 ? 0 : `-${CARD_OVERLAP}px`,
  };
}

export function deckFanCardZIndex(cardIndex: number, deckCards: number, hoveredIndex: number | null) {
  if (hoveredIndex === cardIndex) {
    return 999999;
  }
  return deckCards - cardIndex;
}

export default function DeckFan({ cardCount, children }: DeckFanProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const scrollSpeedRef = useRef(0);
  const rafRef = useRef<number | undefined>(undefined);
  const [needsEdgeScroll, setNeedsEdgeScroll] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [scrollingLeft, setScrollingLeft] = useState(false);
  const [scrollingRight, setScrollingRight] = useState(false);
  const scrollingLeftRef = useRef(false);
  const scrollingRightRef = useRef(false);

  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const hoveredIndexRef = useRef<number | null>(null);
  hoveredIndexRef.current = hoveredIndex;

  const updateCardTilts = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) {
      return;
    }
    const scrollRect = scroll.getBoundingClientRect();
    const activeHover = hoveredIndexRef.current;
    cardRefs.current.forEach((cardEl, index) => {
      if (!cardEl) {
        return;
      }
      const cardRect = cardEl.getBoundingClientRect();
      const cardCenterX = cardRect.left + cardRect.width / 2;
      const tilt =
        activeHover === index
          ? 0
          : tiltFromViewportPosition(cardCenterX, scrollRect.left, scrollRect.width);
      const scale = activeHover === index ? HOVER_SCALE : 1;
      cardEl.style.transform = `rotate(${tilt}deg) scale(${scale})`;
      cardEl.style.transformOrigin = "center center";
      cardEl.style.zIndex = String(deckFanCardZIndex(index, cardCount, activeHover));
    });
  }, [cardCount]);

  const scrollByStep = useCallback((direction: "left" | "right") => {
    const scroll = scrollRef.current;
    if (!scroll) {
      return;
    }
    const step = CARD_WIDTH - CARD_OVERLAP;
    scroll.scrollBy({
      left: direction === "left" ? -step : step,
      behavior: "smooth",
    });
  }, []);

  const updateScrollState = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) {
      return;
    }
    const contentWidth = fanScrollContentWidth(cardCount, CARD_OVERLAP);
    const overflow = contentWidth > scroll.clientWidth + 2;
    setNeedsEdgeScroll(overflow);
    setCanScrollLeft(overflow && scroll.scrollLeft > 4);
    setCanScrollRight(overflow && scroll.scrollLeft + scroll.clientWidth < scroll.scrollWidth - 4);
    updateCardTilts();
  }, [cardCount, updateCardTilts]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) {
      return;
    }
    updateScrollState();
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(scroll);
    scroll.addEventListener("scroll", updateScrollState, { passive: true });
    return () => {
      observer.disconnect();
      scroll.removeEventListener("scroll", updateScrollState);
    };
  }, [cardCount, updateScrollState]);

  useEffect(() => {
    const tick = () => {
      const el = scrollRef.current;
      const speed = scrollSpeedRef.current;
      if (el && speed !== 0) {
        el.scrollLeft += speed;
        updateCardTilts();
        const canLeft = el.scrollLeft > 4;
        const canRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
        setCanScrollLeft(canLeft);
        setCanScrollRight(canRight);
      }
      const left = speed < 0;
      const right = speed > 0;
      if (left !== scrollingLeftRef.current) {
        scrollingLeftRef.current = left;
        setScrollingLeft(left);
      }
      if (right !== scrollingRightRef.current) {
        scrollingRightRef.current = right;
        setScrollingRight(right);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== undefined) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [updateCardTilts]);

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el || !needsEdgeScroll) {
      scrollSpeedRef.current = 0;
      return;
    }
    const rect = el.getBoundingClientRect();
    const x = event.clientX - rect.left;

    if (x < EDGE_ZONE_PX && canScrollLeft) {
      const intensity = 1 - x / EDGE_ZONE_PX;
      scrollSpeedRef.current = -(
        SCROLL_SPEED_MIN + intensity * (SCROLL_SPEED_MAX - SCROLL_SPEED_MIN)
      );
    } else if (x > rect.width - EDGE_ZONE_PX && canScrollRight) {
      const intensity = 1 - (rect.width - x) / EDGE_ZONE_PX;
      scrollSpeedRef.current =
        SCROLL_SPEED_MIN + intensity * (SCROLL_SPEED_MAX - SCROLL_SPEED_MIN);
    } else {
      scrollSpeedRef.current = 0;
    }
    updateCardTilts();
  };

  const handleMouseLeave = () => {
    scrollSpeedRef.current = 0;
    scrollingLeftRef.current = false;
    scrollingRightRef.current = false;
    setScrollingLeft(false);
    setScrollingRight(false);
  };

  useLayoutEffect(() => {
    cardRefs.current.length = cardCount;
    updateCardTilts();
  }, [cardCount, hoveredIndex, updateCardTilts]);

  if (cardCount === 0) {
    return <>{children}</>;
  }

  const scrollButtonClass = (side: "left" | "right", scrolling: boolean) =>
    `absolute ${side === "left" ? "left-2" : "right-2"} top-1/2 z-30 -translate-y-1/2 rounded-full bg-gray-950/90 p-1.5 text-yellow-300 shadow-lg ring-1 ring-black/50 transition-all duration-150 hover:bg-gray-950 hover:ring-yellow-300/40 ${
      scrolling ? "scale-110" : "scale-100"
    }`;

  return (
    <div
      className="relative flex h-full w-full min-w-0 max-w-full items-center justify-center overflow-hidden"
      data-testid="deck-fan"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {needsEdgeScroll && canScrollLeft && (
        <button
          type="button"
          className={scrollButtonClass("left", scrollingLeft)}
          aria-label="Scroll deck left"
          data-testid="deck-scroll-left"
          onClick={() => scrollByStep("left")}
        >
          <ChevronLeft className="h-6 w-6" strokeWidth={2.5} />
        </button>
      )}
      {needsEdgeScroll && canScrollRight && (
        <button
          type="button"
          className={scrollButtonClass("right", scrollingRight)}
          aria-label="Scroll deck right"
          data-testid="deck-scroll-right"
          onClick={() => scrollByStep("right")}
        >
          <ChevronRight className="h-6 w-6" strokeWidth={2.5} />
        </button>
      )}

      <div
        ref={scrollRef}
        className="max-w-full overflow-x-auto overflow-y-visible [-ms-overflow-style:none] scrollbar-none [&::-webkit-scrollbar]:hidden"
        style={{
          width: visibleFanWidth,
          maxWidth: "100%",
        }}
      >
        <div
          className="flex items-center justify-start isolate group/fan"
          style={{
            minHeight: FAN_SLOT_MIN_HEIGHT,
            paddingLeft: FAN_HORIZONTAL_PAD_PX,
            paddingRight: FAN_HORIZONTAL_PAD_PX,
          }}
        >
          {Children.map(children, (child, index) => (
            <div
              key={child && typeof child === "object" && "key" in child ? child.key : index}
              ref={(el) => {
                cardRefs.current[index] = el;
              }}
              className="relative flex items-center justify-center transition-[transform,box-shadow] duration-500 will-change-transform"
              style={{
                ...deckFanCardStyle(index),
                minHeight: FAN_SLOT_MIN_HEIGHT,
              }}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
            >
              {child}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
