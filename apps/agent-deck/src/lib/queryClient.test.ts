import { describe, expect, it } from 'vitest';

import { ApiError, isDashboardAuthError, throwIfResNotOk } from './queryClient';

describe('dashboard API errors', () => {
  it('preserves status and trusted-session error codes', async () => {
    const response = new Response(
      JSON.stringify({ success: false, error: 'No valid workspace grant', error_code: 'GRANT_REQUIRED' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );

    const error = await throwIfResNotOk(response).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      message: 'No valid workspace grant',
      status: 401,
      errorCode: 'GRANT_REQUIRED',
    });
    expect(isDashboardAuthError(error)).toBe(true);
  });

  it('does not classify ordinary server failures as dashboard auth failures', () => {
    expect(isDashboardAuthError(new ApiError('Unavailable', 503))).toBe(false);
  });
});
