import { describe, expect, it } from 'vitest';

import { filterToolsForAuthority } from './execution-authority-http';
import type { ExecutionAuthority } from '../execution-authority/types';

function authorityRequest(authority: ExecutionAuthority) {
  return {
    requestPrincipal: { kind: 'execution-authority' as const, authority },
  } as Parameters<typeof filterToolsForAuthority>[0];
}

describe('filterToolsForAuthority', () => {
  const base: ExecutionAuthority = {
    authorityId: 'authz_test',
    enrollmentId: 'enr_test',
    runId: 'run_1',
    attemptId: 'attempt_1',
    deckId: '11111111-1111-4111-8111-111111111111',
    audience: 'dealer-worker',
    allowedServices: ['svc_a'],
    allowedTools: [{ serviceId: 'svc_a', toolName: 'ping' }],
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: 'live',
    idempotencyKey: 'k',
  };

  it('keeps only tools present in the minted snapshot', () => {
    const filtered = filterToolsForAuthority(authorityRequest(base), 'svc_a', [
      { name: 'ping' },
      { name: 'sibling' },
      { name: 'other' },
    ]);
    expect(filtered.map((t) => t.name)).toEqual(['ping']);
  });

  it('returns empty when the snapshot has no tools for the service', () => {
    const empty = {
      ...base,
      allowedServices: [],
      allowedTools: [],
    };
    const filtered = filterToolsForAuthority(authorityRequest(empty), 'svc_a', [
      { name: 'ping' },
      { name: 'sibling' },
    ]);
    expect(filtered).toEqual([]);
  });
});
