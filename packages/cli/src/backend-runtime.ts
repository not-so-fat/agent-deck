import { spawn } from 'node:child_process';
import readline from 'node:readline';

import { getCliPackageRoot } from './paths';

export function createCredentialManager(): unknown {
  const cliRuntime = require.resolve('@agent-deck/backend/cli-runtime', {
    paths: [getCliPackageRoot()],
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createCliCredentialManager } = require(cliRuntime) as {
    createCliCredentialManager: () => unknown;
  };
  return createCliCredentialManager();
}

export type CliCollectionAdmin = {
  deleteService(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  deletePlaybook(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  deleteDeck(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  listServices(): Promise<Array<{ id: string; name: string; type: string }>>;
  listPlaybooks(): Promise<Array<{ id: string; title: string }>>;
  listDecks(): Promise<Array<{ id: string; name: string }>>;
  resolveDeck(ref: string): Promise<{ id: string; name: string } | null>;
  listDeckPlaybookStubs(
    deckId: string,
  ): Promise<Array<{ id: string; title: string; triggers: string[] }>>;
};

export function createCollectionAdmin(): CliCollectionAdmin {
  const cliRuntime = require.resolve('@agent-deck/backend/cli-runtime', {
    paths: [getCliPackageRoot()],
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createCliCollectionAdmin } = require(cliRuntime) as {
    createCliCollectionAdmin: () => CliCollectionAdmin;
  };
  return createCliCollectionAdmin();
}

export type CliExportImport = {
  exportToFile(
    outputPath: string,
    request: { scope?: 'collection' | 'deck'; deckId?: string },
  ): Promise<
    | { ok: true; bundle: { services: unknown[]; playbooks: unknown[]; decks: unknown[] } }
    | { ok: false; error: string }
  >;
  importFromFile(
    inputPath: string,
  ): Promise<
    | {
        ok: true;
        report: {
          status: string;
          counts: {
            services: { created: number; reused: number };
            playbooks: { created: number; reused: number };
            decks: { created: number; reused: number };
          };
          servicesNeedingOauth: string[];
          warnings: string[];
          idMap: Record<string, string>;
        };
      }
    | { ok: false; error: string }
  >;
};

export function createExportImport(): CliExportImport {
  const cliRuntime = require.resolve('@agent-deck/backend/cli-runtime', {
    paths: [getCliPackageRoot()],
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createCliExportImport } = require(cliRuntime) as {
    createCliExportImport: () => CliExportImport;
  };
  return createCliExportImport();
}

export type CliStore = {
  migrate(opts?: { dryRun?: boolean }): Promise<{
    wrote: {
      playbooks: number;
      services: number;
      credentials: number;
      decks: number;
    };
    dryRun: boolean;
    paths: string[];
  }>;
  reindex(): Promise<
    | {
        ok: true;
        counts: {
          playbooks: number;
          services: number;
          credentials: number;
          decks: number;
        };
        warnings: string[];
        contentHash: string;
      }
    | { ok: false; error: string; conflicts?: unknown[] }
  >;
};

export function createStore(): CliStore {
  const cliRuntime = require.resolve('@agent-deck/backend/cli-runtime', {
    paths: [getCliPackageRoot()],
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createCliStore } = require(cliRuntime) as {
    createCliStore: () => CliStore;
  };
  return createCliStore();
}

export function parseConnections(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

export async function readSecretFromStdin(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8').trim();
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function runCommand(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}
