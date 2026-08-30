import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listToolNamesForProfile } from './register';
import {
  callTool,
  listTools,
  openSession,
  startMcpServer,
} from './test-harness';
import type { AgentDeckMCPServer } from '../mcp-server';

const DECK_ID = '33333333-3333-4333-8333-333333333333';
const SERVICE_ID = 'svc-linear';
const PLAYBOOK_ID = 'pb_triage';
const CREDENTIAL_ID = 'cred_ashby';

type DeckState = {
  id: string;
  name: string;
  services: Array<{ id: string; name: string; type: string }>;
  credentials: Array<{ id: string; label: string; envName: string }>;
  playbooks: Array<{ id: string; title: string; triggers: string[]; body?: string }>;
};

type StubBackend = {
  port: number;
  deck: DeckState;
  collectionServices: Array<{ id: string; name: string; type: string }>;
  collectionPlaybooks: Array<{ id: string; title: string; body: string; triggers: string[] }>;
  collectionCredentials: Array<{ id: string; label: string; envName: string }>;
  liveDisplayBodies: unknown[];
  serviceCalls: Array<{ serviceId: string; toolName: string; arguments: unknown }>;
  close: () => Promise<void>;
};

function startRichStubBackend(): Promise<StubBackend> {
  const deck: DeckState = {
    id: DECK_ID,
    name: 'dev',
    services: [],
    credentials: [],
    playbooks: [],
  };

  const collectionServices = [
    { id: SERVICE_ID, name: 'Linear', type: 'mcp' },
    { id: 'svc-slack', name: 'Slack', type: 'mcp' },
  ];
  const collectionPlaybooks = [
    {
      id: PLAYBOOK_ID,
      title: 'Inbox triage',
      body: '# Steps\n1. Check inbox',
      triggers: ['check inbox', 'triage'],
    },
  ];
  const collectionCredentials = [
    { id: CREDENTIAL_ID, label: 'Ashby', envName: 'ASHBY_API_KEY' },
  ];

  const liveDisplayBodies: unknown[] = [];
  const serviceCalls: StubBackend['serviceCalls'] = [];
  const decksById = new Map<string, { id: string; name: string }>([
    [DECK_ID, { id: DECK_ID, name: 'dev' }],
  ]);

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const respond = (body: unknown, status = 200) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      };
      const url = req.url ?? '';
      const method = req.method ?? 'GET';
      let body: Record<string, unknown> = {};
      if (raw) {
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = {};
        }
      }

      if (method === 'GET' && url === '/api/scope/deck') {
        respond({ success: true, data: { ...deck } });
        return;
      }
      if (method === 'GET' && url === `/api/decks/${DECK_ID}`) {
        respond({ success: true, data: decksById.get(DECK_ID) });
        return;
      }
      if (method === 'GET' && url.startsWith('/api/decks/') && url.split('/').length === 4) {
        const id = url.split('/')[3];
        const found = decksById.get(id);
        if (!found) {
          respond({ success: false, error: 'Deck not found' }, 404);
          return;
        }
        respond({ success: true, data: found });
        return;
      }
      if (method === 'GET' && url === '/api/decks') {
        respond({ success: true, data: [...decksById.values()] });
        return;
      }
      if (method === 'POST' && url === '/api/decks') {
        const id = `deck-${decksById.size + 1}`;
        const created = {
          id,
          name: String(body.name ?? 'untitled'),
        };
        decksById.set(id, created);
        respond({ success: true, data: created });
        return;
      }
      if (method === 'POST' && url === '/api/scope/live-display') {
        liveDisplayBodies.push(body);
        respond({ success: true, data: { badge: 'moss' } });
        return;
      }
      if (method === 'POST' && /^\/api\/scope\/live-display\/.+\/touch$/.test(url)) {
        respond({ success: true });
        return;
      }
      if (method === 'GET' && url === '/api/services') {
        respond({ success: true, data: collectionServices });
        return;
      }
      if (method === 'GET' && url === '/api/credentials/collection') {
        respond({ success: true, data: collectionCredentials });
        return;
      }
      if (method === 'GET' && url === '/api/credentials') {
        respond({ success: true, data: deck.credentials });
        return;
      }
      if (method === 'GET' && url === '/api/playbooks/collection') {
        respond({ success: true, data: collectionPlaybooks });
        return;
      }
      if (method === 'GET' && url === '/api/playbooks/summaries') {
        respond({
          success: true,
          data: deck.playbooks.map(({ id, title, triggers }) => ({ id, title, triggers })),
        });
        return;
      }
      if (method === 'GET' && url.startsWith('/api/playbooks/')) {
        const id = decodeURIComponent(url.slice('/api/playbooks/'.length));
        const onDeck = deck.playbooks.find((playbook) => playbook.id === id);
        const inCollection = collectionPlaybooks.find((playbook) => playbook.id === id);
        const playbook = onDeck ?? inCollection;
        if (!playbook) {
          respond({ success: false, error: 'Playbook not found' }, 404);
          return;
        }
        respond({
          success: true,
          data: {
            ...playbook,
            body: playbook.body ?? inCollection?.body ?? '',
            dependsOnCredentialIds: [],
            dependsOnServiceIds: [],
          },
        });
        return;
      }
      if (method === 'PUT' && url.startsWith('/api/playbooks/')) {
        const id = decodeURIComponent(url.slice('/api/playbooks/'.length));
        const playbook = collectionPlaybooks.find((item) => item.id === id);
        if (!playbook) {
          respond({ success: false, error: 'Playbook not found' }, 404);
          return;
        }
        if (typeof body.body === 'string') {
          playbook.body = body.body;
        }
        if (typeof body.title === 'string') {
          playbook.title = body.title;
        }
        const onDeck = deck.playbooks.find((item) => item.id === id);
        if (onDeck) {
          onDeck.body = playbook.body;
          onDeck.title = playbook.title;
        }
        respond({ success: true, data: playbook });
        return;
      }
      if (method === 'POST' && url === `/api/decks/${DECK_ID}/services`) {
        const serviceId = String(body.serviceId);
        const service = collectionServices.find((item) => item.id === serviceId);
        if (!service) {
          respond({ success: false, error: 'Service not found' }, 404);
          return;
        }
        if (!deck.services.some((item) => item.id === serviceId)) {
          deck.services.push(service);
        }
        respond({ success: true });
        return;
      }
      if (method === 'DELETE' && url === `/api/decks/${DECK_ID}/services`) {
        const serviceId = String(body.serviceId);
        deck.services = deck.services.filter((item) => item.id !== serviceId);
        respond({ success: true });
        return;
      }
      if (method === 'POST' && url === `/api/decks/${DECK_ID}/playbooks`) {
        const playbookId = String(body.playbookId);
        const playbook = collectionPlaybooks.find((item) => item.id === playbookId);
        if (!playbook) {
          respond({ success: false, error: 'Playbook not found' }, 404);
          return;
        }
        if (!deck.playbooks.some((item) => item.id === playbookId)) {
          deck.playbooks.push({
            id: playbook.id,
            title: playbook.title,
            triggers: playbook.triggers,
            body: playbook.body,
          });
        }
        respond({ success: true });
        return;
      }
      if (method === 'DELETE' && url === `/api/decks/${DECK_ID}/playbooks`) {
        const playbookId = String(body.playbookId);
        deck.playbooks = deck.playbooks.filter((item) => item.id !== playbookId);
        respond({ success: true });
        return;
      }
      if (method === 'POST' && url === `/api/decks/${DECK_ID}/credentials`) {
        const credentialId = String(body.credentialId);
        const credential = collectionCredentials.find((item) => item.id === credentialId);
        if (!credential) {
          respond({ success: false, error: 'Credential not found' }, 404);
          return;
        }
        if (!deck.credentials.some((item) => item.id === credentialId)) {
          deck.credentials.push(credential);
        }
        respond({ success: true });
        return;
      }
      if (method === 'DELETE' && url === `/api/decks/${DECK_ID}/credentials`) {
        const credentialId = String(body.credentialId);
        deck.credentials = deck.credentials.filter((item) => item.id !== credentialId);
        respond({ success: true });
        return;
      }
      if (method === 'POST' && url === `/api/services/${SERVICE_ID}/call`) {
        serviceCalls.push({
          serviceId: SERVICE_ID,
          toolName: String(body.toolName),
          arguments: body.arguments,
        });
        respond({ success: true, data: { ok: true, echo: body.arguments } });
        return;
      }
      if (method === 'GET' && url === `/api/services/${SERVICE_ID}/tools`) {
        respond({
          success: true,
          data: [{ name: 'list_issues', description: 'List issues' }],
        });
        return;
      }

      respond({ success: false, error: `stub: unhandled ${method} ${url}` }, 500);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        deck,
        collectionServices,
        collectionPlaybooks,
        collectionCredentials,
        liveDisplayBodies,
        serviceCalls,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe('MCP golden paths (CI)', () => {
  let stub: StubBackend;
  let port: number;
  let mcpServer: AgentDeckMCPServer;
  let rpcId = 1;

  beforeAll(async () => {
    stub = await startRichStubBackend();
    const started = await startMcpServer(`http://127.0.0.1:${stub.port}`, 'standard');
    port = started.port;
    mcpServer = started.server;
  });

  afterAll(async () => {
    await mcpServer.stop();
    await stub.close();
  });

  async function nextSession(): Promise<string> {
    return openSession(port, rpcId++);
  }

  async function tool(sessionId: string, name: string, args: unknown = {}) {
    return callTool(port, sessionId, name, args, rpcId++);
  }

  it('S2: bind_workspace returns display_summary and registers live display', async () => {
    const sessionId = await nextSession();
    const bound = await tool(sessionId, 'bind_workspace', {
      workspaceRoot: '/tmp/golden-repo',
      deckId: DECK_ID,
    });
    expect(bound.deck_id).toBe(DECK_ID);
    expect(bound.display_summary).toContain('dev');
    expect(bound.display_summary).toContain('⌘moss');
    expect(stub.liveDisplayBodies.length).toBeGreaterThan(0);
  });

  it('S3: get_bound_deck lists services after link; call_service_tool proxies', async () => {
    const sessionId = await nextSession();
    await tool(sessionId, 'bind_workspace', {
      workspaceRoot: '/tmp/golden-repo',
      deckId: DECK_ID,
    });
    await tool(sessionId, 'manage_deck_card', {
      action: 'link',
      card_type: 'service',
      card_id: SERVICE_ID,
    });

    const deck = await tool(sessionId, 'get_bound_deck', {});
    expect(deck.name).toBe('dev');
    expect(deck.display_summary).toBeTruthy();
    const services = deck.services as Array<{ id: string }>;
    expect(services.some((service) => service.id === SERVICE_ID)).toBe(true);

    const tools = await tool(sessionId, 'list_service_tools', { serviceId: SERVICE_ID });
    expect(Array.isArray(tools) || (tools as { name?: string }).name || tools).toBeTruthy();

    const called = await tool(sessionId, 'call_service_tool', {
      serviceId: SERVICE_ID,
      toolName: 'list_issues',
      arguments: { limit: 1 },
    });
    expect(called.ok).toBe(true);
    expect(stub.serviceCalls.at(-1)?.toolName).toBe('list_issues');
  });

  it('S4–S5: playbook discover and get body (update_playbook is dashboard-only)', async () => {
    const sessionId = await nextSession();
    await tool(sessionId, 'bind_workspace', {
      workspaceRoot: '/tmp/golden-repo',
      deckId: DECK_ID,
    });
    await tool(sessionId, 'manage_deck_card', {
      action: 'link',
      card_type: 'playbook',
      card_id: PLAYBOOK_ID,
    });

    const deck = await tool(sessionId, 'get_bound_deck', {});
    const playbooks = deck.playbooks as Array<{ id: string; triggers: string[] }>;
    expect(playbooks.some((playbook) => playbook.id === PLAYBOOK_ID)).toBe(true);
    expect(playbooks.find((playbook) => playbook.id === PLAYBOOK_ID)?.triggers).toContain('check inbox');

    const full = await tool(sessionId, 'get_playbook', { playbook_id: PLAYBOOK_ID });
    expect(full.body).toContain('Steps');
  });

  it('S6–S7: manage_deck_card link/unlink; list_collection still has card', async () => {
    const sessionId = await nextSession();
    await tool(sessionId, 'bind_workspace', {
      workspaceRoot: '/tmp/golden-repo',
      deckId: DECK_ID,
    });

    await tool(sessionId, 'manage_deck_card', {
      action: 'link',
      card_type: 'credential',
      card_id: CREDENTIAL_ID,
    });
    let deck = await tool(sessionId, 'get_bound_deck', {});
    expect((deck.credentials as Array<{ id: string }>).some((c) => c.id === CREDENTIAL_ID)).toBe(true);

    await tool(sessionId, 'manage_deck_card', {
      action: 'unlink',
      card_type: 'credential',
      card_id: CREDENTIAL_ID,
    });
    deck = await tool(sessionId, 'get_bound_deck', {});
    expect((deck.credentials as Array<{ id: string }>).some((c) => c.id === CREDENTIAL_ID)).toBe(false);

    const collection = await tool(sessionId, 'list_collection', { card_type: 'credential' });
    expect(
      (collection.credentials as Array<{ id: string }>).some((c) => c.id === CREDENTIAL_ID),
    ).toBe(true);
  });

  it('S8: create_deck then bind_workspace', async () => {
    const sessionId = await nextSession();
    const created = await tool(sessionId, 'create_deck', {
      name: 'scratch',
    });
    expect(created.id).toBeTruthy();
    expect(created.name).toBe('scratch');

    const bound = await tool(sessionId, 'bind_workspace', {
      workspaceRoot: '/tmp/scratch-repo',
      deckId: created.id,
    });
    expect(bound.deck_id).toBe(created.id);
  });

  it('standard tools/list matches profile registry (no removed names)', async () => {
    const sessionId = await nextSession();
    const tools = await listTools(port, sessionId, rpcId++);
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...listToolNamesForProfile('standard')].sort());
    expect(names).not.toContain('list_playbooks');
    expect(names).not.toContain('delete_service');
  });
});
