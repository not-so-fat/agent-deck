import { afterEach, describe, expect, it } from 'vitest';

import type { McpToolHost } from './register';
import {
  credentialRunClientApprovalEnabled,
  presentCredentialRunApproval,
  registerCredentialRunTools,
  submitCredentialRunApprovalViaBackend,
} from './run-with-credentials';
import { DeckSwitchApprovalCommitUnavailable } from './elicitation';

type CapturedTool = {
  config: { title: string; description: string; inputSchema: unknown };
  handler: (input: any) => Promise<any>;
};

const INPUT = {
  argv: ['hf', 'jobs', 'run', 'org/job', '--secrets', 'HF_TOKEN'],
  credentials: ['cred_huggingface'],
  env: { HF_TOKEN: 'cred_huggingface' },
};

const PENDING = {
  requestId: 'crn_test1',
  status: 'pending',
  createdAt: '2026-11-28T00:00:00.000Z',
  expiresAt: '2026-11-28T00:10:00.000Z',
  approvalUrl: 'http://127.0.0.1:8000/credential-run/approve?request=crn_test1&session=ses_1',
};

const EXECUTED = {
  requestId: 'crn_test1',
  status: 'executed',
  exitCode: 0,
  timedOut: false,
  stdout: 'job started\n',
  stdoutTruncated: false,
  stderr: '',
  stderrTruncated: false,
};

