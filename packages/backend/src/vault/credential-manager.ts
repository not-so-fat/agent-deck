import {
  AddCredentialToDeckInput,
  CreateCredentialInput,
  Credential,
  RemoveCredentialFromDeckInput,
  RotateCredentialInput,
  UpdateCredentialInput,
} from '@agent-deck/shared';
import { DatabaseManager } from '../models/database';
import {
  cacheIconForCredential,
  credentialIconApiPath,
  removeCachedIcon,
} from '../services/icon-resolver';
import { CredentialYamlSync } from './yaml-sync';
import { SecretStore, VaultUnsupportedError } from './secret-store';
import { buildCredentialAuthHeaders } from './credential-auth-headers';
import { FileStoreWriter } from '../store/writer';

export class CredentialManager {
  constructor(
    private db: DatabaseManager,
    private secretStore: SecretStore,
    private yamlSync: CredentialYamlSync = new CredentialYamlSync(),
    private storeWriter: FileStoreWriter = new FileStoreWriter(),
  ) {}

  private async writeToStore(credential: Credential): Promise<void> {
    try {
      await this.yamlSync.write(credential);
      await this.storeWriter.touchHash(this.db);
    } catch (error) {
      console.error(`Failed to write credential ${credential.id} to file store:`, error);
      throw error;
    }
  }

  private async deleteFromStore(id: string): Promise<void> {
    try {
      await this.yamlSync.remove(id);
      await this.storeWriter.touchHash(this.db);
    } catch (error) {
      console.error(`Failed to delete credential ${id} from file store:`, error);
      throw error;
    }
  }

  async create(input: CreateCredentialInput): Promise<Credential> {
    const keychainAccount = input.keychainAccount ?? input.id;
    await this.secretStore.set(keychainAccount, input.value);

    let credential = await this.db.createCredential({
      id: input.id,
      label: input.label,
      scheme: input.scheme,
      headerName: input.headerName,
      envName: input.envName,
      keychainAccount,
      tags: input.tags ?? [],
      docsUrl: input.docsUrl,
      hasSecret: true,
    });

    if (input.docsUrl) {
      credential = await this.syncIconFromDocsUrl({ ...credential, hasSecret: true });
    }

    await this.writeToStore(credential);
    return { ...credential, hasSecret: true };
  }

  private async syncIconFromDocsUrl(credential: Credential): Promise<Credential> {
    if (!credential.docsUrl) {
      await removeCachedIcon(credential.id);
      if (!credential.iconUrl) {
        return credential;
      }

      const cleared = await this.db.updateCredential(credential.id, { iconUrl: undefined });
      return cleared ? { ...cleared, hasSecret: credential.hasSecret } : credential;
    }

    const result = await cacheIconForCredential(credential.id, credential.docsUrl);
    if (!result.iconPath) {
      return credential;
    }

    const withIcon = await this.db.updateCredential(credential.id, {
      iconUrl: credentialIconApiPath(credential.id),
    });
    return withIcon ? { ...withIcon, hasSecret: credential.hasSecret } : credential;
  }

  async applySecretStatus(credentials: Credential[]): Promise<Credential[]> {
    return Promise.all(
      credentials.map(async (credential) => ({
        ...credential,
        hasSecret: await this.secretStore.has(credential.keychainAccount),
      })),
    );
  }

  async list(): Promise<Credential[]> {
    const credentials = await this.db.getAllCredentials();
    const withSecrets = await this.applySecretStatus(credentials);
    return Promise.all(
      withSecrets.map(async (credential) => {
        if (credential.docsUrl && !credential.iconUrl) {
          return this.syncIconFromDocsUrl(credential);
        }
        return credential;
      }),
    );
  }

  async listForDeck(deckId: string): Promise<Credential[]> {
    const credentials = await this.db.getDeckCredentialsForDeck(deckId);
    return this.applySecretStatus(credentials);
  }

  async listForActiveDeck(): Promise<Credential[]> {
    const activeDeck = await this.db.getActiveDeck();
    if (!activeDeck) {
      return [];
    }
    return this.listForDeck(activeDeck.id);
  }

  async isCredentialOnDeck(deckId: string, credentialId: string): Promise<boolean> {
    const credentials = await this.db.getDeckCredentialsForDeck(deckId);
    return credentials.some((credential) => credential.id === credentialId);
  }

  async assertCredentialsOnDeck(deckId: string, credentialIds: string[]): Promise<void> {
    const credentials = await this.db.getDeckCredentialsForDeck(deckId);
    const allowed = new Set(credentials.map((credential) => credential.id));

    for (const credentialId of credentialIds) {
      if (!allowed.has(credentialId)) {
        throw new Error(`Credential ${credentialId} is not on deck ${deckId}`);
      }
    }
  }

