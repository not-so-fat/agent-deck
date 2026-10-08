import matter from 'gray-matter';
import { StoreDeckSchema, type StoreDeck } from '@agent-deck/shared';

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
 * gray-matter emits the body right after the closing fence, so a body that
 * starts with a blank line round-trips with one leading newline intact.
 * Same normalization as the playbook codec: strip exactly one.
 */
function normalizeDeckBody(content: string): string {
  return content.startsWith('\n') ? content.slice(1) : content;
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
