import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_DECK_SESSION_HEADER,
  AGENT_DECK_WORKER_PROFILE_HEADER,
  AGENT_DECK_WORKSPACE_HEADER,
} from '@agent-deck/shared';

import { AuditStore } from '../audit/store';
import { DatabaseManager } from '../models/database';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import { dashboardAuthHeaders } from '../test/auth-fixtures';
import { CredentialManager } from '../vault/credential-manager';
import type { SecretStore } from '../vault/secret-store';
import { CREDENTIAL_RUN_REDACTED } from '../credential-runs/redact';

const NODE = process.execPath;
const SECRET = 'fake-hf-secret-value-1';
const SECRET_B64 = Buffer.from(SECRET, 'utf8').toString('base64');
const SECRET_URL = encodeURIComponent(SECRET);

/** Fake vault: counts `get` so tests prove denials resolve no secrets. */
class FakeSecretStore implements SecretStore {
  values = new Map<string, string>();
  getCalls: string[] = [];
  async set(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }
  async get(account: string): Promise<string | null> {
    this.getCalls.push(account);
    return this.values.get(account) ?? null;
  }
  async delete(account: string): Promise<void> {
    this.values.delete(account);
  }
  async has(account: string): Promise<boolean> {
    return this.values.has(account);
  }
}

