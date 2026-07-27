import fs from 'fs/promises';
import path from 'path';
import { Credential } from '@agent-deck/shared';
import { resolveAgentDeckHome } from '../lib/paths';
import { serializeCredentialMeta } from '../store/credential-codec';

export function getAgentDeckHome(): string {
  return resolveAgentDeckHome();
}

export function getCredentialsDir(): string {
  return path.join(getAgentDeckHome(), 'credentials');
}

export class CredentialYamlSync {
  async write(credential: Credential): Promise<void> {
    const dir = getCredentialsDir();
    await fs.mkdir(dir, { recursive: true });

    const filePath = path.join(dir, `${credential.id}.yaml`);
    const raw = serializeCredentialMeta({
      id: credential.id,
      label: credential.label,
      scheme: credential.scheme,
      headerName: credential.headerName ?? null,
      envName: credential.envName,
      tags: credential.tags,
      docsUrl: credential.docsUrl ?? null,
    });

    await fs.writeFile(filePath, raw, 'utf8');
  }

  async remove(credentialId: string): Promise<void> {
    const filePath = path.join(getCredentialsDir(), `${credentialId}.yaml`);
    try {
      await fs.unlink(filePath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
