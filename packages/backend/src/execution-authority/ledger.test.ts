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
      enrollmentId: enrolled.data.enrollment.enrollmentId,
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
    expect(minted.data.secretIssued).toBe(true);
    expect(minted.data.authoritySecret).toMatch(/^seas_/);
    expect(minted.data.authority.status).toBe('live');

    // Caller mutation must not corrupt ledger state.
    minted.data.authority.status = 'revoked';

    const remint = ledger.mintAuthority({
      enrollmentId: enrolled.data.enrollment.enrollmentId,
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
    expect(remint.data.authority.status).toBe('live');
    expect(remint.data.secretIssued).toBe(false);
    expect(remint.data.authoritySecret).toBeNull();

    const allowed = ledger.invokeAuthorizedCall({
      authorityId: minted.data.authority.authorityId,
      authoritySecret: minted.data.authoritySecret!,
      audience: 'dealer-worker',
      serviceId: 'svc_linear',
      toolName: 'get_issue',
    });
    expect(allowed).toEqual({
      ok: true,
      data: { serviceId: 'svc_linear', toolName: 'get_issue', result: 'ok' },
    });

    const denied = ledger.invokeAuthorizedCall({
      authorityId: minted.data.authority.authorityId,
      authoritySecret: minted.data.authoritySecret!,
      audience: 'dealer-worker',
      serviceId: 'svc_linear',
      toolName: 'save_issue',
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error_code).toBe('RESOURCE_OUT_OF_SCOPE');
    expect(denied.reason).toBe('tool_not_in_snapshot');

    const interaction = ledger.invokeAuthorizedCall({
      authorityId: minted.data.authority.authorityId,
      authoritySecret: minted.data.authoritySecret!,
      audience: 'dealer-worker',
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
      authoritySecret: minted.data.authoritySecret!,
      audience: 'dealer-worker',
      serviceId: 'svc_linear',
      toolName: 'get_issue',
    });
    expect(expired.ok).toBe(false);
    if (expired.ok) return;
    expect(expired.error_code).toBe('AUTHORITY_EXPIRED');

    const mint2 = ledger.mintAuthority({
      enrollmentId: enrolled.data.enrollment.enrollmentId,
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
      authoritySecret: mint2.data.authoritySecret!,
      audience: 'dealer-worker',
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
      enrollmentId: enrolled.data.enrollment.enrollmentId,
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

    ledger.revokeEnrollment(enrolled.data.enrollment.enrollmentId);

    const call = ledger.invokeAuthorizedCall({
      authorityId: minted.data.authority.authorityId,
      authoritySecret: minted.data.authoritySecret!,
      audience: 'dealer-worker',
      serviceId: 'svc_linear',
      toolName: 'get_issue',
    });
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.error_code).toBe('AUTHORITY_REVOKED');

    const remint = ledger.mintAuthority({
      enrollmentId: enrolled.data.enrollment.enrollmentId,
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

  it('covers review fixes: ttl, idempotency conflict, audience, unknown/secret codes, expiry-before-revoke', () => {
    let nowMs = Date.parse('2026-09-12T12:00:00.000Z');
    const ledger = new ExecutionAuthorityLedger({
      now: () => new Date(nowMs),
    });

    const enrolled = ledger.enrollCoordinator({
      coordinatorId: 'dealer-local-3',
      allowedDeckIds: ['deck_dev'],
    });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;

    const badTtl = ledger.mintAuthority({
      enrollmentId: enrolled.data.enrollment.enrollmentId,
      runId: 'run_t',
      attemptId: 'attempt_t',
      deckId: 'deck_dev',
      audience: 'dealer-worker',
      idempotencyKey: 'run_t:attempt_t',
      allowedServices: ['svc_linear'],
      allowedTools: [{ serviceId: 'svc_linear', toolName: 'get_issue' }],
      ttlMs: 0,
    });
    expect(badTtl.ok).toBe(false);
    if (badTtl.ok) return;
    expect(badTtl.error_code).toBe('INVALID_MINT_REQUEST');
    expect(badTtl.reason).toBe('ttl_non_positive');

    const minted = ledger.mintAuthority({
      enrollmentId: enrolled.data.enrollment.enrollmentId,
      runId: 'run_a',
      attemptId: 'attempt_a',
      deckId: 'deck_dev',
      audience: 'dealer-worker',
      idempotencyKey: 'run_a:key',
      allowedServices: ['svc_linear'],
      allowedTools: [{ serviceId: 'svc_linear', toolName: 'get_issue' }],
      ttlMs: 60_000,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const conflict = ledger.mintAuthority({
      enrollmentId: enrolled.data.enrollment.enrollmentId,
      runId: 'run_a',
      attemptId: 'attempt_DIFFERENT',
      deckId: 'deck_dev',
      audience: 'dealer-worker',
      idempotencyKey: 'run_a:key',
      allowedServices: ['svc_linear'],
      allowedTools: [{ serviceId: 'svc_linear', toolName: 'get_issue' }],
      ttlMs: 60_000,
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error_code).toBe('IDEMPOTENCY_KEY_CONFLICT');

    const ttlConflict = ledger.mintAuthority({
      enrollmentId: enrolled.data.enrollment.enrollmentId,
      runId: 'run_a',
      attemptId: 'attempt_a',
      deckId: 'deck_dev',
      audience: 'dealer-worker',
      idempotencyKey: 'run_a:key',
      allowedServices: ['svc_linear'],
      allowedTools: [{ serviceId: 'svc_linear', toolName: 'get_issue' }],
      ttlMs: 120_000,
    });
    expect(ttlConflict.ok).toBe(false);
    if (ttlConflict.ok) return;
    expect(ttlConflict.error_code).toBe('IDEMPOTENCY_KEY_CONFLICT');

    const unknown = ledger.invokeAuthorizedCall({
      authorityId: 'authz_missing',
      authoritySecret: 'seas_x',
      audience: 'dealer-worker',
      serviceId: 'svc_linear',
      toolName: 'get_issue',
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error_code).toBe('AUTHORITY_UNKNOWN');

    const badSecret = ledger.invokeAuthorizedCall({
      authorityId: minted.data.authority.authorityId,
      authoritySecret: 'seas_wrong',
      audience: 'dealer-worker',
      serviceId: 'svc_linear',
      toolName: 'get_issue',
    });
    expect(badSecret.ok).toBe(false);
    if (badSecret.ok) return;
    expect(badSecret.error_code).toBe('AUTHORITY_SECRET_INVALID');

    const badAudience = ledger.invokeAuthorizedCall({
      authorityId: minted.data.authority.authorityId,
      authoritySecret: minted.data.authoritySecret!,
      audience: 'not-a-worker',
      serviceId: 'svc_linear',
      toolName: 'get_issue',
    });
    expect(badAudience.ok).toBe(false);
    if (badAudience.ok) return;
    expect(badAudience.error_code).toBe('AUDIENCE_MISMATCH');

    const deckDenied = ledger.mintAuthority({
      enrollmentId: enrolled.data.enrollment.enrollmentId,
      runId: 'run_b',
      attemptId: 'attempt_b',
      deckId: 'deck_forbidden',
      audience: 'dealer-worker',
      idempotencyKey: 'run_b:key',
      allowedServices: ['svc_linear'],
      allowedTools: [{ serviceId: 'svc_linear', toolName: 'get_issue' }],
      ttlMs: 60_000,
    });
    expect(deckDenied.ok).toBe(false);
    if (deckDenied.ok) return;
    expect(deckDenied.error_code).toBe('RESOURCE_OUT_OF_SCOPE');
    expect(deckDenied.reason).toBe('deck_not_permitted');

    nowMs += 61_000;
    ledger.revokeEnrollment(enrolled.data.enrollment.enrollmentId);
    const expiryEvents = ledger.listAuditEvents({
      authorityId: minted.data.authority.authorityId,
    });
    expect(expiryEvents.some((e) => e.kind === 'authority_expired')).toBe(true);
    expect(
      expiryEvents.some(
        (e) => e.kind === 'authority_revoked' && e.correlation.authorityId === minted.data.authority.authorityId,
      ),
    ).toBe(false);
  });
});
