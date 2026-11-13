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
 * NOT-604: the unassigned message, naming the deleted deck when the folder
 * assignment named one. The saved `deckName` is display-only (the id is
 * what failed to bind), but it is what the user recognizes.
 */
export function unassignedDeckMessage(missingDeckName?: string): string {
  const trimmed = missingDeckName?.trim();
  if (!trimmed) {
    return UNASSIGNED_DECK_MESSAGE;
  }
  return (
    `The folder was assigned to deck "${trimmed}", which no longer exists. ` +
    UNASSIGNED_DECK_MESSAGE
  );
}

export function unassignedDeckBinding(missingDeckName?: string): UnassignedDeckBinding {
  return {
    deck: null,
    error_code: 'GRANT_REQUIRED',
    message: unassignedDeckMessage(missingDeckName),
  };
}

/** Unit-test escape hatch: allow full tools without a deck header. */
export function skipDeckHeaderAuth(): boolean {
  return process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER === '1';
}
