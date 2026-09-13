import type { TrustedSessionErrorCode } from '@agent-deck/shared';

export class BackendApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly errorCode?: TrustedSessionErrorCode,
  ) {
    super(message);
    this.name = 'BackendApiError';
  }
}

export function parseBackendErrorBody(text: string, status: number): BackendApiError {
  let message = `Backend API error: ${status}`;
  let errorCode: TrustedSessionErrorCode | undefined;

  try {
    const body = JSON.parse(text) as {
      error?: string;
      message?: string;
      error_code?: string;
    };
    if (body.error) {
      message = String(body.error);
    } else if (body.message) {
      message = String(body.message);
    }
    if (body.error_code) {
      // May be a trusted-session code or an execution-authority contract code.
      errorCode = body.error_code as TrustedSessionErrorCode;
    }
  } catch {
    if (text.trim()) {
      message = text.trim();
    }
  }

  return new BackendApiError(message, status, errorCode);
}
