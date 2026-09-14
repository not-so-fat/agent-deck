import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_DECK_AGENT_CLIENT, AGENT_DECK_CLIENT_HEADER } from '@agent-deck/shared';

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

  it('lists playbook summaries only for decks allowed by the coordinator enrollment', async () => {
    const playbook = await server!.playbookManager.create({
      id: 'pb_coordinator_metadata',
      title: 'Coordinator metadata',
      body: 'Full playbook body must not be exposed by metadata discovery.',
      triggers: ['coordinate metadata'],
    });
    await server!.playbookManager.addToDeck({ deckId, playbookId: playbook.id });
    const otherDeck = await server!.db.createDeck({ name: 'ea-http-oos-playbooks' });

    const enroll = await fetch(`${baseUrl}/api/execution-authority/enrollments`, {
      method: 'POST',
      headers: { Authorization: adminBearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        coordinatorId: 'coord-playbook-metadata',
        allowedDeckIds: [deckId],
      }),
    });
    const enrollBody = (await enroll.json()) as {
      data: { enrollment: { enrollmentId: string }; enrollmentSecret: string };
    };
    const { enrollmentId } = enrollBody.data.enrollment;
    const enrollmentBearer = `Bearer ${enrollmentId}:${enrollBody.data.enrollmentSecret}`;

    const decksBefore = await fetch(`${baseUrl}/api/execution-authority/decks`, {
      headers: { Authorization: enrollmentBearer },
    });
    expect(decksBefore.status).toBe(200);
    expect(await decksBefore.json()).toEqual({
      ok: true,
      data: { decks: [{ id: deckId, name: 'ea-http-deck' }] },
    });

    const allowed = await fetch(
      `${baseUrl}/api/execution-authority/decks/${deckId}/playbooks`,
      { headers: { Authorization: enrollmentBearer } },
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      ok: true,
      data: [{ id: playbook.id, title: playbook.title, triggers: playbook.triggers }],
    });

    const outOfScope = await fetch(
      `${baseUrl}/api/execution-authority/decks/${otherDeck.id}/playbooks`,
      { headers: { Authorization: enrollmentBearer } },
    );
    expect(outOfScope.status).toBe(403);
    expect(await outOfScope.json()).toMatchObject({
      ok: false,
      error_code: 'RESOURCE_OUT_OF_SCOPE',
      reason: 'deck_not_permitted',
      correlation: { enrollmentId, deckId: otherDeck.id },
    });

    const decksAfter = await fetch(`${baseUrl}/api/execution-authority/decks`, {
      headers: { Authorization: enrollmentBearer },
    });
    expect(decksAfter.status).toBe(200);
    expect(await decksAfter.json()).toEqual({
      ok: true,
      data: { decks: [{ id: deckId, name: 'ea-http-deck' }] },
    });

    await fetch(
      `${baseUrl}/api/execution-authority/enrollments/${enrollmentId}/revoke`,
      { method: 'POST', headers: { Authorization: adminBearer } },
    );
    const revoked = await fetch(
      `${baseUrl}/api/execution-authority/decks/${deckId}/playbooks`,
      { headers: { Authorization: enrollmentBearer } },
    );
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toMatchObject({
      ok: false,
      error_code: 'ENROLLMENT_REVOKED',
    });
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
      data?: {
        authority: { authorityId: string; allowedTools: unknown[]; allowedServices: string[] };
      };
    };
    expect(mint.ok).toBe(true);
    expect(mintBody.data?.authority.allowedTools).toEqual([]);
    expect(mintBody.data?.authority.allowedServices).toEqual([]);

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

  it('denies out-of-snapshot HTTP tool calls and control-plane deck mutations', async () => {
    const service = await server!.db.createService({
      name: 'ea-http-svc',
      type: 'mcp',
      url: 'http://127.0.0.1:9/mcp',
    });
    const other = await server!.db.createService({
      name: 'ea-http-other',
      type: 'mcp',
      url: 'http://127.0.0.1:9/other',
    });
    await server!.db.addServiceToDeck({ deckId, serviceId: service.id, position: 0 });

    const enroll = await fetch(`${baseUrl}/api/execution-authority/enrollments`, {
      method: 'POST',
      headers: { Authorization: adminBearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinatorId: 'coord-contain', allowedDeckIds: [deckId] }),
    });
    const enrollBody = (await enroll.json()) as {
      data: { enrollment: { enrollmentId: string }; enrollmentSecret: string };
    };
    const enrollmentBearer = `Bearer ${enrollBody.data.enrollment.enrollmentId}:${enrollBody.data.enrollmentSecret}`;

    const mint = await fetch(`${baseUrl}/api/execution-authority/authorities`, {
      method: 'POST',
      headers: { Authorization: enrollmentBearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollmentId: enrollBody.data.enrollment.enrollmentId,
        runId: 'run_contain',
        attemptId: 'attempt_1',
        deckId,
        audience: 'dealer-worker',
        idempotencyKey: 'run_contain:1',
        ttlMs: 60_000,
        toolScopeHint: [{ serviceId: service.id, toolName: 'ping' }],
      }),
    });
    const mintBody = (await mint.json()) as {
      data?: { authority: { authorityId: string }; authoritySecret: string };
    };
    expect(mint.ok).toBe(true);
    const authorityBearer = `Bearer ${mintBody.data!.authority.authorityId}:${mintBody.data!.authoritySecret}`;

    const oosCall = await fetch(`${baseUrl}/api/services/${service.id}/call`, {
      method: 'POST',
      headers: { Authorization: authorityBearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolName: 'not-in-snapshot', arguments: {} }),
    });
    expect(oosCall.status).toBe(403);
    expect((await oosCall.json() as { error_code?: string }).error_code).toBe(
      'RESOURCE_OUT_OF_SCOPE',
    );

    const auditAfterDeny = await fetch(
      `${baseUrl}/api/execution-authority/audit?authorityId=${encodeURIComponent(mintBody.data!.authority.authorityId)}`,
      { headers: { Authorization: enrollmentBearer } },
    );
    const auditDenyBody = (await auditAfterDeny.json()) as {
      data: { events: Array<{ kind: string }> };
    };
    expect(auditDenyBody.data.events.some((e) => e.kind === 'call_denied')).toBe(true);

    const mutation = await fetch(`${baseUrl}/api/decks/${deckId}/services`, {
      method: 'POST',
      headers: { Authorization: authorityBearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceId: other.id }),
    });
    expect(mutation.status).toBe(403);
    expect((await mutation.json() as { error_code?: string }).error_code).toBe(
      'INTERACTION_REQUIRED',
    );

    const createService = await fetch(`${baseUrl}/api/services`, {
      method: 'POST',
      headers: { Authorization: authorityBearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'forged', type: 'mcp', url: 'http://127.0.0.1:9/x' }),
    });
    expect(createService.status).toBe(403);
    expect((await createService.json() as { error_code?: string }).error_code).toBe(
      'INTERACTION_REQUIRED',
    );
  });

  it('cross-enrollment inspect/revoke/audit probes do not pollute victim audit', async () => {
    const enrollA = await fetch(`${baseUrl}/api/execution-authority/enrollments`, {
      method: 'POST',
      headers: { Authorization: adminBearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinatorId: 'coord-audit-a', allowedDeckIds: [deckId] }),
    });
    const enrollB = await fetch(`${baseUrl}/api/execution-authority/enrollments`, {
      method: 'POST',
      headers: { Authorization: adminBearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinatorId: 'coord-audit-b', allowedDeckIds: [deckId] }),
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
        runId: 'run_audit_probe',
        attemptId: 'attempt_1',
        deckId,
        audience: 'dealer-worker',
        idempotencyKey: 'run_audit_probe:1',
        ttlMs: 60_000,
        toolScopeHint: [],
      }),
    });
    const mintBody = (await mint.json()) as {
      data: { authority: { authorityId: string } };
    };
    const authorityId = mintBody.data.authority.authorityId;

    const before = await fetch(
      `${baseUrl}/api/execution-authority/audit?enrollmentId=${encodeURIComponent(a.data.enrollment.enrollmentId)}`,
      { headers: { Authorization: bearerA } },
    );
    const beforeBody = (await before.json()) as {
      data: { events: Array<{ kind: string; correlation: { authorityId?: string } }> };
    };
    const beforeInspected = beforeBody.data.events.filter(
      (e) => e.kind === 'authority_inspected' && e.correlation.authorityId === authorityId,
    ).length;

    const probeInspect = await fetch(
      `${baseUrl}/api/execution-authority/authorities/${authorityId}`,
      { headers: { Authorization: bearerB } },
    );
    expect(probeInspect.status).toBe(404);

    const probeRevoke = await fetch(
      `${baseUrl}/api/execution-authority/authorities/${authorityId}/revoke`,
      { method: 'POST', headers: { Authorization: bearerB } },
    );
    expect(probeRevoke.status).toBe(404);

    const probeAudit = await fetch(
      `${baseUrl}/api/execution-authority/audit?authorityId=${encodeURIComponent(authorityId)}`,
      { headers: { Authorization: bearerB } },
    );
    expect(probeAudit.status).toBe(404);

    const after = await fetch(
      `${baseUrl}/api/execution-authority/audit?enrollmentId=${encodeURIComponent(a.data.enrollment.enrollmentId)}`,
      { headers: { Authorization: bearerA } },
    );
    const afterBody = (await after.json()) as {
      data: { events: Array<{ kind: string; correlation: { authorityId?: string } }> };
    };
    const afterInspected = afterBody.data.events.filter(
      (e) => e.kind === 'authority_inspected' && e.correlation.authorityId === authorityId,
    ).length;
    expect(afterInspected).toBe(beforeInspected);
  });

  it('denies forged live-display and preserves revoked authority contract codes', async () => {
    const otherDeck = await server!.db.createDeck({ name: 'ea-other-deck' });

    const enroll = await fetch(`${baseUrl}/api/execution-authority/enrollments`, {
      method: 'POST',
      headers: { Authorization: adminBearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinatorId: 'coord-live', allowedDeckIds: [deckId] }),
    });
    const enrollBody = (await enroll.json()) as {
      data: { enrollment: { enrollmentId: string }; enrollmentSecret: string };
    };
    const enrollmentBearer = `Bearer ${enrollBody.data.enrollment.enrollmentId}:${enrollBody.data.enrollmentSecret}`;

    const mint = await fetch(`${baseUrl}/api/execution-authority/authorities`, {
      method: 'POST',
      headers: { Authorization: enrollmentBearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollmentId: enrollBody.data.enrollment.enrollmentId,
        runId: 'run_live',
        attemptId: 'attempt_1',
        deckId,
        audience: 'dealer-worker',
        idempotencyKey: 'run_live:1',
        ttlMs: 60_000,
        toolScopeHint: [],
      }),
    });
    const mintBody = (await mint.json()) as {
      data: { authority: { authorityId: string }; authoritySecret: string };
    };
    const authorityBearer = `Bearer ${mintBody.data.authority.authorityId}:${mintBody.data.authoritySecret}`;
    const agentHeaders = {
      Authorization: authorityBearer,
      'Content-Type': 'application/json',
      [AGENT_DECK_CLIENT_HEADER]: AGENT_DECK_AGENT_CLIENT,
    };

    const forged = await fetch(`${baseUrl}/api/scope/live-display`, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({
        mcpSessionId: 'forged-session',
        deckId: otherDeck.id,
        deckName: 'ea-other-deck',
        source: 'session_override',
        cardCounts: { mcp: 0, credentials: 0, playbooks: 0 },
        updatedAt: new Date().toISOString(),
      }),
    });
    expect(forged.status).toBe(403);
    expect((await forged.json() as { error_code?: string }).error_code).toBe(
      'INTERACTION_REQUIRED',
    );

    const ownDeck = await fetch(`${baseUrl}/api/scope/live-display`, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({
        mcpSessionId: 'own-session',
        deckId,
        deckName: 'ea-http-deck',
        source: 'session_override',
        cardCounts: { mcp: 0, credentials: 0, playbooks: 0 },
        updatedAt: new Date().toISOString(),
      }),
    });
    expect(ownDeck.status).toBe(403);
    expect((await ownDeck.json() as { error_code?: string }).error_code).toBe(
      'INTERACTION_REQUIRED',
    );

    const foreignTouch = await fetch(`${baseUrl}/api/scope/live-display/someone-else/touch`, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({}),
    });
    expect(foreignTouch.status).toBe(403);
    expect((await foreignTouch.json() as { error_code?: string }).error_code).toBe(
      'INTERACTION_REQUIRED',
    );

    await fetch(
      `${baseUrl}/api/execution-authority/authorities/${mintBody.data.authority.authorityId}/revoke`,
      { method: 'POST', headers: { Authorization: enrollmentBearer } },
    );

    const revokedRead = await fetch(`${baseUrl}/api/scope/deck`, {
      headers: { Authorization: authorityBearer },
    });
    expect(revokedRead.status).toBe(403);
    expect((await revokedRead.json() as { error_code?: string }).error_code).toBe(
      'AUTHORITY_REVOKED',
    );
  });

  it('rejects authority on coordinator issuer routes and records one call_allowed per call', async () => {
    const service = await server!.db.createService({
      name: 'ea-audit-svc',
      type: 'mcp',
      url: 'http://127.0.0.1:9/mcp',
    });
    await server!.db.addServiceToDeck({ deckId, serviceId: service.id, position: 0 });

    const enroll = await fetch(`${baseUrl}/api/execution-authority/enrollments`, {
      method: 'POST',
      headers: { Authorization: adminBearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinatorId: 'coord-issuer', allowedDeckIds: [deckId] }),
    });
    const enrollBody = (await enroll.json()) as {
      data: { enrollment: { enrollmentId: string }; enrollmentSecret: string };
    };
    const enrollmentId = enrollBody.data.enrollment.enrollmentId;
    const enrollmentBearer = `Bearer ${enrollmentId}:${enrollBody.data.enrollmentSecret}`;

    // Mint via store so the snapshot includes a tool without live MCP discovery.
    const minted = server!.executionAuthorityStore.mintAuthority({
      enrollmentId,
      runId: 'run_issuer',
      attemptId: 'attempt_1',
      deckId,
      audience: 'dealer-worker',
      idempotencyKey: 'run_issuer:1',
      allowedServices: [service.id],
      allowedTools: [{ serviceId: service.id, toolName: 'ping' }],
      ttlMs: 60_000,
    });
    if (!minted.ok || !minted.data.authoritySecret) {
      throw new Error('mint failed');
    }
    const { authorityId } = minted.data.authority;
    const authoritySecret = minted.data.authoritySecret;
    const authorityBearer = `Bearer ${authorityId}:${authoritySecret}`;

    const mintAsWorker = await fetch(`${baseUrl}/api/execution-authority/authorities`, {
      method: 'POST',
      headers: { Authorization: authorityBearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollmentId,
        runId: 'run_forged',
        attemptId: 'attempt_x',
        deckId,
        audience: 'dealer-worker',
        idempotencyKey: 'run_forged:1',
        ttlMs: 60_000,
      }),
    });
    expect(mintAsWorker.status).toBe(403);
    expect((await mintAsWorker.json() as { error_code?: string }).error_code).toBe(
      'INTERACTION_REQUIRED',
    );

    const decksAsWorker = await fetch(`${baseUrl}/api/execution-authority/decks`, {
      headers: { Authorization: authorityBearer },
    });
    expect(decksAsWorker.status).toBe(403);
    expect((await decksAsWorker.json() as { error_code?: string }).error_code).toBe(
      'INTERACTION_REQUIRED',
    );

    const playbooksAsWorker = await fetch(
      `${baseUrl}/api/execution-authority/decks/${deckId}/playbooks`,
      { headers: { Authorization: authorityBearer } },
    );
    expect(playbooksAsWorker.status).toBe(403);
    expect((await playbooksAsWorker.json() as { error_code?: string }).error_code).toBe(
      'INTERACTION_REQUIRED',
    );

    const beforeAudit = await fetch(
      `${baseUrl}/api/execution-authority/audit?authorityId=${encodeURIComponent(authorityId)}`,
      { headers: { Authorization: enrollmentBearer } },
    );
    const beforeBody = (await beforeAudit.json()) as {
      data: { events: Array<{ kind: string }> };
    };
    const beforeAllowed = beforeBody.data.events.filter((e) => e.kind === 'call_allowed').length;

    await fetch(`${baseUrl}/api/services/${service.id}/call`, {
      method: 'POST',
      headers: { Authorization: authorityBearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolName: 'ping', arguments: {} }),
    });

    const afterAudit = await fetch(
      `${baseUrl}/api/execution-authority/audit?authorityId=${encodeURIComponent(authorityId)}`,
      { headers: { Authorization: enrollmentBearer } },
    );
    const afterBody = (await afterAudit.json()) as {
      data: { events: Array<{ kind: string }> };
    };
    const afterAllowed = afterBody.data.events.filter((e) => e.kind === 'call_allowed').length;
    expect(afterAllowed - beforeAllowed).toBe(1);
  });
});
