/**
 * NOT-50: MCP connections with no launch deck header become an unassigned
 * session instead of HTTP 401 (which Cursor misreads as OAuth / mcp_auth).
 */

export const UNASSIGNED_DECK_MESSAGE =
  'No deck assigned to this folder. Run `agent-deck use <deck>` in the project folder, then reload MCP.';

export type UnassignedDeckBinding = {
  deck: null;
  error_code: 'GRANT_REQUIRED';
  message: string;
};

export function unassignedDeckBinding(): UnassignedDeckBinding {
  return {
    deck: null,
    error_code: 'GRANT_REQUIRED',
    message: UNASSIGNED_DECK_MESSAGE,
  };
}

/** Unit-test escape hatch: allow full tools without a deck header. */
export function skipDeckHeaderAuth(): boolean {
  return (
    process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER === '1' ||
    process.env.AGENT_DECK_MCP_SKIP_GRANT_AUTH === '1'
  );
}
