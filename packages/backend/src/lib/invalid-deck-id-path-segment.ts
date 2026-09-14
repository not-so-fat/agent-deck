/**
 * Fastify decodes path params, so `/decks/x%2Fy/playbooks` yields `deckId === "x/y"`
 * while the route-policy `[^/]+` still matched one encoded segment. Reject before scope checks.
 */
export function invalidDeckIdPathSegment(deckId: string): boolean {
  return deckId.includes('/');
}
