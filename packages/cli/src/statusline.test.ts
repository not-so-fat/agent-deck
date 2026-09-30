import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { DatabaseManager } from '../../backend/src/models/database';
import { LiveDisplayRegistry } from '../../backend/src/scope/live-display-registry';
import { resolveDeckDisplay } from '../../backend/src/scope/display';
import { readStdin, resolveStatuslineWorkspace, runStatusline } from './statusline';

describe('statusline', () => {
  it('prefers --workspace over stdin cwd', () => {
    const workspace = resolveStatuslineWorkspace(
      ['--workspace', '/explicit'],
      JSON.stringify({ cwd: '/stdin' }),
    );
    expect(workspace).toBe('/explicit');
  });

  it('reads cwd from stdin payload', () => {
    const workspace = resolveStatuslineWorkspace(
      [],
      JSON.stringify({ cwd: '/from-stdin' }),
    );
    expect(workspace).toBe('/from-stdin');
  });

  it('reads workspace.project_dir from stdin payload', () => {
    const workspace = resolveStatuslineWorkspace(
      [],
      JSON.stringify({
        cwd: '/repo/packages/app',
        workspace: { project_dir: '/repo', current_dir: '/repo/packages/app' },
      }),
    );
    expect(workspace).toBe(path.resolve('/repo'));
  });

  it('falls back to process cwd when stdin is empty', () => {
    const workspace = resolveStatuslineWorkspace([], '');
    expect(workspace).toBe(process.cwd());
  });

  it('readStdin returns without hanging when stdin stays open', async () => {
    const input = new PassThrough();
    const original = process.stdin;
    Object.defineProperty(process, 'stdin', { value: input, configurable: true });

    try {
      const readPromise = readStdin(200);
      input.write(JSON.stringify({ cwd: '/open-stdin-workspace' }));
      const stdin = await readPromise;
      expect(stdin).toContain('/open-stdin-workspace');
    } finally {
      Object.defineProperty(process, 'stdin', { value: original, configurable: true });
    }
  });

  describe('backend display passthrough (NOT-296)', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    async function runWithStubBackend(displayLine: string): Promise<{
      code: number;
      output: string;
    }> {
      // Stub the transport instead of binding loopback: the CLI prints
      // whatever displayLine the backend resolves — no guessing, no rewrite.
      vi.stubEnv('AGENT_DECK_BACKEND_PORT', '1111');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { displayLine } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const chunks: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;

      try {
        const code = await runStatusline(['--workspace', '/repo']);
        return { code, output: chunks.join('') };
      } finally {
        process.stdout.write = originalWrite;
      }
    }

    it('prints a single live session displayLine verbatim', async () => {
      const line = '◆ Solo Deck · 1 MCP · 0 keys · 2 playbooks · ⌘brook';
      const { code, output } = await runWithStubBackend(line);
      expect(code).toBe(0);
      expect(output).toBe(`${line}\n`);
    });

    it('passes the neutral ambiguity line through without naming a deck', async () => {
      const line = '◆ Agent Deck · multiple session decks · see chat receipt';
      const { code, output } = await runWithStubBackend(line);
      expect(code).toBe(0);
      expect(output).toBe(`${line}\n`);
      expect(output).toContain('multiple session decks');
    });

    it('passes an agreed multi-session line with its session count', async () => {
      const line = '◆ Shared Deck · 1 MCP · 0 keys · 0 playbooks · 2 sessions';
      const { code, output } = await runWithStubBackend(line);
      expect(code).toBe(0);
      expect(output).toBe(`${line}\n`);
      expect(output).toContain('2 sessions');
    });
  });

  describe('real backend resolution into the CLI (NOT-296 repair)', () => {
    // The fetch stub below delegates to the real backend `resolveDeckDisplay`
    // over seeded registry entries instead of returning a hard-coded line, so
    // these tests fail if backend resolution ever names a deck it should not.
    let tmpHome: string;
    let db: DatabaseManager;
    let registry: LiveDisplayRegistry;

    afterEach(async () => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      await db?.close();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    async function seedTwoSessions(source: 'launch' | 'session_override'): Promise<{
      workspace: string;
      deckAName: string;
      deckBName: string;
    }> {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-statusline-e2e-'));
      vi.stubEnv('AGENT_DECK_HOME', tmpHome);
      db = new DatabaseManager(path.join(tmpHome, 'agent_deck.db'));
      registry = new LiveDisplayRegistry();
      const workspace = path.join(tmpHome, 'repo');
      const deckA = await db.createDeck({ name: 'Alpha Deck' });
      const deckB = await db.createDeck({ name: 'Beta Deck' });
      const stamp = '2026-09-28T00:00:00.000Z';
      registry.upsert({
        mcpSessionId: 'mcp-e2e-1',
        workspaceRoot: workspace,
        deckId: deckA.id,
        deckName: deckA.name,
        source,
        updatedAt: stamp,
        cardCounts: { mcp: 0, credentials: 0, playbooks: 0 },
      });
      registry.upsert({
        mcpSessionId: 'mcp-e2e-2',
        workspaceRoot: workspace,
        deckId: deckB.id,
        deckName: deckB.name,
        source,
        updatedAt: stamp,
        cardCounts: { mcp: 0, credentials: 0, playbooks: 0 },
      });

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = new URL(String(input));
        const display = await resolveDeckDisplay(
          { workspaceRoot: url.searchParams.get('workspaceRoot') ?? '' },
          db,
          registry,
        );
        return new Response(JSON.stringify({ success: true, data: display }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      return { workspace, deckAName: deckA.name, deckBName: deckB.name };
    }

    async function runWorkspace(workspace: string): Promise<{ code: number; output: string }> {
      const chunks: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        const code = await runStatusline(['--workspace', workspace]);
        return { code, output: chunks.join('') };
      } finally {
        process.stdout.write = originalWrite;
      }
    }

    it('two disagreeing registry entries reach the CLI as the neutral line', async () => {
      const { workspace, deckAName, deckBName } = await seedTwoSessions('launch');
      const { code, output } = await runWorkspace(workspace);
      expect(code).toBe(0);
      expect(output).toContain('multiple session decks');
      expect(output).toContain('chat receipt');
      expect(output).not.toContain(deckAName);
      expect(output).not.toContain(deckBName);
    });

    it('two agreeing registry entries reach the CLI naming the common deck', async () => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-statusline-e2e-'));
      vi.stubEnv('AGENT_DECK_HOME', tmpHome);
      db = new DatabaseManager(path.join(tmpHome, 'agent_deck.db'));
      registry = new LiveDisplayRegistry();
      const workspace = path.join(tmpHome, 'repo');
      const deck = await db.createDeck({ name: 'Shared Deck' });
      const stamp = '2026-09-28T00:00:00.000Z';
      for (const mcpSessionId of ['mcp-e2e-agree-1', 'mcp-e2e-agree-2']) {
        registry.upsert({
          mcpSessionId,
          workspaceRoot: workspace,
          deckId: deck.id,
          deckName: deck.name,
          source: 'launch',
          updatedAt: stamp,
          cardCounts: { mcp: 0, credentials: 0, playbooks: 0 },
        });
      }
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = new URL(String(input));
        const display = await resolveDeckDisplay(
          { workspaceRoot: url.searchParams.get('workspaceRoot') ?? '' },
          db,
          registry,
        );
        return new Response(JSON.stringify({ success: true, data: display }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const { code, output } = await runWorkspace(workspace);
      expect(code).toBe(0);
      expect(output).toContain('Shared Deck');
      expect(output).toContain('2 sessions');
    });
  });

  it('runStatusline completes when stdin stays open', async () => {
    const input = new PassThrough();
    const original = process.stdin;
    Object.defineProperty(process, 'stdin', { value: input, configurable: true });

    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const runPromise = runStatusline([]);
      input.write(JSON.stringify({ cwd: process.cwd() }));
      const code = await Promise.race([
        runPromise,
        new Promise<number>((_, reject) => {
          setTimeout(() => reject(new Error('runStatusline hung')), 3000);
        }),
      ]);
      expect(code).toBe(0);
      expect(chunks.join('')).toMatch(/^◆/);
    } finally {
      process.stdout.write = originalWrite;
      Object.defineProperty(process, 'stdin', { value: original, configurable: true });
    }
  });
});
