import { isValidUUID } from '../utils/id';

/**
 * One pinned playbook version for a run's MCP session (NOT-537).
 *
 * The pin travels as `<playbookId>=<versionId>` — the `--playbook-version`
 * flag value, the `AGENT_DECK_PLAYBOOK_PIN` env var, and the
 * `x-agent-deck-playbook-pin` launch header all share this shape. One pin
 * per run; it lives only as long as the run's MCP session.
 */
export type PlaybookPin = {
  playbookId: string;
  versionId: string;
};

/** Env var the run adapters set and `mcp-launch` reads (NOT-537). */
export const AGENT_DECK_PLAYBOOK_PIN_ENV = 'AGENT_DECK_PLAYBOOK_PIN';

const PLAYBOOK_ID_RE = /^pb_[a-z0-9_]+$/;

/**
 * Parse a candidate pin, or return null when it is absent or malformed.
 * Invalid values are dropped — never coerced — so untrusted input cannot
 * smuggle task content into a session. The playbook id must match
 * `pb_<slug>` and the version id must be a UUID (the only shape version
 * snapshots are ever stored with).
 */
export function normalizePlaybookPin(raw: unknown): PlaybookPin | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim();
  if (!value) {
    return null;
  }
  const separator = value.indexOf('=');
  if (separator === -1 || value.indexOf('=', separator + 1) !== -1) {
    return null;
  }
  const playbookId = value.slice(0, separator).trim();
  const versionId = value.slice(separator + 1).trim();
  if (!PLAYBOOK_ID_RE.test(playbookId) || !isValidUUID(versionId)) {
    return null;
  }
  return { playbookId, versionId };
}

/** Canonical `<playbookId>=<versionId>` form for headers and env. */
export function formatPlaybookPin(pin: PlaybookPin): string {
  return `${pin.playbookId}=${pin.versionId}`;
}
