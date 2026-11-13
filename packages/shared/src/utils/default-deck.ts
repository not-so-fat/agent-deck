import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { resolveAgentDeckHome } from './agent-deck-home';

/**
 * User default deck (NOT-600): the deck a headerless local MCP session binds
 * when no launch deck header and no folder assignment resolve. Lives at
 * `$AGENT_DECK_HOME/default-deck.json`; shape mirrors `use.json` v3 with
 * `deckId` authoritative and `deckName` display-only.
 */
export const DEFAULT_DECK_FILENAME = 'default-deck.json';
export const DEFAULT_DECK_FILE_VERSION = 1;

export const DefaultDeckFileSchema = z.object({
  version: z.literal(DEFAULT_DECK_FILE_VERSION),
  deckId: z.string().min(1),
  deckName: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type DefaultDeckFile = z.infer<typeof DefaultDeckFileSchema>;

export function resolveDefaultDeckPath(): string {
  return path.join(resolveAgentDeckHome(), DEFAULT_DECK_FILENAME);
}

/**
 * Read the user default deck, or null when there is none. A missing file, an
 * unreadable file, corrupt JSON, or a wrong-shaped manifest all mean "no
 * default" — like `readUseManifest` returning null. Never throws for file
 * content (an unresolvable home still throws, as everywhere).
 */
export function readDefaultDeck(): DefaultDeckFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(resolveDefaultDeckPath(), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const validated = DefaultDeckFileSchema.safeParse(parsed);
  if (!validated.success) {
    return null;
  }
  const deckId = validated.data.deckId.trim();
  const deckName = validated.data.deckName.trim();
  if (!deckId || !deckName) {
    return null;
  }
  return { ...validated.data, deckId, deckName };
}

/**
 * Set the user default deck, creating `$AGENT_DECK_HOME` when needed.
 * Returns the path written.
 */
export function writeDefaultDeck(input: { deckId: string; deckName: string }): string {
  const record: DefaultDeckFile = {
    version: DEFAULT_DECK_FILE_VERSION,
    deckId: input.deckId.trim(),
    deckName: input.deckName.trim(),
    updatedAt: new Date().toISOString(),
  };
  const target = resolveDefaultDeckPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return target;
}

/**
 * Clear the user default deck. Returns true when a file was removed, false
 * when there was nothing to clear. Never throws for a missing file.
 */
export function clearDefaultDeck(): boolean {
  try {
    fs.unlinkSync(resolveDefaultDeckPath());
    return true;
  } catch {
    return false;
  }
}
