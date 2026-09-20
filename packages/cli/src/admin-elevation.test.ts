import { describe, expect, it, vi } from 'vitest';

import {
  openAdminElevationApproval,
  readAdminElevationApproval,
} from './admin-elevation';

function toolResult(data: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

describe('admin elevation approval launch', () => {
  it('preserves the exact challenge and originating runtime session', async () => {
    const result = toolResult({
      challengeId: 'adm_exact',
      runtimeSessionId: 'ses_origin',
      expiresAt: '2030-01-01T00:00:00.000Z',
      approvalUrl: '/admin/approve?challenge=adm_exact&session=ses_origin',
    });
    const opener = vi.fn(async () => ({ code: 0, url: 'http://127.0.0.1/opened' }));

    expect(readAdminElevationApproval(result)).toEqual({
      approvalPath: '/admin/approve?challenge=adm_exact&session=ses_origin',
      challengeId: 'adm_exact',
      runtimeSessionId: 'ses_origin',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });

    await openAdminElevationApproval('http://127.0.0.1:1111', result, opener);
    expect(opener).toHaveBeenCalledWith(
      'http://127.0.0.1:1111',
      '/admin/approve?challenge=adm_exact&session=ses_origin',
    );
  });

  it('rejects a response whose fields do not match its URL', async () => {
    const result = toolResult({
      challengeId: 'adm_other',
      runtimeSessionId: 'ses_origin',
      approvalUrl: '/admin/approve?challenge=adm_exact&session=ses_origin',
    });

    expect(readAdminElevationApproval(result)).toBeUndefined();
    await expect(
      openAdminElevationApproval('http://127.0.0.1:1111', result, vi.fn()),
    ).rejects.toThrow('valid approval URL');
  });

  it('reports browser/bootstrap launch failures', async () => {
    const result = toolResult({
      challengeId: 'adm_exact',
      runtimeSessionId: 'ses_origin',
      approvalUrl: '/admin/approve?challenge=adm_exact&session=ses_origin',
    });

    await expect(
      openAdminElevationApproval(
        'http://127.0.0.1:1111',
        result,
        async () => ({ code: 1, message: 'admin secret unavailable' }),
      ),
    ).rejects.toThrow('admin secret unavailable');
  });

  it('does not open a browser when AGENT_DECK_NO_OPEN is set', async () => {
    const result = toolResult({
      challengeId: 'adm_exact',
      runtimeSessionId: 'ses_origin',
      approvalUrl: '/admin/approve?challenge=adm_exact&session=ses_origin',
    });
    const opener = vi.fn(async () => ({ code: 0 }));

    await openAdminElevationApproval('http://127.0.0.1:1111', result, opener, {
      AGENT_DECK_NO_OPEN: '1',
    });
    expect(opener).not.toHaveBeenCalled();
  });
});
