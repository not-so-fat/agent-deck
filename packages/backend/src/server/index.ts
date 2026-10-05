import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { registerCors } from './cors-origins';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseManager } from '../models/database';
import { ServiceManager } from '../services/service-manager';
import { MCPClientManager } from '../services/mcp-client-manager';
import { OAuthManager } from '../services/oauth-manager';
import { registerServiceRoutes } from '../routes/services';
import { registerDeckRoutes } from '../routes/decks';
import { registerOAuthRoutes } from '../routes/oauth';
import { registerWebSocketRoutes } from '../routes/websocket';
import mcpRoutes from '../routes/mcp';
import { registerLocalMCPRoutes } from '../routes/local-mcp';
import { registerCredentialRoutes } from '../routes/credentials';
import { registerScopeRoutes } from '../routes/scope';
import { registerPlaybookRoutes } from '../routes/playbooks';
import { ServiceStatusUpdate, DeckUpdate, WebSocketMessage } from '@agent-deck/shared';
import { createSecretStore, CredentialManager, OAuthClientSecretVault, OAuthTokenVault, ServiceHeaderVault } from '../vault';
import { UnavailableSecretStore } from '../vault/secret-store';
import { resolveDatabasePath } from '../lib/paths';
import { CollectionWarningService } from '../services/collection-warning-service';
import { registerCollectionRoutes } from '../routes/collection';
import { registerExportImportRoutes } from '../routes/export-import';
import { registerTrustedSessionRoutes, registerDashboardAuthRoutes } from '../routes/trusted-session';
import { registerAgentGrantRoutes } from '../routes/agent-grants';
import { ClientGrantStore } from '../auth/client-grants';
import { registerLaunchRoutes } from '../routes/launch';
import { registerUsageRoutes } from '../routes/usage';
import { PlaybookManager } from '../playbooks/playbook-manager';
import { PatchManager } from '../playbooks/patch-manager';
import { registerPlaybookPatchRoutes } from '../routes/playbook-patches';
import { registerFeedbackSignalRoutes } from '../routes/feedback-signals';
import { getAgentDeckVersion } from '../lib/version';
import { seedDefaultServicesIfEmpty } from '../data/seed-default-services';
import { LiveDisplayRegistry } from '../scope/live-display-registry';
import { FileStoreWriter } from '../store/writer';
import { ensureStoreReady } from '../store/startup';
import { TrustedSessionStore } from '../trusted-session/store';
import { ensureAdminSecret } from '../trusted-session/admin-secret';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { SqliteOwnerAuthProvider } from '../auth/owner-auth';
import { registerHostedModeGuard, resolveHostedModeConfig } from '../auth/hosted-mode';
import { registerHealthRoutes } from './health';
import { resolveAgentDeckHome } from '../lib/paths';
import { AuditStore } from '../audit/store';
import { registerAuditRoutes } from '../routes/audit';

