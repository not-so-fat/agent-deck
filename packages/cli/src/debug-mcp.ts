import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AGENT_DECK_DECK_ID_HEADER,
  AGENT_DECK_WORKSPACE_HEADER,
} from '@agent-deck/shared';
import { readAssignment } from './assignment';
import { isTcpPortOpen, listListeningPids, probeAgentDeck } from './ports';
import { readCliBackendPort, parseCliMcpPort } from './defaults';

async function fetchText(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, body: message };
  }
}

export async function probeMcpInitialize(
  mcpUrl: string,
  launchHeaders: Record<string, string> = {},
): Promise<{ ok: boolean; detail: string }> {
  const endpoint = `${mcpUrl}/mcp`;
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agent-deck-doctor', version: '1.0.0' },
    },
  };

  const result = await fetchText(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...launchHeaders,
    },
    body: JSON.stringify(payload),
  });

  if (result.status === 0) {
    return { ok: false, detail: `POST ${endpoint} failed: ${result.body}` };
  }

  if (result.ok || result.status === 200) {
    return { ok: true, detail: `POST ${endpoint} → HTTP ${result.status}` };
  }

  return {
    ok: false,
    detail: `POST ${endpoint} → HTTP ${result.status}: ${result.body.slice(0, 200)}`,
  };
}

function readClaudeMcpEntry(): string | null {
  const configPath = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      mcpServers?: Record<string, { type?: string; url?: string }>;
    };
    const entry = parsed.mcpServers?.['agent-deck'];
    if (!entry) {
      return 'agent-deck not in ~/.claude.json mcpServers';
    }
    return JSON.stringify(entry);
  } catch (error) {
    return `Could not parse ~/.claude.json: ${error instanceof Error ? error.message : error}`;
  }
}

export async function runDebugMcp(): Promise<number> {
  const host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';
  const backendPort = readCliBackendPort();
  const mcpPort = parseCliMcpPort(process.env.AGENT_DECK_MCP_PORT);
  const mcpUrl = `http://${host}:${mcpPort}`;
  const workspaceRoot = path.resolve(process.env.AGENT_DECK_WORKSPACE?.trim() || process.cwd());
  const assignment = await readAssignment(workspaceRoot);

  console.log('Agent Deck MCP debug');
  console.log(`  host ${host}  API :${backendPort}  MCP :${mcpPort}`);
  console.log('');

  let ok = true;

  const [backendTcp, mcpTcp] = await Promise.all([
    isTcpPortOpen(host, backendPort),
    isTcpPortOpen(host, mcpPort),
  ]);

  console.log(`TCP :${backendPort} (API)     ${backendTcp ? 'open' : 'closed/refused'}`);
  console.log(`TCP :${mcpPort} (MCP)     ${mcpTcp ? 'open' : 'closed/refused'}`);

  const backendPids = listListeningPids(backendPort);
  const mcpPids = listListeningPids(mcpPort);
  if (backendPids.length > 0) {
    console.log(`  listener(s) on :${backendPort}: ${backendPids.join(', ')}`);
  }
  if (mcpPids.length > 0) {
    console.log(`  listener(s) on :${mcpPort}: ${mcpPids.join(', ')}`);
  }
  console.log('');

  const probe = await probeAgentDeck(host, backendPort, mcpPort);
  if (probe.backendUp) {
    console.log(`OK  GET ${probe.backendUrl}/health`);
  } else {
    console.log(`FAIL GET ${probe.backendUrl}/health`);
    ok = false;
  }

  if (probe.mcpUp) {
    console.log(`OK  GET ${probe.mcpUrl}/health`);
  } else {
    console.log(`FAIL GET ${probe.mcpUrl}/health`);
    ok = false;
  }

  const backendStatus = await fetchText(`${probe.mcpUrl}/backend-status`);
  if (backendStatus.ok && backendStatus.body.includes('"connected":true')) {
    console.log(`OK  GET ${probe.mcpUrl}/backend-status (MCP → API)`);
  } else if (backendStatus.status > 0) {
    console.log(`WARN GET ${probe.mcpUrl}/backend-status → HTTP ${backendStatus.status}`);
    console.log(`     ${backendStatus.body.slice(0, 160)}`);
    ok = false;
  } else {
    console.log(`FAIL GET ${probe.mcpUrl}/backend-status (${backendStatus.body})`);
    ok = false;
  }

  const launchHeaders: Record<string, string> = {};
  if (assignment) {
    launchHeaders[AGENT_DECK_DECK_ID_HEADER] = assignment.deckId;
    launchHeaders[AGENT_DECK_WORKSPACE_HEADER] = workspaceRoot;
    console.log(`OK  Folder assignment ${assignment.deckName} (${assignment.source}) @ ${workspaceRoot}`);
  } else {
    console.log(`WARN No v2/v3 folder assignment @ ${workspaceRoot}`);
    console.log('     Run `agent-deck use <deck>` for an IDE folder, or supply the deck header in an unattended launch.');
    ok = false;
  }

  const init = await probeMcpInitialize(probe.mcpUrl, launchHeaders);
  if (init.ok) {
    console.log(`OK  ${init.detail} (same deck headers mcp-launch uses)`);
  } else {
    console.log(`FAIL ${init.detail}`);
    ok = false;
  }

  console.log('');
  const claudeEntry = readClaudeMcpEntry();
  if (claudeEntry) {
    console.log(`Claude config (~/.claude.json agent-deck): ${claudeEntry}`);
    if (!claudeEntry.includes('"mcp-launch"')) {
      console.log('WARN expected the trusted `agent-deck mcp-launch` stdio entry; a bare HTTP URL cannot select a deck');
      ok = false;
    }
  } else {
    console.log('Claude config: no agent-deck entry in ~/.claude.json');
    console.log('  Fix: agent-deck setup --client claude');
  }

  console.log('');
  if (ok) {
    console.log('MCP stack looks healthy. If Claude still fails:');
    console.log('  1. Restart Claude Code (full quit, not reload)');
    console.log('  2. Start Agent Deck before opening Claude');
    console.log('  3. claude mcp list');
  } else if (probe.backendUp && !probe.mcpUp) {
    console.log('Diagnosis: API up, MCP down (partial start).');
    console.log('  Fix: npx @agent-deck/cli stop && npx @agent-deck/cli start');
  } else if (!probe.backendUp && !probe.mcpUp) {
    console.log('Diagnosis: Agent Deck not running.');
    console.log('  Fix: npx @agent-deck/cli start');
  } else {
    console.log('Diagnosis: MCP reachable but launch selection, host config, or API link failed — see WARN/FAIL lines above.');
  }

  return ok ? 0 : 1;
}
