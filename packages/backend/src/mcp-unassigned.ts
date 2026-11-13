/**
 * NOT-50: MCP connections with no launch deck header become an unassigned
 * session instead of HTTP 401 (which Cursor misreads as OAuth / mcp_auth).
 * NOT-597: the first remedy is the human-approved `request_deck_assignment`
 * tool (no terminal step); the CLI stays as the fallback.
 */

export const UNASSIGNED_DECK_MESSAGE =
  'No deck assigned to this folder. Call `request_deck_assignment` with the absolute folder path to ask the user to pick a deck (no terminal step), then call `get_session_context` again after approval. Fallback: run `agent-deck use <deck>` in the project folder, then reload MCP.';

export type UnassignedDeckBinding = {
  deck: null;
  error_code: 'GRANT_REQUIRED';
  message: string;
};

/**
 * NOT-606: why the user default deck did not apply to an unassigned
 * session. `missing` names a saved default deck that no longer exists;
 * `unreadable` names a `default-deck.json` that cannot be used (corrupt or
 * unknown version). Held per unassigned session, like the missing folder
 * deck name.
 */
export type UnassignedDefaultDeckIssue =
  | { kind: 'missing'; deckName: string }
  | { kind: 'unreadable'; path: string };

/**
 * NOT-604: the unassigned message, naming the deleted deck when the folder
 * assignment named one. The saved `deckName` is display-only (the id is
 * what failed to bind), but it is what the user recognizes.
 *
 * NOT-606: adds one sentence naming the missing or unreadable default deck
 * when that is the reason no default applied, instead of behaving as if no
 * default was ever set.
 */
export function unassignedDeckMessage(
  missingDeckName?: string,
  defaultIssue?: UnassignedDefaultDeckIssue,
): string {
  const parts: string[] = [];
  const trimmed = missingDeckName?.trim();
  if (trimmed) {
    parts.push(`The folder was assigned to deck "${trimmed}", which no longer exists.`);
  }
  if (defaultIssue?.kind === 'missing' && defaultIssue.deckName.trim()) {
    parts.push(`The default deck "${defaultIssue.deckName.trim()}" no longer exists.`);
  } else if (defaultIssue?.kind === 'unreadable' && defaultIssue.path.trim()) {
    parts.push(`The default deck file is unreadable: ${defaultIssue.path.trim()}.`);
  }
  parts.push(UNASSIGNED_DECK_MESSAGE);
  return parts.join(' ');
}

export function unassignedDeckBinding(
  missingDeckName?: string,
  defaultIssue?: UnassignedDefaultDeckIssue,
): UnassignedDeckBinding {
  return {
    deck: null,
    error_code: 'GRANT_REQUIRED',
    message: unassignedDeckMessage(missingDeckName, defaultIssue),
  };
}

/** Unit-test escape hatch: allow full tools without a deck header. */
export function skipDeckHeaderAuth(): boolean {
  return process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER === '1';
}