export async function createServer() {
  const fastify = Fastify({
    logger: {
      level: 'info',
    },
    // Fastify's default ('idle') also drops a connection whose handler has not
    // written a byte yet; graceful shutdown must let that request finish.
    // Node's server.close() already closes truly idle keep-alive sockets.
    forceCloseConnections: false,
  });

  // Register plugins
  await registerCors(fastify, process.env);

  await fastify.register(websocket);

  // Initialize services
  const databasePath = resolveDatabasePath();
  console.log(`📁 Database: ${databasePath}`);
  const db = new DatabaseManager(databasePath);
  const seededCount = await seedDefaultServicesIfEmpty(db);
  if (seededCount > 0) {
    console.log(`Seeded ${seededCount} default MCP service cards`);
  }
  await ensureStoreReady(db);
  let secretStore;
  try {
    secretStore = createSecretStore();
  } catch (error) {
    if (process.env.AGENT_DECK_HOSTED_MODE !== '1') throw error;
    // Keep the process live so /readyz can identify missing or malformed vault
    // configuration. The placeholder never stores or returns a secret.
    fastify.log.warn({ err: error }, 'hosted vault unavailable; serving as not ready');
    secretStore = new UnavailableSecretStore();
  }
  const trustedSessionStore = new TrustedSessionStore(db.getSqliteDatabase());
  const ownerAuthProvider = new SqliteOwnerAuthProvider(
    db.getSqliteDatabase(),
    process.env.AGENT_DECK_OWNER_BOOTSTRAP_SECRET,
  );
  const grantStore = new ClientGrantStore(db.getSqliteDatabase());
  const auditStore = new AuditStore(db.getSqliteDatabase());
  await ensureAdminSecret();
  const oauthClientSecretVault = new OAuthClientSecretVault(secretStore, db);
  const oauthTokenVault = new OAuthTokenVault(secretStore, db);
  const serviceHeaderVault = new ServiceHeaderVault(secretStore);
  const oauthManager = new OAuthManager(db, oauthClientSecretVault, oauthTokenVault);
  const storeWriter = new FileStoreWriter();
  const credentialManager = new CredentialManager(db, secretStore, undefined, storeWriter);
  const mcpClient = new MCPClientManager((serviceId) => oauthManager.getValidAccessToken(serviceId));
  const serviceManager = new ServiceManager(
    db,
    mcpClient,
    oauthManager,
    oauthClientSecretVault,
    credentialManager,
    storeWriter,
    serviceHeaderVault,
  );
  void serviceManager.backfillMissingIcons();
  if (secretStore instanceof UnavailableSecretStore) {
    fastify.log.warn('secret-header migration deferred until the vault is available');
  } else {
    void serviceManager.migrateSecretHeadersToVault().catch((error) => {
      fastify.log.warn({ err: error }, 'secret-header migration failed');
    });
  }
  const playbookManager = new PlaybookManager(db, storeWriter);
  const patchManager = new PatchManager(db, playbookManager);
  const collectionWarningService = new CollectionWarningService(oauthManager);
  const liveDisplayRegistry = new LiveDisplayRegistry();

  fastify.decorate('db', db);
  fastify.decorate('trustedSessionStore', trustedSessionStore);
  fastify.decorate('ownerAuthProvider', ownerAuthProvider);
  fastify.decorate('grantStore', grantStore);
  fastify.decorate('auditStore', auditStore);
  registerHostedModeGuard(fastify, resolveHostedModeConfig(process.env));
  registerHttpPolicyHook(fastify);

  registerHealthRoutes(fastify, {
    dataPath: resolveAgentDeckHome(),
    sqliteProbe: () => {
      db.getSqliteDatabase().prepare('SELECT 1').get();
    },
  });

  const sweepStaleSessions = () => {
    try {
      trustedSessionStore.expireStaleSessions();
      trustedSessionStore.expireDashboardNonces();
      trustedSessionStore.expireDashboardSessions();
    } catch (error) {
      fastify.log.warn({ err: error }, 'trusted-session stale sweep failed');
    }
  };
  sweepStaleSessions();
  const staleSessionTimer = setInterval(sweepStaleSessions, 60_000);
  staleSessionTimer.unref?.();
  // NOT-309: drop live-display entries from sessions that died without a
  // clean MCP disconnect, so dead sessions stop counting toward the status
  // line. Reads also sweep lazily, so this timer is belt-and-braces.
  liveDisplayRegistry.startStaleSweep();

  // Register routes
  await fastify.register(registerWebSocketRoutes, { prefix: '/api/ws' });
  await fastify.register(registerServiceRoutes, { prefix: '/api/services' });
  await fastify.register(registerDeckRoutes, { prefix: '/api/decks', storeWriter });
  await fastify.register(registerCredentialRoutes, { prefix: '/api/credentials' });
  await fastify.register(registerScopeRoutes, { prefix: '/api/scope' });
  await fastify.register(registerPlaybookRoutes, { prefix: '/api/playbooks' });
  await fastify.register(registerPlaybookPatchRoutes, { prefix: '/api/playbook-patches' });
  await fastify.register(registerFeedbackSignalRoutes, { prefix: '/api/feedback-signals' });
  await fastify.register(registerCollectionRoutes, { prefix: '/api/collection' });
  await fastify.register(registerExportImportRoutes, { prefix: '/api' });
  await fastify.register(registerOAuthRoutes, { prefix: '/api/oauth' });
  await fastify.register(mcpRoutes, { prefix: '/api/mcp' });
  await fastify.register(registerLocalMCPRoutes, { prefix: '/api/local-mcp' });
  await fastify.register(registerTrustedSessionRoutes, { prefix: '/api/trusted-session' });
  await fastify.register(registerAgentGrantRoutes, { prefix: '/api' });
  await fastify.register(registerDashboardAuthRoutes, { prefix: '/api/dashboard-auth' });
  await fastify.register(registerLaunchRoutes, { prefix: '/api/launch' });
  await fastify.register(registerUsageRoutes, { prefix: '/api/usage' });
  await fastify.register(registerAuditRoutes, { prefix: '/api' });

  // Health check endpoint
  fastify.get('/health', async (request, reply) => {
    return {
      status: 'ok',
      service: 'agent-deck-backend',
      timestamp: new Date().toISOString(),
      version: getAgentDeckVersion(),
    };
  });

  const uiDist = process.env.AGENT_DECK_UI_DIST?.trim();
  if (uiDist && fs.existsSync(uiDist)) {
    await fastify.register(fastifyStatic, {
      root: path.resolve(uiDist),
      prefix: '/',
    });

    fastify.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ success: false, error: 'Not found' });
      }
      return reply.sendFile('index.html', path.resolve(uiDist));
    });
  } else if (!uiDist) {
    // Root endpoint when UI is not bundled (API-only mode)
    fastify.get('/', async () => ({
      name: 'Agent Deck Backend',
      version: getAgentDeckVersion(),
      status: 'running',
    }));
  }

  // Add services to request context
  fastify.decorate('serviceManager', serviceManager);
  fastify.decorate('mcpClient', mcpClient);
  fastify.decorate('oauthManager', oauthManager);
  fastify.decorate('oauthClientSecretVault', oauthClientSecretVault);
  fastify.decorate('oauthTokenVault', oauthTokenVault);
  fastify.decorate('serviceHeaderVault', serviceHeaderVault);
  fastify.decorate('credentialManager', credentialManager);
  fastify.decorate('playbookManager', playbookManager);
  fastify.decorate('patchManager', patchManager);
  fastify.decorate('collectionWarningService', collectionWarningService);
  fastify.decorate('liveDisplayRegistry', liveDisplayRegistry);

  fastify.addHook('onClose', async () => {
    clearInterval(staleSessionTimer);
    liveDisplayRegistry.stopStaleSweep();
    await mcpClient.cleanup();
    db.close();
  });

  // Add broadcast decorators for WebSocket functionality
  fastify.decorate('broadcastServiceUpdate', (update: ServiceStatusUpdate) => {
    console.log('Broadcasting service update:', update);
    // This will be implemented when WebSocket is properly connected
  });

  fastify.decorate('broadcastDeckUpdate', (update: DeckUpdate) => {
    console.log('Broadcasting deck update:', update);
    // This will be implemented when WebSocket is properly connected
  });

  fastify.decorate('broadcastToAll', (message: WebSocketMessage) => {
    console.log('Broadcasting to all:', message);
    // This will be implemented when WebSocket is properly connected
  });

  return fastify;
}

// Extend FastifyInstance to include our services
declare module 'fastify' {
  interface FastifyInstance {
    db: DatabaseManager;
    trustedSessionStore: TrustedSessionStore;
    serviceManager: ServiceManager;
    mcpClient: MCPClientManager;
    oauthManager: OAuthManager;
    oauthClientSecretVault: OAuthClientSecretVault;
    oauthTokenVault: OAuthTokenVault;
    serviceHeaderVault: ServiceHeaderVault;
    credentialManager: CredentialManager;
    playbookManager: PlaybookManager;
    patchManager: PatchManager;
    collectionWarningService: CollectionWarningService;
    liveDisplayRegistry: LiveDisplayRegistry;
    auditStore: AuditStore;
    broadcastServiceUpdate: (update: ServiceStatusUpdate) => void;
    broadcastDeckUpdate: (update: DeckUpdate) => void;
    broadcastToAll: (message: WebSocketMessage) => void;
  }
}
