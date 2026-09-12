import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from '../server/index';
import { ensureAdminSecret, readAdminSecretFromEnvOrFile } from '../trusted-session/admin-secret';

describe('execution-authority HTTP issuer (NOT-86)', () => {
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let home: string;
  let previousHome: string | undefined;
  let baseUrl: string;
  let adminBearer: string;
  let deckId: string;

  beforeAll(async () => {
    previousHome = process.env.AGENT_DECK_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-ea-http-'));
    process.env.AGENT_DECK_HOME = home;
    await ensureAdminSecret();
    const secret = await readAdminSecretFromEnvOrFile();
    if (!secret) throw new Error('admin secret missing');
    adminBearer = `Bearer ${secret}`;

    server = await createServer();
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    if (!address || typeof address === 'string') throw new Error('no listen address');
    baseUrl = `http://127.0.0.1:${address.port}`;

    const deck = await server.db.createDeck({ name: 'ea-http-deck' });
    deckId = deck.id;
  });

  afterAll(async () => {
    await server?.close();
    if (previousHome === undefined) delete process.env.AGENT_DECK_HOME;
    else process.env.AGENT_DECK_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('enrolls, mints, remints, connects, denies OOS, interaction, revoke, audit', async () => {
    const enroll = await fetch(`${baseUrl}/api/execution-authority/enrollments`, {
      method: 'POST',
      headers: {
        Authorization: adminBearer,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        coordinatorId: 'coord-http-1',
        allowedDeckIds: [deckId],
      }),
    });
    const enrollBody = (await enroll.json()) as {
      ok?: boolean;
      data?: {
        enrollment: { enrollmentId: string };
        enrollmentSecret: string;
      };
    };
    expect(enroll.status).toBe(200);
    expect(enrollBody.ok).toBe(true);
    if (!enrollBody.data) return;

    const { enrollmentId } = enrollBody.data.enrollment;
    const enrollmentBearer = `Bearer ${enrollmentId}:${enrollBody.data.enrollmentSecret}`;

    const mint = await fetch(`${baseUrl}/api/execution-authority/authorities`, {
      method: 'POST',
      headers: {
        Authorization: enrollmentBearer,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        enrollmentId,
        runId: 'run_http',
        attemptId: 'attempt_1',
        deckId,
        audience: 'dealer-worker',
        idempotencyKey: 'run_http:attempt_1',
        ttlMs: 60_000,
      }),
    });
    const mintBody = (await mint.json()) as {
      ok?: boolean;
      data?: {
        authority: { authorityId: string };
        authoritySecret: string | null;
        secretIssued: boolean;
      };
      message?: string;
    };
    expect(mint.status).toBe(200);
    expect(mintBody.ok).toBe(true);
    if (!mintBody.data?.authoritySecret) return;

    const authorityId = mintBody.data.authority.authorityId;
    const authoritySecret = mintBody.data.authoritySecret;

    const remint = await fetch(`${baseUrl}/api/execution-authority/authorities`, {
      method: 'POST',
      headers: {
        Authorization: enrollmentBearer,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        enrollmentId,
        runId: 'run_http',
        attemptId: 'attempt_1',
        deckId,
        audience: 'dealer-worker',
        idempotencyKey: 'run_http:attempt_1',
        ttlMs: 60_000,
      }),
    });
    const remintBody = (await remint.json()) as {
      ok?: boolean;
      data?: { secretIssued: boolean; authoritySecret: string | null };
    };
    expect(remintBody.data?.secretIssued).toBe(false);
    expect(remintBody.data?.authoritySecret).toBeNull();

    const connect = await fetch(`${baseUrl}/api/execution-authority/mcp/connect`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authorityId}:${authoritySecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ audience: 'dealer-worker' }),
    });
    expect(connect.ok).toBe(true);

    const interaction = await fetch(`${baseUrl}/api/execution-authority/authorize-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authorityId,
        authoritySecret,
        audience: 'dealer-worker',
        serviceId: 'svc_x',
        toolName: 't',
        requiresInteraction: true,
      }),
    });
    expect((await interaction.json() as { error_code?: string }).error_code).toBe(
      'INTERACTION_REQUIRED',
    );

    const deny = await fetch(`${baseUrl}/api/execution-authority/authorize-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authorityId,
        authoritySecret,
        audience: 'dealer-worker',
        serviceId: 'svc_missing',
        toolName: 'nope',
      }),
    });
    expect((await deny.json() as { error_code?: string }).error_code).toBe('RESOURCE_OUT_OF_SCOPE');

    await fetch(`${baseUrl}/api/execution-authority/authorities/${authorityId}/revoke`, {
      method: 'POST',
      headers: { Authorization: enrollmentBearer },
    });

    const revoked = await fetch(`${baseUrl}/api/execution-authority/authorize-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authorityId,
        authoritySecret,
        audience: 'dealer-worker',
        serviceId: 'svc_x',
        toolName: 't',
      }),
    });
    expect((await revoked.json() as { error_code?: string }).error_code).toBe('AUTHORITY_REVOKED');

    const audit = await fetch(
      `${baseUrl}/api/execution-authority/audit?enrollmentId=${encodeURIComponent(enrollmentId)}`,
      { headers: { Authorization: enrollmentBearer } },
    );
    const auditBody = (await audit.json()) as { data?: { events: unknown[] } };
    expect(audit.ok).toBe(true);
    expect((auditBody.data?.events.length ?? 0) > 0).toBe(true);
  });

  it('isolates enrollments, empty toolScopeHint, and enrollment error codes', async () => {
    const enrollA = await fetch(`${baseUrl}/api/execution-authority/enrollments`, {
      method: 'POST',
      headers: { Authorization: adminBearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinatorId: 'coord-a', allowedDeckIds: [deckId] }),
    });
    const enrollB = await fetch(`${baseUrl}/api/execution-authority/enrollments`, {
      method: 'POST',
      headers: { Authorization: adminBearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinatorId: 'coord-b', allowedDeckIds: [deckId] }),
    });
    const a = (await enrollA.json()) as {
      data: { enrollment: { enrollmentId: string }; enrollmentSecret: string };
    };
    const b = (await enrollB.json()) as {
      data: { enrollment: { enrollmentId: string }; enrollmentSecret: string };
    };
    const bearerA = `Bearer ${a.data.enrollment.enrollmentId}:${a.data.enrollmentSecret}`;
    const bearerB = `Bearer ${b.data.enrollment.enrollmentId}:${b.data.enrollmentSecret}`;

    const mint = await fetch(`${baseUrl}/api/execution-authority/authorities`, {
      method: 'POST',
      headers: { Authorization: bearerA, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollmentId: a.data.enrollment.enrollmentId,
        runId: 'run_iso',
        attemptId: 'attempt_1',
        deckId,
        audience: 'dealer-worker',
        idempotencyKey: 'run_iso:1',
        ttlMs: 60_000,
        toolScopeHint: [],
      }),
    });
    const mintBody = (await mint.json()) as {
      ok?: boolean;
      data?: { authority: { authorityId: string; allowedTools: unknown[] } };
    };
    expect(mint.ok).toBe(true);
    expect(mintBody.data?.authority.allowedTools).toEqual([]);

    const crossRevoke = await fetch(
      `${baseUrl}/api/execution-authority/authorities/${mintBody.data!.authority.authorityId}/revoke`,
      { method: 'POST', headers: { Authorization: bearerB } },
    );
    expect(crossRevoke.status).toBe(404);
    const crossBody = (await crossRevoke.json()) as { error_code?: string };
    expect(crossBody.error_code).toBe('AUTHORITY_UNKNOWN');

    const stillLive = await fetch(
      `${baseUrl}/api/execution-authority/authorities/${mintBody.data!.authority.authorityId}`,
      { headers: { Authorization: bearerA } },
    );
    const liveBody = (await stillLive.json()) as { data?: { status: string } };
    expect(liveBody.data?.status).toBe('live');

    await fetch(
      `${baseUrl}/api/execution-authority/enrollments/${a.data.enrollment.enrollmentId}/revoke`,
      { method: 'POST', headers: { Authorization: adminBearer } },
    );
    const afterRevoke = await fetch(`${baseUrl}/api/execution-authority/decks`, {
      headers: { Authorization: bearerA },
    });
    expect(afterRevoke.status).toBe(403);
    expect((await afterRevoke.json() as { error_code?: string }).error_code).toBe(
      'ENROLLMENT_REVOKED',
    );

    const unknownEnroll = await fetch(`${baseUrl}/api/execution-authority/decks`, {
      headers: { Authorization: 'Bearer enr_deadbeefdeadbeefdeadbeefdeadbeef:enrs_nope' },
    });
    expect((await unknownEnroll.json() as { error_code?: string }).error_code).toBe(
      'COORDINATOR_NOT_ENROLLED',
    );
  });
});
