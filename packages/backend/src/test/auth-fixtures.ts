import {
  AGENT_DECK_DASHBOARD_COOKIE,
  AGENT_DECK_SESSION_HEADER,
} from '@agent-deck/shared';

import type { DatabaseManager } from '../models/database';
import { createDashboardSessionToken } from '../trusted-session/auth';
import { TrustedSessionStore, generateGrantSecret } from '../trusted-session/store';

export function dashboardAuthHeaders(): Record<string, string> {
  const token = createDashboardSessionToken();
  return {
    cookie: `${AGENT_DECK_DASHBOARD_COOKIE}=${encodeURIComponent(token)}`,
  };
}

export function agentSessionHeaders(
  db: DatabaseManager,
  deckId: string,
  workspaceDigest = 'test-workspace-digest',
): Record<string, string> {
  const store = new TrustedSessionStore(db.getSqliteDatabase());
  const workspace = store.getOrCreateWorkspaceKey(workspaceDigest);
  const secret = generateGrantSecret();
  const pending = store.createPendingGrant(workspace.id, deckId, secret);
  store.activateGrant(pending.id);
  const grant = store.findActiveGrantBySecret(secret)!;
  const session = store.createRuntimeSession({
    workspaceKeyId: workspace.id,
    workspaceGrantId: grant.id,
    deckId,
  });
  return { [AGENT_DECK_SESSION_HEADER]: session.sessionId };
}
