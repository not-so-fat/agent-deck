import matter from 'gray-matter';
import {
  StoreDeckSchema,
  normalizeOperatingInstructions,
  type StoreDeck,
} from '@agent-deck/shared';

function frontmatterFromDeck(deck: StoreDeck): Record<string, unknown> {
  return {
    id: deck.id,
    name: deck.name,
    serviceIds: deck.serviceIds,
    credentialIds: deck.credentialIds,
    playbookIds: deck.playbookIds,
    createdAt: deck.createdAt,
    updatedAt: deck.updatedAt,
  };
}

/**
 * Canonicalize a parsed Markdown body to the shared instructions form.
 *
 * gray-matter preserves the body verbatim (it only appends a trailing newline
 * on serialize when one is missing), so unlike the first draft of this codec
 * there is no leading newline to strip — stripping one corrupts bodies that
 * legitimately start with a blank line. The shared normalizer maps the
 * empty-file content (`'\n'`, and a hand-edited fence with no body `''`) to
 * `''` and appends the missing trailing newline otherwise, so
 * `parse(serialize(x))` is byte-identical to what SQLite stores.
 */
function normalizeDeckBody(content: string): string {
  return normalizeOperatingInstructions(content);
}

function frontmatterValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return undefined;
}

function frontmatterToDeck(
  data: Record<string, unknown>,
  body: string,
): StoreDeck {
  return StoreDeckSchema.parse({
    id: data.id,
    name: data.name,
    serviceIds: data.serviceIds ?? [],
    credentialIds: data.credentialIds ?? [],
    playbookIds: data.playbookIds ?? [],
    operatingInstructions: normalizeDeckBody(body),
    createdAt: frontmatterValue(data.createdAt),
    updatedAt: frontmatterValue(data.updatedAt),
  });
}

/** Serialize a deck to the v2 `decks/<id>.md` form: metadata frontmatter + instructions body. */
export function serializeDeck(deck: StoreDeck): string {
  const validated = StoreDeckSchema.parse(deck);
  return matter.stringify(
    validated.operatingInstructions,
    frontmatterFromDeck(validated),
  );
}

/** Parse a v2 `decks/<id>.md` file. Malformed frontmatter throws. */
export function parseDeckMarkdown(raw: string): StoreDeck {
  const { data, content } = matter(raw);
  return frontmatterToDeck(data as Record<string, unknown>, content);
}

/**
 * Parse a legacy v1 `decks/<id>.json` record.
 *
 * Only the v1→v2 migration reads this form; every writer emits Markdown.
 * v1 records carry no instructions, so the schema default (`''`) applies.
 */
export function parseDeckJson(raw: string): StoreDeck {
  return StoreDeckSchema.parse(JSON.parse(raw));
}
