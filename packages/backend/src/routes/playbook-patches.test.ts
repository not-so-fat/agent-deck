import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_DECK_AGENT_CLIENT,
  AGENT_DECK_CLIENT_HEADER,
  AGENT_DECK_DASHBOARD_CLIENT,
} from '@agent-deck/shared';
import { DatabaseManager } from '../models/database';
import { PlaybookManager } from '../playbooks/playbook-manager';
import { PatchManager } from '../playbooks/patch-manager';
import { registerPlaybookPatchRoutes } from './playbook-patches';
import { dashboardAuthHeaders } from '../test/auth-fixtures';

const dashboardHeaders = dashboardAuthHeaders();
const agentHeaders = {
  [AGENT_DECK_CLIENT_HEADER]: AGENT_DECK_AGENT_CLIENT,
};

describe('playbook-patches routes', () => {
  let dbPath: string;
  let db: DatabaseManager;
  let playbookManager: PlaybookManager;
  let patchManager: PatchManager;
  let app: ReturnType<typeof Fastify>;
  let playbookId: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `agent-deck-patch-routes-${Date.now()}.db`);
    db = new DatabaseManager(dbPath);
    playbookManager = new PlaybookManager(db);
    patchManager = new PatchManager(db, playbookManager);
    const playbook = await playbookManager.create({
      title: 'PR summary',
      body: '## Gotchas\n- Keep it short.\n',
      triggers: ['summarize PR'],
    });
    playbookId = playbook.id;

    app = Fastify();
    app.decorate('db', db);
    app.decorate('playbookManager', playbookManager);
    app.decorate('patchManager', patchManager);
    await app.register(registerPlaybookPatchRoutes, { prefix: '/api/playbook-patches' });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('returns 409 when propose ops do not resolve', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/playbook-patches',
      headers: agentHeaders,
      payload: {
        kind: 'update',
        playbook_id: playbookId,
        ops: [
          {
            op: 'amend_item',
            section: 'Gotchas',
            anchor: '- This line does not exist.',
            text: '- Nope.',
          },
        ],
        rationale: 'test anchor miss',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/anchor/i);
  });

  it('returns 409 when propose ops produce no change', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/playbook-patches',
      headers: agentHeaders,
      payload: {
        kind: 'update',
        playbook_id: playbookId,
        ops: [{ op: 'set_triggers', triggers: ['summarize PR'] }],
        rationale: 'noop',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/no change/i);
  });

  it('creates a proposal and serves preview for dashboard', async () => {
    const proposed = await app.inject({
      method: 'POST',
      url: '/api/playbook-patches',
      headers: agentHeaders,
      payload: {
        kind: 'update',
        playbook_id: playbookId,
        ops: [{ op: 'add_item', section: 'Gotchas', text: 'Include Test plan section' }],
        rationale: 'User correction',
        evidence: {
          failure_summary: 'Missed test plan',
          user_feedback_excerpt: 'you missed Test plan',
        },
      },
    });
    expect(proposed.statusCode).toBe(201);
    const body = proposed.json().data as {
      id: string;
      kind: string;
      signal: { id: string } | null;
    };
    expect(body.kind).toBe('update');
    expect(body.signal?.id).toMatch(/^fs_/);
    const patchId = body.id;

    const preview = await app.inject({
      method: 'GET',
      url: `/api/playbook-patches/${patchId}/preview`,
      headers: dashboardHeaders,
    });
    expect(preview.statusCode).toBe(200);
    const data = preview.json().data;
    expect(data.after.body).toContain('Include Test plan section');
    expect(data.before.body).not.toContain('Include Test plan section');
  });

  it('keeps a flat { id, playbookId } response shape for the agent-dealer client contract', async () => {
    // agent-dealer's proposePlaybookPatch adapter reads json.data.id / .playbookId directly
    // (packages/server/src/adapters/agent-deck.ts in the sibling agent-dealer repo) and
    // throws if data.id is missing. Extra fields (e.g. `signal`) are fine; nesting patch
    // fields under `data.patch` is not — that silently breaks every dealer-sourced proposal.
    const proposed = await app.inject({
      method: 'POST',
      url: '/api/playbook-patches',
      headers: { [AGENT_DECK_CLIENT_HEADER]: 'dealer', 'x-agent-deck-source-ref': 'run-1' },
      payload: {
        kind: 'update',
        playbook_id: playbookId,
        ops: [{ op: 'add_item', section: 'Gotchas', text: 'Dealer-sourced gotcha' }],
        rationale: 'Reflect proposal',
      },
    });
    expect(proposed.statusCode).toBe(201);
    const body = proposed.json().data as { id: string; playbookId: string | null };
    expect(body.id).toMatch(/^pp_/);
    expect(body.playbookId).toBe(playbookId);
  });

  it('rejects list without dashboard client', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/playbook-patches?status=proposed',
      headers: agentHeaders,
    });
    expect(response.statusCode).toBe(403);
  });

  it('lists proposed patches with display title and deck names', async () => {
    const deck = await db.createDeck({ name: 'Product demo', isActive: false });
    await playbookManager.addToDeck({ deckId: deck.id, playbookId });

    const proposed = await app.inject({
      method: 'POST',
      url: '/api/playbook-patches',
      headers: agentHeaders,
      payload: {
        kind: 'update',
        playbook_id: playbookId,
        ops: [{ op: 'add_item', section: 'Gotchas', text: 'Include Test plan section' }],
        rationale: 'User correction',
      },
    });
    expect(proposed.statusCode).toBe(201);

    const list = await app.inject({
      method: 'GET',
      url: '/api/playbook-patches?status=proposed',
      headers: dashboardHeaders,
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json().data as Array<{ displayTitle: string; deckNames: string[] }>;
    expect(rows[0]?.displayTitle).toBe('PR summary');
    expect(rows[0]?.deckNames).toEqual(['Product demo']);
  });
});
