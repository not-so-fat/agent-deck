import { afterEach, describe, expect, it, vi } from 'vitest';

import { activateWorkspaceGrant, formatTrustedWriterError, revokePendingWorkspaceGrant } from './grant-issue';

vi.mock('./admin-secret', () => ({
  readAdminSecret: async () => 'test-admin-secret-at-least-32-chars!!',
}));

vi.mock('./defaults', () => ({
  readCliBackendPort: () => 1111,
}));

describe('formatTrustedWriterError', () => {
  it('prefers Fastify message over bare Bad Request', () => {
    expect(
      formatTrustedWriterError(
        400,
        {
          statusCode: 400,
          code: 'FST_ERR_CTP_EMPTY_JSON_BODY',
          error: 'Bad Request',
          message: "Body cannot be empty when content-type is set to 'application/json'",
        } as { error?: string; message?: string },
        'Grant activation failed',
      ),
    ).toContain('Body cannot be empty');
  });

  it('falls back with status when only Bad Request', () => {
    expect(formatTrustedWriterError(400, { error: 'Bad Request' }, 'Grant activation failed')).toBe(
      'Bad Request (400)',
    );
  });
});

describe('activateWorkspaceGrant', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs JSON {} so Fastify does not reject empty body', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: { grantId: 'gr_1', deckId: 'deck_1', deckName: 'personal-dev' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await activateWorkspaceGrant({ grantId: 'gr_1', host: '127.0.0.1' });
    expect(result).toEqual({ grantId: 'gr_1', deckId: 'deck_1', deckName: 'personal-dev' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('surfaces Fastify empty-body message on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            statusCode: 400,
            code: 'FST_ERR_CTP_EMPTY_JSON_BODY',
            error: 'Bad Request',
            message: "Body cannot be empty when content-type is set to 'application/json'",
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const result = await activateWorkspaceGrant({ grantId: 'gr_1' });
    expect(result).toEqual({
      error: "Body cannot be empty when content-type is set to 'application/json'",
    });
  });
});

describe('revokePendingWorkspaceGrant', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('also sends JSON {}', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await revokePendingWorkspaceGrant({ grantId: 'gr_1', host: '127.0.0.1' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe('{}');
  });
});
