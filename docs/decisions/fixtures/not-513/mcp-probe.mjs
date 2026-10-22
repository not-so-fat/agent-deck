#!/usr/bin/env node
// Throwaway stdio MCP server: logs env + received messages, answers minimal handshake.
import fs from 'node:fs';
const LOG = '/tmp/not513-probe/mcp-probe.log';
const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + '\n');
log({ event: 'spawn', time: new Date().toISOString(), pid: process.pid,
  env_session_like: Object.fromEntries(Object.entries(process.env).filter(([k]) => /session|claude|mcp|task|workspace|transcript|run|agent/i.test(k))),
  env_names: Object.keys(process.env).sort() });
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    log({ event: 'msg', time: new Date().toISOString(), method: msg.method ?? null, id: msg.id ?? null,
      params: msg.method === 'initialize' ? msg.params : undefined });
    if (msg.method === 'initialize' && msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        result: { protocolVersion: '2024-11-05', capabilities: { tools: {} },
          serverInfo: { name: 'probe', version: '0.0.1' } } }) + '\n');
    } else if (msg.method === 'tools/list' && msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) + '\n');
    } else if (msg.id !== undefined && msg.method && msg.method.startsWith('ping')) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
    }
  }
});
