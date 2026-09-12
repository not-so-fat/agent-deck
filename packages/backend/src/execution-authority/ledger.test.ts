import { describe, expect, it } from 'vitest';

import { ExecutionAuthorityLedger } from './ledger';

describe('ExecutionAuthorityLedger (NOT-85 contract skeleton)', () => {
  it('proves enroll → mint → allowed call → deny OOS → revoke → audit correlation', () => {
    let nowMs = Date.parse('2026-09-12T12:00:00.000Z');
    const ledger = new ExecutionAuthorityLedger({
      now: () => new Date(nowMs),
    });

    const enrolled = ledger.enrollCoordinator({
      coordinatorId: 'dealer-local-1',
      allowedDeckIds: ['deck_dev'],
    });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;

    const minted = ledger.mintAuthority({
      enrollmentId: enrolled.data.enrollmentId,
      runId: 'run_1',
      attemptId: 'attempt_1',
      deckId: 'deck_dev',
      audience: 'dealer-worker',
      idempotencyKey: 'run_1:attempt_1',
      allowedServices: ['svc_linear'],
      allowedTools: [{ serviceId: 'svc_linear', toolName: 'get_issue' }],
      ttlMs: 60_000,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(minted.data.authoritySecret).toMatch(/^seas_/);
    expect(minted.data.authority.status).toBe('live');

    const remint = ledger.mintAuthority({
      enrollmentId: enrolled.data.enrollmentId,
      runId: 'run_1',
      attemptId: 'attempt_1',
      deckId: 'deck_dev',
      audience: 'dealer-worker',
      idempotencyKey: 'run_1:attempt_1',
      allowedServices: ['svc_linear'],
      allowedTools: [{ serviceId: 'svc_linear', toolName: 'get_issue' }],
      ttlMs: 60_000,
    });
    expect(remint.ok).toBe(true);
    if (!remint.ok) return;
    expect(remint.data.authority.authorityId).toBe(minted.data.authority.authorityId);

    const allowed = ledger.invokeAuthorizedCall({
      authorityId: minted.data.authority.authorityId,
      authoritySecret: minted.data.authoritySecret,
      serviceId: 'svc_linear',
      toolName: 'get_issue',
    });
    expect(allowed).toEqual({
      ok: true,
      data: { serviceId: 'svc_linear', toolName: 'get_issue', result: 'ok' },
    });

    const denied = ledger.invokeAuthorizedCall({
      authorityId: minted.data.authority.authorityId,
      authoritySecret: minted.data.authoritySecret,
      serviceId: 'svc_linear',
      toolName: 'save_issue',
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error_code).toBe('RESOURCE_OUT_OF_SCOPE');

    const interaction = ledger.invokeAuthorizedCall({
      authorityId: minted.data.authority.authorityId,
      authoritySecret: minted.data.authoritySecret,
      serviceId: 'svc_linear',
      toolName: 'get_issue',
      requiresInteraction: true,
    });
    expect(interaction.ok).toBe(false);
    if (interaction.ok) return;
    expect(interaction.error_code).toBe('INTERACTION_REQUIRED');
    expect(interaction.correlation?.requestId).toMatch(/^req_/);

    nowMs += 61_000;
    const expired = ledger.invokeAuthorizedCall({
      authorityId: minted.data.authority.authorityId,
      authoritySecret: minted.data.authoritySecret,
      serviceId: 'svc_linear',
      toolName: 'get_issue',
    });
    expect(expired.ok).toBe(false);
    if (expired.ok) return;
    expect(expired.error_code).toBe('AUTHORITY_EXPIRED');

    const mint2 = ledger.mintAuthority({
      enrollmentId: enrolled.data.enrollmentId,
      runId: 'run_1',
      attemptId: 'attempt_2',
      deckId: 'deck_dev',
      audience: 'dealer-worker',
      idempotencyKey: 'run_1:attempt_2',
      allowedServices: ['svc_linear'],
      allowedTools: [{ serviceId: 'svc_linear', toolName: 'get_issue' }],
      ttlMs: 60_000,
    });
    expect(mint2.ok).toBe(true);
    if (!mint2.ok) return;

    const revoked = ledger.revokeAuthority(mint2.data.authority.authorityId);
    expect(revoked.ok).toBe(true);

    const afterRevoke = ledger.invokeAuthorizedCall({
      authorityId: mint2.data.authority.authorityId,
      authoritySecret: mint2.data.authoritySecret,
      serviceId: 'svc_linear',
      toolName: 'get_issue',
    });
    expect(afterRevoke.ok).toBe(false);
    if (afterRevoke.ok) return;
    expect(afterRevoke.error_code).toBe('AUTHORITY_REVOKED');

    const events = ledger.listAuditEvents({ runId: 'run_1' });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('authority_minted');
    expect(kinds).toContain('call_allowed');
    expect(kinds).toContain('call_denied');
    expect(kinds).toContain('authority_expired');
    expect(kinds).toContain('authority_revoked');
    expect(events.every((e) => !JSON.stringify(e).includes('seas_'))).toBe(true);
  });

  it('fails closed when enrollment is revoked', () => {
    const ledger = new ExecutionAuthorityLedger();
    const enrolled = ledger.enrollCoordinator({
      coordinatorId: 'dealer-local-2',
      allowedDeckIds: ['deck_dev'],
    });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;

    const minted = ledger.mintAuthority({
      enrollmentId: enrolled.data.enrollmentId,
      runId: 'run_x',
      attemptId: 'attempt_x',
      deckId: 'deck_dev',
      audience: 'dealer-worker',
      idempotencyKey: 'run_x:attempt_x',
      allowedServices: ['svc_linear'],
      allowedTools: [{ serviceId: 'svc_linear', toolName: 'get_issue' }],
      ttlMs: 60_000,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    ledger.revokeEnrollment(enrolled.data.enrollmentId);

    const call = ledger.invokeAuthorizedCall({
      authorityId: minted.data.authority.authorityId,
      authoritySecret: minted.data.authoritySecret,
      serviceId: 'svc_linear',
      toolName: 'get_issue',
    });
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.error_code).toBe('AUTHORITY_REVOKED');

    const remint = ledger.mintAuthority({
      enrollmentId: enrolled.data.enrollmentId,
      runId: 'run_x',
      attemptId: 'attempt_y',
      deckId: 'deck_dev',
      audience: 'dealer-worker',
      idempotencyKey: 'run_x:attempt_y',
      allowedServices: ['svc_linear'],
      allowedTools: [{ serviceId: 'svc_linear', toolName: 'get_issue' }],
      ttlMs: 60_000,
    });
    expect(remint.ok).toBe(false);
    if (remint.ok) return;
    expect(remint.error_code).toBe('ENROLLMENT_REVOKED');
  });
});
