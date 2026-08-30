import { afterEach, describe, expect, it } from 'vitest';

import {
  CLI_DEFAULT_BACKEND_PORT,
  CLI_DEFAULT_MCP_PORT,
  parseCliBackendPort,
  parseCliMcpPort,
  readCliBackendPort,
  resolveCliBackendPortEnv,
} from './defaults';

describe('cli defaults', () => {
  const previousBackendPort = process.env.AGENT_DECK_BACKEND_PORT;
  const previousPort = process.env.AGENT_DECK_PORT;

  afterEach(() => {
    if (previousBackendPort === undefined) {
      delete process.env.AGENT_DECK_BACKEND_PORT;
    } else {
      process.env.AGENT_DECK_BACKEND_PORT = previousBackendPort;
    }
    if (previousPort === undefined) {
      delete process.env.AGENT_DECK_PORT;
    } else {
      process.env.AGENT_DECK_PORT = previousPort;
    }
  });

  it('uses default ports for npx install', () => {
    expect(CLI_DEFAULT_BACKEND_PORT).toBe(1111);
    expect(CLI_DEFAULT_MCP_PORT).toBe(1110);
  });

  it('parses env overrides', () => {
    expect(parseCliBackendPort('9000')).toBe(9000);
    expect(parseCliMcpPort('9002')).toBe(9002);
  });

  it('falls back when env is invalid', () => {
    expect(parseCliBackendPort(undefined)).toBe(1111);
    expect(parseCliMcpPort('nope')).toBe(1110);
  });

  it('prefers AGENT_DECK_BACKEND_PORT, then AGENT_DECK_PORT, then CLI default', () => {
    delete process.env.AGENT_DECK_BACKEND_PORT;
    delete process.env.AGENT_DECK_PORT;
    expect(readCliBackendPort()).toBe(1111);

    process.env.AGENT_DECK_PORT = '8000';
    expect(readCliBackendPort()).toBe(8000);
    expect(resolveCliBackendPortEnv()).toBe('8000');

    process.env.AGENT_DECK_BACKEND_PORT = '9001';
    expect(readCliBackendPort()).toBe(9001);
    expect(resolveCliBackendPortEnv()).toBe('9001');
  });
});
