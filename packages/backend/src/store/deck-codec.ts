import { StoreDeckSchema, type StoreDeck } from '@agent-deck/shared';

export function serializeDeck(deck: StoreDeck): string {
  const validated = StoreDeckSchema.parse(deck);
  return `${JSON.stringify(validated, null, 2)}\n`;
}

export function parseDeckJson(raw: string): StoreDeck {
  return StoreDeckSchema.parse(JSON.parse(raw));
}
