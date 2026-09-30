# NOT-302 visual QA — star legibility (round 3)

## Method

No browser can launch inside the execution sandbox (headless Chrome
SIGABRTs on init, WebKit XPC helpers are blocked, `open`/QuickLook are
denied), so full-page screenshots of the Collection grid were not
obtainable here. Instead this pass verifies the star marks with exact
geometry + real rasterized pixels:

- The star polygon is the verbatim Lucide `Star` path from the pinned
  `lucide-react@0.453.0` (`points="12 2 15.09 8.26 22 9.27 17 14.14
  18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"`,
  `fill="none" stroke="currentColor" stroke-width="2"`,
  round caps/joins, 24x24 viewBox).
- Rendered with the exact `CardUsageMark` geometry from
  `apps/agent-deck/src/components/card-usage-mark.tsx`: 8px glyph box
  (`h-2 w-2`), 1px gap, group `scale(0.75)` (was `scale(0.56)`),
  `stroke-width` 2 filled / 2.5 outline, `opacity-60` card-palette color
  on a dark card face — via in-process CoreGraphics (`/tmp` scratch,
  not committed).
- Text references use the real component sizes (NEW `text-[7px]`
  semibold, type badge `text-[8px]`, title/corner `text-xs` 12px bold)
  with a fallback system font (Google Fonts are unreachable offline;
  cap-height relationships hold across the stack).

## Measurements (CSS px)

| mark | group box | ink bbox | coverage |
|---|---|---|---|
| popular, new (3 filled, 0.75) | 19.50 x 6.00 | 19.00 x 5.25 | 39% |
| used, new (1 filled, 0.75) | 6.00 x 6.00 | 5.50 x 5.25 | 43% |
| unused, new (1 outline 2.5, 0.75) | 6.00 x 6.00 | 5.67 x 5.42 | 32% |
| used, old (1 filled, 0.56) | 4.48 x 4.48 | 4.17 x 4.00 | 43% |

Effective stroke: 0.500px new filled (was 0.373px), 0.625px outline.
That is ~6px apparent, up from ~4.5px, as specified.

## Verdict

- Stars are clearly scannable at 1x; the outline mark stays the
  faintest by design but is 34% larger than before (see
  `qa-stars-closeup.png`).
- Prominence hierarchy holds: 6px star group < 7px NEW < 8px type
  badge < 12px bold title/corner marks (see `qa-stars-sheet.png`).
- Unchanged by code inspection: muted color at `opacity-60`, 1px gap,
  top-right placement (`transform-origin: top right`), tooltip/ARIA
  copy, and the hover/focus delete swap (covered by
  `card-usage-mark.test.tsx`).
- Toolbar: the Sort select reuses the exact Type-select sizing
  (`w-[7.5rem] h-8`) inside the existing `flex flex-wrap` toolbar, so
  at 320px it wraps to a second row exactly like the current controls
  instead of overflowing.

## Left for human eyes

Full-page composition at desktop width and 320px (grid rhythm with
real cards, toolbar wrap with real labels) still wants one manual
pass in a real browser, since this sandbox cannot launch one. Suggested
30-second check: open My Collection with mixed cards, confirm the star
marks read at a glance without competing with titles, switch the Sort
select through Default / Most used / Least used at 1280px and 320px.
