// Holds a real `agent-deck mcp-launch` bridge open as a sibling Claude session.
import { spawn } from 'node:child_process';
const [ad, ws, sid, log] = process.argv.slice(2);
const fs = await import('node:fs');
const out = fs.createWriteStream(log);
const child = spawn(ad, ['mcp-launch'], { cwd: ws, env: { ...process.env, CLAUDE_CODE_SESSION_ID: sid }, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => out.write(`[stdout] ${d}`));
child.stderr.on('data', (d) => out.write(`[stderr] ${d}`));
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.307' } } });
setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/initialized' }), 1500);
setInterval(() => send({ jsonrpc: '2.0', id: Date.now(), method: 'ping' }), 20000);
process.on('SIGTERM', () => { child.stdin.end(); setTimeout(() => process.exit(0), 1000); });