  async getIfOnActiveDeck(id: string): Promise<Credential | null> {
    const activeDeck = await this.db.getActiveDeck();
    if (!activeDeck) {
      return null;
    }

    const onDeck = await this.isCredentialOnDeck(activeDeck.id, id);
    if (!onDeck) {
      return null;
    }

    return this.get(id);
  }

  async get(id: string): Promise<Credential | null> {
    const credential = await this.db.getCredential(id);
    if (!credential) {
      return null;
    }

    return {
      ...credential,
      hasSecret: await this.secretStore.has(credential.keychainAccount),
    };
  }

  /** Resolve vault-stored credential to HTTP headers for MCP / API calls. */
  async resolveHttpHeaders(credentialId: string): Promise<Record<string, string>> {
    const credential = await this.db.getCredential(credentialId);
    if (!credential) {
      throw new Error(`Credential not found: ${credentialId}`);
    }

    const secret = await this.secretStore.get(credential.keychainAccount);
    if (!secret) {
      throw new Error(`Secret not found in vault for credential: ${credentialId}`);
    }

    return buildCredentialAuthHeaders(credential, secret);
  }

  async update(id: string, input: UpdateCredentialInput): Promise<Credential | null> {
    const updated = await this.db.updateCredential(id, input);
    if (!updated) {
      return null;
    }

    let credential = {
      ...updated,
      hasSecret: await this.secretStore.has(updated.keychainAccount),
    };

    if (input.docsUrl !== undefined) {
      credential = await this.syncIconFromDocsUrl(credential);
    }

    await this.writeToStore(credential);
    return credential;
  }

  async rotate(id: string, input: RotateCredentialInput): Promise<Credential | null> {
    const existing = await this.db.getCredential(id);
    if (!existing) {
      return null;
    }

    await this.secretStore.set(existing.keychainAccount, input.value);
    const hasSecret = await this.secretStore.has(existing.keychainAccount);
    if (!hasSecret) {
      throw new Error(
        `Failed to store secret in vault for account "${existing.keychainAccount}"`,
      );
    }

    const credential = {
      ...existing,
      updatedAt: new Date().toISOString(),
      hasSecret,
    };

    await this.db.touchCredential(id);
    await this.writeToStore(credential);
    return credential;
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.db.getCredential(id);
    if (!existing) {
      return false;
    }

    const dependents = await this.db.getPlaybooksDependingOnCredential(id);
    if (dependents.length > 0) {
      const { PlaybookDependencyError } = await import('../playbooks/playbook-manager');
      throw new PlaybookDependencyError(
        `Cannot delete API key "${existing.label}": referenced by playbook(s): ${dependents.map((p) => p.title).join(', ')}`,
        dependents.map(({ id: playbookId, title }) => ({ id: playbookId, title })),
      );
    }

    try {
      await this.secretStore.delete(existing.keychainAccount);
    } catch (error) {
      if (!(error instanceof VaultUnsupportedError)) {
        throw error;
      }
    }

    const deleted = await this.db.deleteCredential(id);
    if (deleted) {
      await this.deleteFromStore(id);
      await removeCachedIcon(id);
    }
    return deleted;
  }

  async resolveEnvMap(credentialIds: string[]): Promise<Record<string, string>> {
    const env: Record<string, string> = {};

    for (const credentialId of credentialIds) {
      const credential = await this.db.getCredential(credentialId);
      if (!credential) {
        throw new Error(`Credential not found: ${credentialId}`);
      }

      const secret = await this.secretStore.get(credential.keychainAccount);
      if (!secret) {
        throw new Error(`Secret not found in vault for credential: ${credentialId}`);
      }

      env[credential.envName] = secret;
    }

    return env;
  }

  async addToDeck(input: AddCredentialToDeckInput): Promise<void> {
    const credential = await this.db.getCredential(input.credentialId);
    if (!credential) {
      throw new Error(`Credential not found: ${input.credentialId}`);
    }

    await this.db.addCredentialToDeck(input);
  }

  async removeFromDeck(input: RemoveCredentialFromDeckInput): Promise<void> {
    await this.db.removeCredentialFromDeck(input);
  }

  async recordExecRun(input: {
    deckId?: string;
    manifestPath?: string;
    command: string;
    credentialIds: string[];
    exitCode?: number;
    startedAt: string;
    finishedAt?: string;
  }) {
    return this.db.createExecRun(input);
  }
}
