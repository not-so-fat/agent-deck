import {
  buildCollectionCatalog,
  getCredentialWarnings,
  getPlaybookWarnings,
  getServiceWarnings,
  isOAuthSessionValid,
  type CollectionCardWarning,
  type CollectionWarningKind,
  type Credential,
  type Playbook,
  type Service,
} from '@agent-deck/shared';
import { MCPDiscoveryService } from './mcp-discovery-service';
import type { OAuthManager } from './oauth-manager';

export type CollectionWarningsPayload = {
  total: number;
  byKind: Record<CollectionWarningKind, number>;
  services: Record<string, CollectionCardWarning[]>;
  credentials: Record<string, CollectionCardWarning[]>;
  playbooks: Record<string, CollectionCardWarning[]>;
};

const OAUTH_PROBE_TTL_MS = 5 * 60 * 1000;

export class CollectionWarningService {
  private discoveryService = new MCPDiscoveryService();
  private oauthRequiredCache = new Map<string, { required: boolean; expiresAt: number }>();

  constructor(private oauthManager?: OAuthManager) {}

  private emptyByKind(): Record<CollectionWarningKind, number> {
    return {
      oauth_required: 0,
      oauth_expired: 0,
      service_unhealthy: 0,
      credential_missing_secret: 0,
      playbook_missing_deps: 0,
    };
  }

  private async probeOAuthRequired(service: Service): Promise<boolean> {
    if (service.type !== 'mcp') {
      return false;
    }

    if (
      service.oauthClientId ||
      service.oauthAuthorizationUrl ||
      service.oauthTokenUrl
    ) {
      return true;
    }

    const cached = this.oauthRequiredCache.get(service.id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.required;
    }

    try {
      const discovery = await this.discoveryService.discoverService(service.url);
      const required = discovery.oauth.required;
      this.oauthRequiredCache.set(service.id, {
        required,
        expiresAt: Date.now() + OAUTH_PROBE_TTL_MS,
      });
      return required;
    } catch {
      this.oauthRequiredCache.set(service.id, {
        required: false,
        expiresAt: Date.now() + OAUTH_PROBE_TTL_MS,
      });
      return false;
    }
  }

  private shouldProbeOAuth(service: Service): boolean {
    if (service.type !== 'mcp') {
      return false;
    }

    if (isOAuthSessionValid(service)) {
      return false;
    }

    if (
      service.oauthClientId ||
      service.oauthAuthorizationUrl ||
      service.oauthTokenUrl
    ) {
      return false;
    }

    return true;
  }

  async summarize(
    services: Service[],
    credentials: Credential[],
    playbooks: Playbook[],
  ): Promise<CollectionWarningsPayload> {
    const catalog = buildCollectionCatalog(credentials, services);
    const serviceWarningContext: Record<string, { oauthRequired?: boolean }> = {};

    await Promise.all(
      services.map(async (service) => {
        if (!this.shouldProbeOAuth(service)) {
          return;
        }
        const oauthRequired = await this.probeOAuthRequired(service);
        if (oauthRequired) {
          serviceWarningContext[service.id] = { oauthRequired: true };
        }
      }),
    );

    const refreshTokenByServiceId: Record<string, boolean> = {};
    if (this.oauthManager) {
      await Promise.all(
        services.map(async (service) => {
          if (service.type !== 'mcp') {
            return;
          }
          const oauthLikely =
            service.oauthClientId ||
            service.oauthAuthorizationUrl ||
            service.oauthTokenUrl ||
            serviceWarningContext[service.id]?.oauthRequired;
          if (!oauthLikely) {
            return;
          }
          refreshTokenByServiceId[service.id] = await this.oauthManager!.hasRefreshToken(service.id);
        }),
      );
    }

    const servicesMap: Record<string, CollectionCardWarning[]> = {};
    const credentialsMap: Record<string, CollectionCardWarning[]> = {};
    const playbooksMap: Record<string, CollectionCardWarning[]> = {};
    const byKind = this.emptyByKind();

    for (const service of services) {
      const warnings = getServiceWarnings(service, {
        ...serviceWarningContext[service.id],
        hasRefreshToken: refreshTokenByServiceId[service.id],
      });
      if (warnings.length > 0) {
        servicesMap[service.id] = warnings;
        for (const warning of warnings) {
          byKind[warning.kind] += 1;
        }
      }
    }

    for (const credential of credentials) {
      const warnings = getCredentialWarnings(credential);
      if (warnings.length > 0) {
        credentialsMap[credential.id] = warnings;
        for (const warning of warnings) {
          byKind[warning.kind] += 1;
        }
      }
    }

    for (const playbook of playbooks) {
      const warnings = getPlaybookWarnings(playbook, catalog);
      if (warnings.length > 0) {
        playbooksMap[playbook.id] = warnings;
        for (const warning of warnings) {
          byKind[warning.kind] += 1;
        }
      }
    }

    return {
      total:
        Object.keys(servicesMap).length +
        Object.keys(credentialsMap).length +
        Object.keys(playbooksMap).length,
      byKind,
      services: servicesMap,
      credentials: credentialsMap,
      playbooks: playbooksMap,
    };
  }

  clearCache(serviceId?: string): void {
    if (serviceId) {
      this.oauthRequiredCache.delete(serviceId);
      return;
    }
    this.oauthRequiredCache.clear();
  }
}
