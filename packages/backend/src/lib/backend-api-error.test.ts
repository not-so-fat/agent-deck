import { describe, expect, it } from 'vitest';

import { parseBackendErrorBody } from './backend-api-error';

describe('parseBackendErrorBody', () => {
  it('extracts error_code from trusted session JSON', () => {
    const err = parseBackendErrorBody(
      JSON.stringify({
        success: false,
        error: 'Service is not on the bound deck',
        error_code: 'RESOURCE_OUT_OF_SCOPE',
      }),
      403,
    );
    expect(err.errorCode).toBe('RESOURCE_OUT_OF_SCOPE');
    expect(err.message).toBe('Service is not on the bound deck');
    expect(err.status).toBe(403);
  });
});