describe('trusted-session credential-run routes', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildApp() {
    const db = new DatabaseManager(':memory:');
    const deck = await db.createDeck({ name: 'deck-a' });
    const otherDeck = await db.createDeck({ name: 'deck-b' });
    await db.createCredential({
      id: 'cred_huggingface',
      label: 'Hugging Face',
      scheme: 'bearer',
      envName: 'HUGGINGFACE_API_KEY',
      keychainAccount: 'cred_huggingface',
      tags: [],
      hasSecret: true,
    });
    await db.createCredential({
      id: 'cred_other',
      label: 'Other',
      scheme: 'bearer',
      envName: 'OTHER_KEY',
      keychainAccount: 'cred_other',
      tags: [],
      hasSecret: true,
    });
    await db.addCredentialToDeck({ deckId: deck.id, credentialId: 'cred_huggingface' });
    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const session = store.createRuntimeSession({ deckId: deck.id, mcpSessionId: 'mcp-test-1' });
    const fakeSecrets = new FakeSecretStore();
    await fakeSecrets.set('cred_huggingface', SECRET);
    await fakeSecrets.set('cred_other', 'fake-other-secret');
    const credentialManager = new CredentialManager(db, fakeSecrets);
    const auditStore = new AuditStore(db.getSqliteDatabase());

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('credentialManager', credentialManager);
    fastify.decorate('auditStore', auditStore);
    registerHttpPolicyHook(fastify);
    await fastify.register(registerTrustedSessionRoutes, { prefix: '/api/trusted-session' });
    await fastify.ready();
    servers.push(fastify);

    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-route-cred-run-'));
    const agentHeaders = {
      [AGENT_DECK_SESSION_HEADER]: session.sessionId,
      [AGENT_DECK_WORKSPACE_HEADER]: workspaceRoot,
    };
    const postRun = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
      fastify.inject({
        method: 'POST',
        url: '/api/trusted-session/credential-run',
        headers: { ...agentHeaders, ...headers },
        payload,
      });
    const resolve = (requestId: string, decision: 'approve' | 'decline') =>
      fastify.inject({
        method: 'POST',
        url: `/api/trusted-session/credential-run/${requestId}/resolve`,
        headers: dashboardAuthHeaders(store),
        payload: { runtimeSessionId: session.sessionId, decision },
      });
    return {
      db,
      deck,
      otherDeck,
      store,
      session,
      fakeSecrets,
      auditStore,
      fastify,
      workspaceRoot,
      agentHeaders,
      postRun,
      resolve,
    };
  }

  /** Fake executable argv: child checks env internally and prints booleans plus argv. */
  const checkArgv = [
    '-e',
    `console.log(JSON.stringify({ argv: process.argv.slice(1), hfOk: process.env.HF_TOKEN === '${SECRET}', defaultOk: process.env.HUGGINGFACE_API_KEY === '${SECRET}' }))`,
    'jobs',
    'run',
    'a;b',
    '$(x)',
  ];

  it('denies worker profiles before secret resolution', async () => {
    const app = await buildApp();
    for (const profile of ['readonly', 'edit']) {
      const response = await app.postRun(
        { argv: [NODE, ...checkArgv], credentials: ['cred_huggingface'] },
        { [AGENT_DECK_WORKER_PROFILE_HEADER]: profile },
      );
      expect(response.statusCode).toBe(403);
      expect(response.json().error_code).toBe('PROFILE_DENIED');
    }
    expect(app.fakeSecrets.getCalls).toEqual([]);
  });

  it('denies a credential not on the session deck before secret resolution', async () => {
    const app = await buildApp();
    const response = await app.postRun({
      argv: [NODE, ...checkArgv],
      credentials: ['cred_other'],
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error_code).toBe('RESOURCE_OUT_OF_SCOPE');
    expect(app.fakeSecrets.getCalls).toEqual([]);
  });

  it('returns pending for an unapproved call without resolving secrets', async () => {
    const app = await buildApp();
    const body = { argv: [NODE, ...checkArgv], credentials: ['cred_huggingface'] };
    const first = await app.postRun(body);
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ status: 'pending' });
    expect(first.json().data.approvalUrl).toContain('/credential-run/approve?request=');
    // An identical retry returns the same pending request — still no secrets.
    const second = await app.postRun(body);
    expect(second.json().data.requestId).toBe(first.json().data.requestId);
    expect(app.fakeSecrets.getCalls).toEqual([]);
  });

  it('executes on an identical retry after approval, with alias mapping and exact argv', async () => {
    const app = await buildApp();
    const body = {
      argv: [NODE, ...checkArgv],
      credentials: ['cred_huggingface'],
      env: { HF_TOKEN: 'cred_huggingface' },
    };
    const pending = await app.postRun(body);
    const requestId = pending.json().data.requestId as string;
    const approved = await app.resolve(requestId, 'approve');
    expect(approved.json().data).toMatchObject({ status: 'approved' });

    const executed = await app.postRun(body);
    expect(executed.statusCode).toBe(200);
    const data = executed.json().data;
    expect(data).toMatchObject({ status: 'executed', requestId, exitCode: 0, timedOut: false });
    const printed = JSON.parse(data.stdout) as { argv: string[]; hfOk: boolean; defaultOk: boolean };
    expect(printed.hfOk).toBe(true);
    // Fully aliased: the default envName mapping adds nothing extra.
    expect(printed.defaultOk).toBe(false);
    expect(printed.argv).toEqual(checkArgv.slice(2));
    expect(app.fakeSecrets.getCalls).toEqual(['cred_huggingface']);

    // Audit covers request, decision, and outcome — never secret values.
    const auditJson = JSON.stringify(app.auditStore.list({ limit: 20 }));
    expect(auditJson).toContain('credential_run.requested');
    expect(auditJson).toContain('credential_run.approved');
    expect(auditJson).toContain('credential_run.finished');
    expect(auditJson).toContain(requestId);
    expect(auditJson).not.toContain(SECRET);
  });

  it('maps a listed credential without an alias to its own envName', async () => {
    const app = await buildApp();
    const body = { argv: [NODE, ...checkArgv], credentials: ['cred_huggingface'] };
    const pending = await app.postRun(body);
    await app.resolve(pending.json().data.requestId, 'approve');
    const executed = await app.postRun(body);
    const printed = JSON.parse(executed.json().data.stdout) as { hfOk: boolean; defaultOk: boolean };
    expect(printed.defaultOk).toBe(true);
    expect(printed.hfOk).toBe(false);
  });

  it('does not execute on an expired approval', async () => {
    const app = await buildApp();
    const body = { argv: [NODE, ...checkArgv], credentials: ['cred_huggingface'] };
    const pending = await app.postRun(body);
    const requestId = pending.json().data.requestId as string;
    await app.resolve(requestId, 'approve');
    // Expire the approval out from under the retry.
    app.db
      .getSqliteDatabase()
      .prepare(`UPDATE credential_run_requests SET expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), requestId);

    const retry = await app.postRun(body);
    expect(retry.json().data.status).toBe('pending');
    expect(retry.json().data.requestId).not.toBe(requestId);
    expect(app.fakeSecrets.getCalls).toEqual([]);

    const reread = await app.fastify.inject({
      method: 'GET',
      url: `/api/trusted-session/credential-run/${requestId}`,
      headers: dashboardAuthHeaders(app.store),
    });
    expect(reread.json().data.status).toBe('expired');
  });

  it('does not re-execute a replayed (already-used) approval', async () => {
    const app = await buildApp();
    const body = { argv: [NODE, ...checkArgv], credentials: ['cred_huggingface'] };
    const pending = await app.postRun(body);
    const requestId = pending.json().data.requestId as string;
    await app.resolve(requestId, 'approve');
    const executed = await app.postRun(body);
    expect(executed.json().data.status).toBe('executed');
    const getCallsAfterExecute = app.fakeSecrets.getCalls.length;
    expect(getCallsAfterExecute).toBeGreaterThan(0);

    // The identical retry needs fresh approval — it must not execute.
    const replay = await app.postRun(body);
    expect(replay.json().data.status).toBe('pending');
    expect(replay.json().data.requestId).not.toBe(requestId);
    expect(app.fakeSecrets.getCalls.length).toBe(getCallsAfterExecute);

    // Resolving the consumed request again is a conflict, not an approval.
    const again = await app.resolve(requestId, 'approve');
    expect(again.statusCode).toBe(409);
    expect(again.json().error_code).toBe('CREDENTIAL_RUN_CONSUMED');
  });

  it('requires fresh approval when the binding changes', async () => {
    const app = await buildApp();
    const base = { argv: [NODE, ...checkArgv], credentials: ['cred_huggingface'] };
    const pending = await app.postRun(base);
    await app.resolve(pending.json().data.requestId, 'approve');

    fs.mkdirSync(path.join(app.workspaceRoot, 'sub'), { recursive: true });
    const variants: Record<string, unknown>[] = [
      { ...base, argv: [NODE, ...checkArgv, '--extra'] },
      { ...base, env: { HF_TOKEN: 'cred_huggingface' } },
      { ...base, cwd: 'sub' },
      { ...base, credentials: ['cred_huggingface', 'cred_huggingface'] },
    ];
    for (const variant of variants) {
      const response = await app.postRun(variant);
      expect(response.json().data.status, JSON.stringify(variant)).toBe('pending');
    }
    // A different session on the same deck matches nothing either.
    const otherSession = app.store.createRuntimeSession({ deckId: app.deck.id });
    const otherResponse = await app.fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/credential-run',
      headers: {
        [AGENT_DECK_SESSION_HEADER]: otherSession.sessionId,
        [AGENT_DECK_WORKSPACE_HEADER]: app.workspaceRoot,
      },
      payload: base,
    });
    expect(otherResponse.json().data.status).toBe('pending');
    expect(app.fakeSecrets.getCalls).toEqual([]);
  });

  it('records a decline and never executes it', async () => {
    const app = await buildApp();
    const body = { argv: [NODE, ...checkArgv], credentials: ['cred_huggingface'] };
    const pending = await app.postRun(body);
    const requestId = pending.json().data.requestId as string;
    const declined = await app.resolve(requestId, 'decline');
    expect(declined.json().data).toMatchObject({ status: 'declined' });

    const retry = await app.postRun(body);
    expect(retry.json().data.status).toBe('pending');
    expect(retry.json().data.requestId).not.toBe(requestId);
    expect(app.fakeSecrets.getCalls).toEqual([]);

    const auditJson = JSON.stringify(app.auditStore.list({ limit: 20 }));
    expect(auditJson).toContain('credential_run.denied');
    expect(auditJson).toContain('owner_denied');
  });

  it('rejects bad input before secret resolution', async () => {
    const app = await buildApp();
    const cases: Record<string, unknown>[] = [
      // Env alias value not listed in credentials.
      {
        argv: [NODE, ...checkArgv],
        credentials: ['cred_huggingface'],
        env: { HF_TOKEN: 'cred_other' },
      },
      { argv: [NODE, ...checkArgv], credentials: ['cred_huggingface'], cwd: '../escape' },
      { argv: [NODE, ...checkArgv], credentials: ['cred_huggingface'], cwd: '/etc' },
      { argv: [NODE, ...checkArgv], credentials: ['cred_huggingface'], timeoutSec: 0 },
      { argv: [NODE, ...checkArgv], credentials: ['cred_huggingface'], timeoutSec: 3601 },
      { argv: [], credentials: ['cred_huggingface'] },
      { argv: [NODE, ...checkArgv], credentials: [] },
    ];
    for (const body of cases) {
      const response = await app.postRun(body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(app.fakeSecrets.getCalls).toEqual([]);
  });

  it('redacts echoed secrets (raw, base64, URL-encoded) from the tool response', async () => {
    const app = await buildApp();
    const body = {
      argv: [
        NODE,
        '-e',
        `const s = process.env.HF_TOKEN; console.log('raw=' + s); console.log('b64=' + Buffer.from(s).toString('base64')); console.log('url=' + encodeURIComponent(s)); console.error('err=' + s);`,
      ],
      credentials: ['cred_huggingface'],
      env: { HF_TOKEN: 'cred_huggingface' },
    };
    const pending = await app.postRun(body);
    await app.resolve(pending.json().data.requestId, 'approve');
    const executed = await app.postRun(body);
    const data = executed.json().data;
    expect(data.stdout).toContain(`raw=${CREDENTIAL_RUN_REDACTED}`);
    expect(data.stdout).toContain(`b64=${CREDENTIAL_RUN_REDACTED}`);
    expect(data.stdout).toContain(`url=${CREDENTIAL_RUN_REDACTED}`);
    expect(data.stderr).toContain(`err=${CREDENTIAL_RUN_REDACTED}`);
    const responseJson = JSON.stringify(executed.json());
    expect(responseJson).not.toContain(SECRET);
    expect(responseJson).not.toContain(SECRET_B64);
    expect(responseJson).not.toContain(SECRET_URL);
  });

  it('keeps daemon secrets out of the child env', async () => {
    const app = await buildApp();
    const daemonVars: Record<string, string> = {
      AGENT_DECK_VAULT_KEY: 'vault-key-value',
      AGENT_DECK_ADMIN_SECRET: 'admin-secret-value',
      AGENT_DECK_OWNER_BOOTSTRAP_SECRET: 'bootstrap-value',
      AGENT_DECK_SLACK_CLIENT_SECRET: 'slack-value',
    };
    const saved = new Map<string, string | undefined>();
    try {
      for (const [name, value] of Object.entries(daemonVars)) {
        saved.set(name, process.env[name]);
        process.env[name] = value;
      }
      const body = {
        argv: [
          NODE,
          '-e',
          `console.log(JSON.stringify({ vault: process.env.AGENT_DECK_VAULT_KEY, admin: process.env.AGENT_DECK_ADMIN_SECRET, bootstrap: process.env.AGENT_DECK_OWNER_BOOTSTRAP_SECRET, slack: process.env.AGENT_DECK_SLACK_CLIENT_SECRET, hfOk: process.env.HF_TOKEN === '${SECRET}' }))`,
        ],
        credentials: ['cred_huggingface'],
        env: { HF_TOKEN: 'cred_huggingface' },
      };
      const pending = await app.postRun(body);
      await app.resolve(pending.json().data.requestId, 'approve');
      const executed = await app.postRun(body);
      const printed = JSON.parse(executed.json().data.stdout) as Record<string, unknown>;
      expect(printed.hfOk).toBe(true);
      expect(printed.vault).toBeUndefined();
      expect(printed.admin).toBeUndefined();
      expect(printed.bootstrap).toBeUndefined();
      expect(printed.slack).toBeUndefined();
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  it('kills a long-running child at the timeout', async () => {
    const app = await buildApp();
    const body = {
      argv: [NODE, '-e', 'setTimeout(() => {}, 30000)'],
      credentials: ['cred_huggingface'],
      timeoutSec: 1,
    };
    const pending = await app.postRun(body);
    await app.resolve(pending.json().data.requestId, 'approve');
    const executed = await app.postRun(body);
    expect(executed.json().data).toMatchObject({ status: 'executed', timedOut: true, exitCode: null });
  });

  it('shows agents status only and the dashboard the full binding', async () => {
    const app = await buildApp();
    const body = {
      argv: [NODE, ...checkArgv],
      credentials: ['cred_huggingface'],
      env: { HF_TOKEN: 'cred_huggingface' },
    };
    const pending = await app.postRun(body);
    const requestId = pending.json().data.requestId as string;

    const agentView = await app.fastify.inject({
      method: 'GET',
      url: `/api/trusted-session/credential-run/${requestId}`,
      headers: app.agentHeaders,
    });
    expect(agentView.json().data).toMatchObject({ requestId, status: 'pending' });
    expect(agentView.json().data.argv).toBeUndefined();

    const dashboardView = await app.fastify.inject({
      method: 'GET',
      url: `/api/trusted-session/credential-run/${requestId}`,
      headers: dashboardAuthHeaders(app.store),
    });
    expect(dashboardView.json().data).toMatchObject({
      requestId,
      status: 'pending',
      argv: body.argv,
      credentialIds: ['cred_huggingface'],
      env: { HF_TOKEN: 'cred_huggingface' },
    });

    const inbox = await app.fastify.inject({
      method: 'GET',
      url: '/api/trusted-session/credential-run/pending',
    });
    const listed = (inbox.json().data as Array<{ requestId: string }>).find(
      (entry) => entry.requestId === requestId,
    );
    expect(listed).toBeDefined();
    expect(listed).toMatchObject({ argv: body.argv, deckName: 'deck-a' });
    expect(app.fakeSecrets.getCalls).toEqual([]);
  });
});
