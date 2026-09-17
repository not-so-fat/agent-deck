import { formatMcpSessionStatus, formatPortConflict, isTcpPortOpen, probeAgentDeck } from './ports';
import { isProcessAlive, readRunState } from './runtime-state';
import { getAgentDeckVersion } from './version';
import { readCliBackendPort, parseCliMcpPort } from './defaults';
import { formatDashboardStatusLine } from './dashboard-open';
import { formatCursorMcpInspection, inspectCursorMcpConfig } from './cursor-mcp-inspect';
import {
  formatLastStartFailureLines,
  formatLastStopLines,
  readLastStartFailure,
  readLastStop,
} from './shutdown-reason';
import { resolveDaemonLogPath } from './daemon-logs';

export async function runStatus(): Promise<number> {
  const host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';
  const backendPort = readCliBackendPort();
  const mcpPort = parseCliMcpPort(process.env.AGENT_DECK_MCP_PORT);

  const probe = await probeAgentDeck(host, backendPort, mcpPort);
  const state = readRunState();

  console.log(`CLI package ${getAgentDeckVersion()}`);
  console.log(`Configured host ${host}  API :${backendPort}  MCP :${mcpPort}`);
  console.log('');

  if (probe.backendUp && probe.mcpUp) {
    console.log('Status: running');
    console.log(`  ${formatDashboardStatusLine()}`);
    console.log(`  MCP        ${probe.mcpUrl}/mcp`);
    if (probe.backendVersion) {
      console.log(`  Backend    v${probe.backendVersion}`);
    }
    for (const line of formatMcpSessionStatus(probe.mcpSessions)) {
      console.log(line);
    }
  } else if (probe.backendUp || probe.mcpUp) {
    console.log('Status: partial (one service up, one down — try agent-deck stop && agent-deck start)');
    console.log(`  Backend    ${probe.backendUp ? 'up' : 'down'}  ${probe.backendUrl}`);
    console.log(`  MCP        ${probe.mcpUp ? 'up' : 'down'}  ${probe.mcpUrl}`);
  } else {
    console.log('Status: not running');
  }

  if (state) {
    console.log('');
    console.log('Last run.json:');
    console.log(`  started ${state.startedAt}`);
    console.log(
      `  pids backend=${state.backendPid}${isProcessAlive(state.backendPid) ? '' : ' (dead)'}  ` +
        `mcp=${state.mcpPid}${isProcessAlive(state.mcpPid) ? '' : ' (dead)'}  ` +
        `cli=${state.cliPid}${isProcessAlive(state.cliPid) ? '' : ' (dead)'}`,
    );
  }

  // "Why did the deck stop?" — answered here instead of only in supervisor.log.
  // A failed start is a separate question and keeps its own record.
  console.log('');
  for (const line of formatLastStopLines(readLastStop())) {
    console.log(line);
  }
  for (const line of formatLastStartFailureLines(readLastStartFailure())) {
    console.log(line);
  }
  console.log(`  log     ${resolveDaemonLogPath('supervisor')}`);

  const [backendBusy, mcpBusy] = await Promise.all([
    isTcpPortOpen(host, backendPort),
    isTcpPortOpen(host, mcpPort),
  ]);

  if (backendBusy && !probe.backendUp) {
    console.log('');
    console.warn(formatPortConflict(backendPort, 'API/dashboard', host, false));
  }
  if (mcpBusy && !probe.mcpUp) {
    console.log('');
    console.warn(formatPortConflict(mcpPort, 'MCP', host, false));
  }

  // Read-only Cursor MCP inspector (NOT-52) — never rewrites mcp.json.
  const inspection = inspectCursorMcpConfig({
    endpoint: { host, mcpPort },
  });
  console.log('');
  console.log(formatCursorMcpInspection(inspection));

  return probe.backendUp && probe.mcpUp ? 0 : 1;
}
