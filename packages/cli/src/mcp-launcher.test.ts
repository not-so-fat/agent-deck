import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_DECK_DECK_ID_HEADER,
  AGENT_DECK_WORKSPACE_HEADER,
} from '@agent-deck/shared';

import { NO_ASSIGNMENT_MESSAGE, resolveMcpLaunchPlan } from './mcp-launcher';
import { writeAssignment } from './assignment';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-mcp-launch-'));
  tmpDirs.push(dir);
  return dir;
}

describe('mcp-launch assignment headers', () => {
  const endpoint = { host: '127.0.0.1', mcpPort: 1110 };

  it('sends deck + workspace headers from a v3 assignment (no Authorization)', async () => {
    const workspace = makeWorkspace();
    await writeAssignment(workspace, {
      deckId: 'deck-v3',
      deckName: 'dev',
      mcpUrl: 'http://127.0.0.1:1110/mcp',
    });

    const plan = await resolveMcpLaunchPlan(workspace, endpoint);
    expect('error' in plan).toBe(false);
    if ('error' in plan) {
      return;
    }
    expect(plan.headers).toEqual([
      `${AGENT_DECK_DECK_ID_HEADER}: deck-v3`,
      `${AGENT_DECK_WORKSPACE_HEADER}: ${workspace}`,
    ]);
    expect(plan.headers.join('\n')).not.toMatch(/Authorization/i);
  });

  it('migrates a v2 grant file to v3 and sends the deck header', async () => {
    const workspace = makeWorkspace();
    fs.mkdirSync(path.join(workspace, '.agent-deck'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.agent-deck', 'use.json'),
      `${JSON.stringify({
        version: 2,
        workspaceKey: 'wk',
        grantId: 'gr',
        secret: 'super-secret-value-at-least-32-chars!!',
        deckId: 'deck-v2',
        deckName: 'legacy',
        mcpUrl: 'http://127.0.0.1:1110/mcp',
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
    );

    const plan = await resolveMcpLaunchPlan(workspace, endpoint);
    expect('error' in plan).toBe(false);
    if ('error' in plan) {
      return;
    }
    expect(plan.deckId).toBe('deck-v2');
    expect(plan.headers[0]).toBe(`${AGENT_DECK_DECK_ID_HEADER}: deck-v2`);

    const migrated = JSON.parse(
      fs.readFileSync(path.join(workspace, '.agent-deck', 'use.json'), 'utf8'),
    ) as { version: number; deckId: string; secret?: string };
    expect(migrated.version).toBe(3);
    expect(migrated.deckId).toBe('deck-v2');
    expect(migrated.secret).toBeUndefined();
  });

  it('exits with the ticket message when no assignment exists', async () => {
    const workspace = makeWorkspace();
    const plan = await resolveMcpLaunchPlan(workspace, endpoint);
    expect(plan).toEqual({ error: NO_ASSIGNMENT_MESSAGE });
  });
});
