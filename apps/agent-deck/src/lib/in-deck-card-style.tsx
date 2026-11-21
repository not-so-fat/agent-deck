/** Collection cards already on the editing deck — readable overlap, clear selection. */
export function inDeckCollectionClass(isInDeck: boolean): string {
  if (!isInDeck) {
    return "";
  }
  return "ring-2 ring-inset ring-yellow-400/90 shadow-[0_0_10px_rgba(250,204,21,0.2)]";
}

export function InDeckCornerBadge() {
  return (
    <span className="absolute top-1.5 left-1/2 z-20 -translate-x-1/2 rounded bg-yellow-500 px-1 py-px text-[7px] font-bold uppercase tracking-wide text-black shadow-sm">
      In deck
    </span>
  );
}
