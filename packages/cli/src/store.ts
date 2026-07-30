import { createStore } from './backend-runtime';

type StoreArgs =
  | { ok: true; command: 'migrate'; dryRun: boolean; force: boolean }
  | { ok: false; error: string };

type ReindexArgs = { ok: true } | { ok: false; error: string };

function printStoreUsage(): void {
  console.log(`Usage:
  agent-deck store migrate [--dry-run] [--force]`);
}

function printReindexUsage(): void {
  console.log(`Usage:
  agent-deck reindex`);
}

export function parseStoreArgs(args: string[]): StoreArgs {
  const command = args[0];
  if (!command || command === '--help' || command === '-h') {
    return { ok: false, error: 'help' };
  }
  if (command !== 'migrate') {
    return { ok: false, error: `Unknown store command: ${command}` };
  }

  let dryRun = false;
  let force = false;
  for (const arg of args.slice(1)) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--help' || arg === '-h') {
      return { ok: false, error: 'help' };
    } else {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }
  return { ok: true, command: 'migrate', dryRun, force };
}

export function parseReindexArgs(args: string[]): ReindexArgs {
  if (args.length === 0) {
    return { ok: true };
  }
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return { ok: false, error: 'help' };
  }
  return { ok: false, error: `Unknown argument: ${args[0]}` };
}

export async function runStoreCommand(args: string[]): Promise<number> {
  const parsed = parseStoreArgs(args);
  if (!parsed.ok) {
    if (parsed.error !== 'help') {
      console.error(parsed.error);
    }
    printStoreUsage();
    return parsed.error === 'help' ? 0 : 1;
  }

  try {
    const result = await createStore().migrate({
      dryRun: parsed.dryRun,
      force: parsed.force,
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runReindexCommand(args: string[]): Promise<number> {
  const parsed = parseReindexArgs(args);
  if (!parsed.ok) {
    if (parsed.error !== 'help') {
      console.error(parsed.error);
    }
    printReindexUsage();
    return parsed.error === 'help' ? 0 : 1;
  }

  try {
    const result = await createStore().reindex();
    if (!result.ok) {
      console.error(result.error);
      if (result.conflicts) {
        console.error(JSON.stringify(result.conflicts, null, 2));
      }
      return 1;
    }
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
