import type { CollectionCardWarning, CollectionWarningKind } from "@agent-deck/shared";

export type { CollectionCardWarning, CollectionWarningKind };

export {
  summarizeCollectionWarnings,
  getServiceWarnings,
  getCredentialWarnings,
  getPlaybookWarnings,
  primaryCollectionWarning,
  OAUTH_EXPIRED_MESSAGE,
} from "../../../../packages/shared/src/utils/collection-warnings";
export type { OAuthCardAuthState } from "../../../../packages/shared/src/utils/collection-warnings";

export type CollectionWarningsPayload = {
  total: number;
  byKind: Record<CollectionWarningKind, number>;
  services: Record<string, CollectionCardWarning[]>;
  credentials: Record<string, CollectionCardWarning[]>;
  playbooks: Record<string, CollectionCardWarning[]>;
};

export type CollectionWarningsView = {
  total: number;
  byKind: Record<CollectionWarningKind, number>;
  serviceWarnings: Map<string, CollectionCardWarning[]>;
  credentialWarnings: Map<string, CollectionCardWarning[]>;
  playbookWarnings: Map<string, CollectionCardWarning[]>;
};

export const emptyCollectionWarningsView: CollectionWarningsView = {
  total: 0,
  byKind: {
    oauth_required: 0,
    oauth_expired: 0,
    service_unhealthy: 0,
    credential_missing_secret: 0,
    playbook_missing_deps: 0,
  },
  serviceWarnings: new Map(),
  credentialWarnings: new Map(),
  playbookWarnings: new Map(),
};

export function toCollectionWarningsView(
  payload: CollectionWarningsPayload | undefined,
): CollectionWarningsView {
  if (!payload) {
    return emptyCollectionWarningsView;
  }

  return {
    total: payload.total,
    byKind: payload.byKind,
    serviceWarnings: new Map(Object.entries(payload.services)),
    credentialWarnings: new Map(Object.entries(payload.credentials)),
    playbookWarnings: new Map(Object.entries(payload.playbooks)),
  };
}