function makeHost(overrides: {
  workerProfile?: 'readonly' | 'edit';
  runtimeSessionId?: string | null;
  grantSession?: boolean;
  backend?: (endpoint: string, init?: RequestInit) => Promise<any>;
  elicitation?: McpToolHost['elicitation'];
} = {}): { host: McpToolHost; tools: Map<string, CapturedTool>; backendCalls: string[] } {
  const tools = new Map<string, CapturedTool>();
  const backendCalls: string[] = [];
  const backend =
    overrides.backend ??
    (async () => {
      throw new Error('unexpected backend call');
    });
  const host = {
    registerTool: (name: string, config: CapturedTool['config'], handler: CapturedTool['handler']) => {
      tools.set(name, { config, handler });
    },
    profile: 'legacy',
    getSessionId: () => 'mcp-test',
    getMode: () => 'normal',
    refreshRuntimeSession: async () => ({ mode: 'normal', deckId: 'deck-1' }),
    getAgentHeaders: () => ({}),
    getBoundDeckId: async () => 'deck-1',
    callBackendAPI: async (endpoint: string, init?: RequestInit) => {
      backendCalls.push(endpoint);
      return backend(endpoint, init);
    },
    fetchDeck: async () => ({ id: 'deck-1', name: 'deck' }),
    buildBindingPayload: async () => ({}),
    registerLiveDisplay: async () => {},
    syncWorkspaceOnBind: async () => null,
    sessionBinding: {
      getBinding: () => ({
        workspaceRoot: '/tmp/ws',
        deckId: 'deck-1',
        ...(overrides.runtimeSessionId === null ? {} : { runtimeSessionId: overrides.runtimeSessionId ?? 'ses_1' }),
        mode: 'normal',
      }),
      setWorkspace: () => {},
      setDeckId: () => {},
      setTrustedSession: () => {},
      isLaunchSession: () => false,
      hasSessionDeckOverride: () => false,
      getWorkerSession: () =>
        overrides.workerProfile
          ? { runId: 'run-1', profile: overrides.workerProfile, client: 'claude', metaPath: '/tmp/meta' }
          : undefined,
      isGrantSession: () => overrides.grantSession ?? false,
    },
    badgeBySession: new Map(),
    backendUrl: 'http://127.0.0.1:1',
    ...(overrides.elicitation ? { elicitation: overrides.elicitation } : {}),
    toolResult: (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    toolError: (error: unknown) => ({
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    }),
  } as unknown as McpToolHost;
  registerCredentialRunTools(host);
  return { host, tools, backendCalls };
}

function readPayload(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe('run_with_credentials MCP tool', () => {
  afterEach(() => {
    delete process.env.AGENT_DECK_DECK_SWITCH_APPROVAL;
  });

  it('denies worker profiles before any backend contact', async () => {
    for (const workerProfile of ['readonly', 'edit'] as const) {
      const { tools, backendCalls } = makeHost({ workerProfile });
      const result = await tools.get('run_with_credentials')!.handler(INPUT);
      expect(result.isError).toBe(true);
      expect(readPayload(result)).toMatchObject({
        code: 'PROFILE_DENIED',
        profile: workerProfile,
        tool: 'run_with_credentials',
      });
      expect(backendCalls).toEqual([]);
    }
  });

  it('requires a bound session before any backend contact', async () => {
    const { tools, backendCalls } = makeHost({ runtimeSessionId: null });
    const result = await tools.get('run_with_credentials')!.handler(INPUT);
    expect(result.isError).toBe(true);
    expect(readPayload(result).error_code).toBe('GRANT_REQUIRED');
    expect(backendCalls).toEqual([]);
  });

  it('passes an executed result through', async () => {
    const { tools, backendCalls } = makeHost({
      backend: async () => EXECUTED,
    });
    const result = await tools.get('run_with_credentials')!.handler(INPUT);
    expect(result.isError).toBeUndefined();
    expect(readPayload(result)).toMatchObject({ status: 'executed', exitCode: 0 });
    expect(backendCalls).toEqual(['/api/trusted-session/credential-run']);
  });

  it('returns a pending request as-is without elicitation', async () => {
    const { tools } = makeHost({ backend: async () => PENDING });
    const result = await tools.get('run_with_credentials')!.handler(INPUT);
    expect(readPayload(result)).toMatchObject({ status: 'pending', requestId: 'crn_test1' });
  });

  it('approves through the host form and executes on the identical retry', async () => {
    const seen: Array<{ endpoint: string; body?: unknown; auth?: string }> = [];
    let posts = 0;
    let formMessage = '';
    const { tools } = makeHost({
      backend: async (endpoint: string, init?: RequestInit) => {
        if (endpoint === '/api/trusted-session/credential-run') {
          posts += 1;
          return posts === 1 ? PENDING : EXECUTED;
        }
        seen.push({
          endpoint,
          body: init?.body ? JSON.parse(init.body as string) : undefined,
          auth: (init?.headers as Record<string, string>)?.Authorization,
        });
        return { requestId: 'crn_test1', decision: 'approve', status: 'approved' };
      },
      elicitation: {
        supportsFormElicitation: () => true,
        elicitForm: async (input) => {
          formMessage = input.message;
          return { action: 'accept', content: { requestId: 'crn_test1', decision: 'approve' } };
        },
      },
    });
    const savedSecret = process.env.AGENT_DECK_ADMIN_SECRET;
    process.env.AGENT_DECK_ADMIN_SECRET = 'test-admin-secret-0123456789abcdef';
    try {
      const result = await tools.get('run_with_credentials')!.handler(INPUT);
      expect(readPayload(result)).toMatchObject({ status: 'executed', exitCode: 0 });
    } finally {
      if (savedSecret === undefined) {
        delete process.env.AGENT_DECK_ADMIN_SECRET;
      } else {
        process.env.AGENT_DECK_ADMIN_SECRET = savedSecret;
      }
    }
    // The owner approved the exact binding they were shown.
    expect(formMessage).toContain(JSON.stringify(INPUT.argv));
    expect(formMessage).toContain('cred_huggingface');
    expect(formMessage).toContain('HF_TOKEN');
    expect(seen).toEqual([
      {
        endpoint: '/api/trusted-session/credential-run/crn_test1/resolve',
        body: { runtimeSessionId: 'ses_1', decision: 'approve' },
        auth: 'Bearer test-admin-secret-0123456789abcdef',
      },
    ]);
    expect(posts).toBe(2);
  });

  it('returns a decline without executing', async () => {
    let posts = 0;
    const { tools } = makeHost({
      backend: async (endpoint: string) => {
        if (endpoint === '/api/trusted-session/credential-run') {
          posts += 1;
          return PENDING;
        }
        return { requestId: 'crn_test1', decision: 'decline', status: 'declined' };
      },
      elicitation: {
        supportsFormElicitation: () => true,
        elicitForm: async () => ({ action: 'decline' }),
      },
    });
    const savedSecret = process.env.AGENT_DECK_ADMIN_SECRET;
    process.env.AGENT_DECK_ADMIN_SECRET = 'test-admin-secret-0123456789abcdef';
    try {
      const result = await tools.get('run_with_credentials')!.handler(INPUT);
      expect(readPayload(result)).toMatchObject({ status: 'declined' });
    } finally {
      if (savedSecret === undefined) {
        delete process.env.AGENT_DECK_ADMIN_SECRET;
      } else {
        process.env.AGENT_DECK_ADMIN_SECRET = savedSecret;
      }
    }
    expect(posts).toBe(1);
  });

  it('degrades a dismissed form to a pending-recovery payload', async () => {
    const { tools } = makeHost({
      backend: async () => PENDING,
      elicitation: {
        supportsFormElicitation: () => true,
        elicitForm: async () => ({ action: 'cancel' }),
      },
    });
    const result = await tools.get('run_with_credentials')!.handler(INPUT);
    const payload = readPayload(result);
    expect(payload.status).toBe('pending');
    expect(payload.approvalUrl).toBe(PENDING.approvalUrl);
    expect(payload.message).toContain('identical input');
  });

  it('falls back to the pending creation when the client has no form support', async () => {
    const { tools } = makeHost({
      backend: async () => PENDING,
      elicitation: {
        supportsFormElicitation: () => false,
        elicitForm: async () => ({ action: 'cancel' }),
      },
    });
    const result = await tools.get('run_with_credentials')!.handler(INPUT);
    expect(readPayload(result)).toMatchObject({ status: 'pending', requestId: 'crn_test1' });
  });

  it('drops a form answer with a mismatched request id', async () => {
    const outcome = await presentCredentialRunApproval({
      creation: { ...PENDING },
      input: INPUT,
      runtimeSessionId: 'ses_1',
      supportsFormElicitation: () => true,
      elicitForm: async () => ({
        action: 'accept',
        content: { requestId: 'crn_forged', decision: 'approve' },
      }),
      submitApproval: async () => {
        throw new Error('must not submit a forged request id');
      },
    });
    expect(outcome.handled).toBe('fallback');
  });

  it('recovers pending when the form gets no answer in time', async () => {
    const outcome = await presentCredentialRunApproval({
      creation: { ...PENDING },
      input: INPUT,
      runtimeSessionId: 'ses_1',
      supportsFormElicitation: () => true,
      elicitForm: () => new Promise(() => {}),
      submitApproval: async () => {
        throw new Error('must not submit without an answer');
      },
      toolCallWaitMs: 5,
    });
    expect(outcome.handled).toBe('pending-recovery');
    expect((outcome.payload as { approvalUrl: string }).approvalUrl).toBe(PENDING.approvalUrl);
  });

  it('client approval executes immediately for local sessions', async () => {
    process.env.AGENT_DECK_DECK_SWITCH_APPROVAL = 'client';
    expect(credentialRunClientApprovalEnabled()).toBe(true);
    let posts = 0;
    const seen: unknown[] = [];
    const { tools, backendCalls } = makeHost({
      grantSession: false,
      backend: async (endpoint: string, init?: RequestInit) => {
        if (endpoint === '/api/trusted-session/credential-run') {
          posts += 1;
          return posts === 1 ? PENDING : EXECUTED;
        }
        seen.push(init?.body ? JSON.parse(init.body as string) : undefined);
        return { requestId: 'crn_test1', decision: 'approve', status: 'approved' };
      },
    });
    const config = tools.get('run_with_credentials')!.config;
    expect(config.description).toContain('approving this tool call in your client IS the human approval');
    const savedSecret = process.env.AGENT_DECK_ADMIN_SECRET;
    process.env.AGENT_DECK_ADMIN_SECRET = 'test-admin-secret-0123456789abcdef';
    try {
      const result = await tools.get('run_with_credentials')!.handler(INPUT);
      expect(readPayload(result)).toMatchObject({ status: 'executed' });
    } finally {
      if (savedSecret === undefined) {
        delete process.env.AGENT_DECK_ADMIN_SECRET;
      } else {
        process.env.AGENT_DECK_ADMIN_SECRET = savedSecret;
      }
    }
    expect(seen).toEqual([
      { runtimeSessionId: 'ses_1', decision: 'approve', approvedVia: 'client' },
    ]);
    expect(backendCalls.filter((endpoint) => endpoint === '/api/trusted-session/credential-run')).toHaveLength(2);
  });

  it('client approval never auto-commits for grant sessions', async () => {
    process.env.AGENT_DECK_DECK_SWITCH_APPROVAL = 'client';
    const { tools, backendCalls } = makeHost({
      grantSession: true,
      backend: async () => PENDING,
    });
    const savedSecret = process.env.AGENT_DECK_ADMIN_SECRET;
    process.env.AGENT_DECK_ADMIN_SECRET = 'test-admin-secret-0123456789abcdef';
    try {
      const result = await tools.get('run_with_credentials')!.handler(INPUT);
      expect(readPayload(result)).toMatchObject({ status: 'pending' });
    } finally {
      if (savedSecret === undefined) {
        delete process.env.AGENT_DECK_ADMIN_SECRET;
      } else {
        process.env.AGENT_DECK_ADMIN_SECRET = savedSecret;
      }
    }
    expect(backendCalls).toEqual(['/api/trusted-session/credential-run']);
  });

  it('submit without a commit credential reports unavailable', async () => {
    await expect(
      submitCredentialRunApprovalViaBackend({
        callBackendAPI: async () => ({}),
        requestId: 'crn_test1',
        runtimeSessionId: 'ses_1',
        decision: 'approve',
        readSecret: async () => null,
      }),
    ).rejects.toBeInstanceOf(DeckSwitchApprovalCommitUnavailable);
  });

  it('tool description tells a leader how to call it', async () => {
    const { tools } = makeHost({ backend: async () => PENDING });
    const description = tools.get('run_with_credentials')!.config.description;
    expect(description).toContain('no shell');
    expect(description).toContain('HF_TOKEN');
    expect(description).toContain('identical input');
    expect(description).toContain('single-use');
    expect(description).toContain('[REDACTED]');
  });
});
