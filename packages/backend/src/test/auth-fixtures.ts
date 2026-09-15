import {
  AGENT_DECK_DASHBOARD_COOKIE,
  AGENT_DECK_SESSION_HEADER,
} from '@agent-deck/shared';

import type { DatabaseManager } from '../models/database';
import { TrustedSessionStore } from '../trusted-session/store';

export function dashboardAuthHeaders(store: TrustedSessionStore): Record<string, string> {
  const token = store.createDashboardSession();
  return {
    cookie: `${AGENT_DECK_DASHBOARD_COOKIE}=${encodeURIComponent(token)}`,
  };
}

export function agentSessionHeaders(
  db: DatabaseManager,
  deckId: string,
  _workspaceDigest = 'test-workspace-digest',
): Record<string, string> {
  const store = new TrustedSessionStore(db.getSqliteDatabase());
  const session = store.createRuntimeSession({ deckId });
  return { [AGENT_DECK_SESSION_HEADER]: session.sessionId };
}
