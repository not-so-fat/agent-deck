import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseManager } from '../models/database';
import { MemorySecretStore } from '../vault/secret-store';
import { ServiceHeaderVault } from '../vault/service-header-vault';
import { ServiceManager } from './service-manager';

/**
 * Custom secret headers (Bearer / API keys) must live in the ServiceHeaderVault,
 * never in the SQLite `headers` column or the git-synced store — otherwise a store
 * reindex (which rebuilds SQLite from the sanitized files) silently wipes them.
 */
describe('ServiceManager custom secret headers', () => {
  let db: DatabaseManager;
  let headerVault: ServiceHeaderVault;
  let mcpClient: {
    discoverTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    invalidateClient: ReturnType<typeof vi.fn>;
  };
  let manager: ServiceManager;

  beforeEach(() => {
    db = new DatabaseManager(':memory:');
    headerVault = new ServiceHeaderVault(new MemorySecretStore());
    mcpClient = {
      discoverTools: vi.fn().mockResolvedValue([]),
      callTool: vi.fn(),
      invalidateClient: vi.fn(),
    };
    const oauthManager = {
      discoverOAuth: vi.fn().mockResolvedValue({ hasOAuth: false }),
    };
    const clientSecrets = { set: vi.fn(), get: vi.fn(), has: vi.fn(), delete: vi.fn() };

    manager = new ServiceManager(
      db,
      mcpClient as never,
      oauthManager as never,
      clientSecrets as never,
      undefined,
      undefined,
      headerVault,
    );
  });

  afterEach(() => {
    db.close();
  });

  async function createWithHeaders(
    headers: Record<string, string>,
  ): Promise<string> {
    const service = await manager.createService({
      name: `svc-${Math.random()}`,
      type: 'mcp',
      url: 'https://example.com/mcp',
      headers,
    });
    return service.id;
  }

  it('splits secret headers into the vault and keeps non-secret headers in the DB row', async () => {
    const id = await createWithHeaders({
      Authorization: 'Bearer secret-abc',
      'X-Tenant': 'acme',
    });

    // SQLite row (what a reindex rebuilds from) must not contain the secret.
    const row = await db.getService(id);
    expect(row?.headers).toEqual({ 'X-Tenant': 'acme' });

    // Vault holds the secret.
    expect(await headerVault.get(id)).toEqual({ Authorization: 'Bearer secret-abc' });

    // Reads merge both back together for the dashboard.
    const merged = await manager.getService(id);
    expect(merged?.headers).toEqual({
      Authorization: 'Bearer secret-abc',
      'X-Tenant': 'acme',
    });
  });

  it('createService returns the secret headers merged (201 body matches get/update)', async () => {
    const created = await manager.createService({
      name: 'with-secret',
      type: 'mcp',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer created', 'X-Tenant': 'acme' },
    });

    expect(created.headers).toEqual({
      Authorization: 'Bearer created',
      'X-Tenant': 'acme',
    });
  });

  it('migrateSecretHeadersToVault moves legacy row secrets into the vault', async () => {
    // Simulate a pre-upgrade row: secret header written straight to SQLite,
    // bypassing the split (this is what a reindex could still wipe).
    const legacy = await db.createService({
      name: 'legacy',
      type: 'mcp',
      url: 'https://example.com/legacy',
      headers: { Authorization: 'Bearer legacy', 'X-Tenant': 'acme' },
    });

    await manager.migrateSecretHeadersToVault();

    const row = await db.getService(legacy.id);
    expect(row?.headers).toEqual({ 'X-Tenant': 'acme' });
    expect(await headerVault.get(legacy.id)).toEqual({ Authorization: 'Bearer legacy' });
  });

  it('survives a store reindex that rebuilds the DB row without the secret', async () => {
    const id = await createWithHeaders({ Authorization: 'Bearer keep-me' });

    // Simulate reindexStoreToSqlite: DB row rewritten from the sanitized store file
    // (secret headers stripped), which historically wiped the token.
    await db.updateService(id, { headers: {} });

    // Vault is untouched, so the header still surfaces on read.
    const merged = await manager.getService(id);
    expect(merged?.headers).toEqual({ Authorization: 'Bearer keep-me' });
  });

  it('updateService moves secret headers to the vault', async () => {
    const id = await createWithHeaders({ 'X-Tenant': 'acme' });

    await manager.updateService(id, {
      headers: { Authorization: 'Bearer new-token', 'X-Tenant': 'acme' },
    });

    const row = await db.getService(id);
    expect(row?.headers).toEqual({ 'X-Tenant': 'acme' });
    expect(await headerVault.get(id)).toEqual({ Authorization: 'Bearer new-token' });
  });

  it('updateService clears the vault when secret headers are removed', async () => {
    const id = await createWithHeaders({ Authorization: 'Bearer drop-me' });

    await manager.updateService(id, { headers: { 'X-Tenant': 'acme' } });

    expect(await headerVault.get(id)).toBeNull();
    const merged = await manager.getService(id);
    expect(merged?.headers).toEqual({ 'X-Tenant': 'acme' });
  });

  it('stores null (not "{}") on the row when only secret headers remain — matches create', async () => {
    const id = await createWithHeaders({ 'X-Tenant': 'acme' });

    await manager.updateService(id, { headers: { Authorization: 'Bearer only' } });

    // db.updateService treats {} as truthy and would serialize "{}" — must be null,
    // so an only-secret update doesn't dirty the git-synced store vs a create.
    const raw = await db.getService(id);
    expect(raw?.headers ?? null).toBeNull();
  });

  it('injects vault secret headers into outbound MCP requests', async () => {
    const id = await createWithHeaders({ Authorization: 'Bearer call-me' });
    mcpClient.discoverTools.mockClear();

    await manager.discoverServiceTools(id);

    expect(mcpClient.discoverTools).toHaveBeenCalledTimes(1);
    const prepared = mcpClient.discoverTools.mock.calls[0]![0] as {
      headers: Record<string, string>;
    };
    expect(prepared.headers.Authorization).toBe('Bearer call-me');
  });

  it('clears the vault when the service is deleted', async () => {
    const id = await createWithHeaders({ Authorization: 'Bearer bye' });
    await manager.deleteService(id);
    expect(await headerVault.get(id)).toBeNull();
  });

  it('getAllServices merges secret headers for every service', async () => {
    const id = await createWithHeaders({ Authorization: 'Bearer a', 'X-Tenant': 't' });
    const all = await manager.getAllServices();
    const found = all.find((s) => s.id === id);
    expect(found?.headers).toEqual({ Authorization: 'Bearer a', 'X-Tenant': 't' });
  });
});
