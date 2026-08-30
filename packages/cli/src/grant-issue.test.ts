import { afterEach, describe, expect, it } from 'vitest';

import { parseCliBackendPort } from './defaults';

describe('grant-issue backend port resolution', () => {
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

  it('prefers AGENT_DECK_BACKEND_PORT, then AGENT_DECK_PORT, then CLI default', () => {
    delete process.env.AGENT_DECK_BACKEND_PORT;
    delete process.env.AGENT_DECK_PORT;
    expect(
      parseCliBackendPort(process.env.AGENT_DECK_BACKEND_PORT ?? process.env.AGENT_DECK_PORT),
    ).toBe(1111);

    process.env.AGENT_DECK_PORT = '8000';
    expect(
      parseCliBackendPort(process.env.AGENT_DECK_BACKEND_PORT ?? process.env.AGENT_DECK_PORT),
    ).toBe(8000);

    process.env.AGENT_DECK_BACKEND_PORT = '9001';
    expect(
      parseCliBackendPort(process.env.AGENT_DECK_BACKEND_PORT ?? process.env.AGENT_DECK_PORT),
    ).toBe(9001);
  });
});
