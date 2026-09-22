import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readAdminSecret } from './admin-secret';
import { resolveSystemBrowserOpener } from './dashboard-open';
import { runOpenCommand } from './open';
import { probeAgentDeck } from './ports';

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: mockSpawn };
});

vi.mock('./admin-secret', () => ({ readAdminSecret: vi.fn() }));
vi.mock('./ports', () => ({ probeAgentDeck: vi.fn() }));

type FakeChild = EventEmitter & { unref: () => void };

function fakeSpawn(emit: (child: FakeChild) => void) {
  const child = new EventEmitter() as FakeChild;
  child.unref = () => {};
  process.nextTick(() => emit(child));
  return child;
}

function spawnSuccess() {
  mockSpawn.mockReturnValueOnce(fakeSpawn((child) => child.emit('spawn')));
}

function spawnEnoent(opener: string) {
  mockSpawn.mockReturnValueOnce(
    fakeSpawn((child) => {
      child.emit('error', Object.assign(new Error(`spawn ${opener} ENOENT`), { code: 'ENOENT' }));
    }),
  );
}

function backendReady() {
  vi.mocked(probeAgentDeck).mockResolvedValue({
    backendUp: true,
    backendUrl: 'http://127.0.0.1:1111',
  } as Awaited<ReturnType<typeof probeAgentDeck>>);
  vi.mocked(readAdminSecret).mockResolvedValue('admin-secret-for-tests');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { nonce: 'nonce_123' } }),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  mockSpawn.mockReset();
  vi.mocked(probeAgentDeck).mockReset();
  vi.mocked(readAdminSecret).mockReset();
  vi.restoreAllMocks();
});

describe('runOpenCommand browser reporting (NOT-237)', () => {
  it('keeps the success message wording unchanged when the opener spawns', async () => {
    backendReady();
    spawnSuccess();
    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message: string) => {
      logs.push(String(message));
    });
    vi.spyOn(console, 'error').mockImplementation((message: string) => {
      errors.push(String(message));
    });

    const code = await runOpenCommand(['--path', '/deck-switch/approve?request=req_1']);

    expect(code).toBe(0);
    expect(logs).toContain('Opened dashboard in your browser.');
    expect(errors).toHaveLength(0);
  });

  it('names the failure and the fallback instead of claiming success', async () => {
    backendReady();
    const opener = resolveSystemBrowserOpener();
    spawnEnoent(opener);
    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message: string) => {
      logs.push(String(message));
    });
    vi.spyOn(console, 'error').mockImplementation((message: string) => {
      errors.push(String(message));
    });

    const code = await runOpenCommand(['--path', '/deck-switch/approve?request=req_1']);

    expect(code).toBe(1);
    expect(logs).not.toContain('Opened dashboard in your browser.');
    const output = errors.join('\n');
    expect(output).toContain(opener);
    expect(output).toContain('ENOENT');
    expect(output).toContain('agent-deck open --path');
    expect(output).toContain('menubar');
  });
});
