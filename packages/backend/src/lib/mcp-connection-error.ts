export type McpErrorCode =
  | 'MCP_TRANSPORT_ERROR'
  | 'MCP_AUTH_ERROR'
  | 'MCP_TOOL_ERROR'
  | 'MCP_CONNECTION_ERROR';

export interface ServiceToolErrorDetails {
  service_id: string;
  service_name: string;
  remote_url: string;
  tool_name?: string;
  cause: string;
  phase: 'connect' | 'discoverTools' | 'callTool';
  hint?: string;
}

/**
 * NOT-639: thrown once the OAuth refresh-and-retry for a rejected access token
 * has run. Callers must not retry again (no loop); `needsReconnect` is true
 * when the refresh itself was impossible or failed.
 */
export class McpOAuthRejectedError extends Error {
  readonly needsReconnect: boolean;

  constructor(message: string, options: { needsReconnect: boolean; cause?: unknown }) {
    super(message);
    this.name = 'McpOAuthRejectedError';
    this.needsReconnect = options.needsReconnect;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Whether an MCP failure means the remote server rejected our credentials (HTTP 401). */
export function isMcpUnauthorizedError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  if (typeof err === 'object') {
    const { code, name } = err as { code?: unknown; name?: unknown };
    if (code === 401 || name === 'UnauthorizedError') {
      return true;
    }
  }
  const msg = errorMessage(err).toLowerCase();
  return (
    /\b401\b/.test(msg)
    || msg.includes('unauthorized')
    || msg.includes('invalid_token')
    || msg.includes('invalid access token')
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err ?? '');
}

/** Whether legacy HTTP+SSE transport is worth trying after Streamable HTTP fails. */
export function shouldAttemptLegacySseFallback(streamableError: unknown): boolean {
  if (extractMcpErrorMessage(streamableError)) {
    return false;
  }

  const msg = errorMessage(streamableError).toLowerCase();
  if (!msg) {
    return false;
  }

  if (
    msg.includes('401')
    || msg.includes('403')
    || msg.includes('unauthorized')
    || msg.includes('streamable http error')
    || msg.includes('unexpected content type')
    || msg.includes('error posting to endpoint (http 4')
    || msg.includes('error posting to endpoint (http 5')
  ) {
    return false;
  }

  return true;
}

/** Extract a user-facing message from MCP client connection failures. */
export function formatMcpConnectionError(
  streamableError: unknown,
  sseError: unknown,
): string {
  for (const err of [streamableError, sseError]) {
    if (!err) {
      continue;
    }
    const parsed = extractMcpErrorMessage(err);
    if (parsed) {
      return parsed;
    }
  }

  const streamableMsg = errorMessage(streamableError);
  const sseMsg = errorMessage(sseError);

  // Streamable-only servers often return JSON to SSE; don't let the SSE message hide the real fault.
  if (streamableMsg && sseMsg.includes('Invalid content type')) {
    return `Failed to connect to MCP service: ${streamableMsg}`;
  }

  if (streamableMsg) {
    return `Failed to connect to MCP service: ${streamableMsg}`;
  }

  if (sseMsg && !sseMsg.includes('Non-200 status code')) {
    return `Failed to connect to MCP service: ${sseMsg}`;
  }

  return 'Failed to connect to MCP service';
}

export function extractMcpErrorMessage(err: unknown): string | null {
  return parseMcpErrorMessage(err);
}

/** Resolve the best user-facing message from any MCP-related failure. */
export function resolveMcpErrorMessage(err: unknown): string {
  const parsed = extractMcpErrorMessage(err);
  if (parsed) {
    return parsed;
  }

  if (err instanceof Error && err.message.trim()) {
    return err.message.trim();
  }

  const raw = String(err ?? '').trim();
  return raw || 'Failed to call tool';
}

export function classifyMcpErrorCode(message: string): McpErrorCode {
  const lower = message.toLowerCase();

  if (
    lower.includes('unauthorized')
    || lower.includes('401')
    || lower.includes('403')
    || lower.includes('token')
    || lower.includes('app is not enabled')
    || lower.includes('authentication')
  ) {
    return 'MCP_AUTH_ERROR';
  }

  if (
    lower.includes('content type')
    || lower.includes('text/event-stream')
    || lower.includes('sse error')
    || lower.includes('econnrefused')
    || lower.includes('enotfound')
    || lower.includes('etimedout')
    || lower.includes('fetch failed')
    || lower.includes('network')
  ) {
    return 'MCP_TRANSPORT_ERROR';
  }

  if (lower.includes('failed to connect to mcp service')) {
    return 'MCP_CONNECTION_ERROR';
  }

  return 'MCP_TOOL_ERROR';
}

function parseMcpErrorMessage(err: unknown): string | null {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  if (!raw) {
    return null;
  }

  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const payload = JSON.parse(raw.slice(jsonStart)) as {
        error?: { message?: string };
        message?: string;
      };
      const rpcMessage = payload.error?.message?.trim();
      if (rpcMessage) {
        return rpcMessage;
      }
      const plainMessage = payload.message?.trim();
      if (plainMessage) {
        return plainMessage;
      }
    } catch {
      // fall through
    }
  }

  if (raw.includes('App is not enabled for Slack MCP')) {
    return raw.replace(/^Error POSTing to endpoint \(HTTP \d+\): /, '');
  }

  return null;
}
