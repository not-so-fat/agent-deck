export type ParseHeadersResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; error: string };

export function hasCustomHeaders(
  headers?: Record<string, string> | null,
): boolean {
  return Boolean(headers && typeof headers === 'object' && Object.keys(headers).length > 0);
}

export function formatHeadersForEditor(
  headers?: Record<string, string> | null,
): string {
  if (!hasCustomHeaders(headers)) {
    return '{\n  \n}';
  }
  return JSON.stringify(headers, null, 2);
}

/** Validate headers JSON for save. Invalid → ok:false (caller must not PUT). */
export function parseHeadersJson(text: string): ParseHeadersResult {
  const trimmed = text.trim();
  if (!trimmed || trimmed === '{}') {
    return { ok: true, headers: {} };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        error: 'Headers must be a JSON object (e.g. {"Authorization": "Bearer token"})',
      };
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') {
        return { ok: false, error: `Header "${key}" must be a string value` };
      }
    }
    return { ok: true, headers: parsed as Record<string, string> };
  } catch {
    return { ok: false, error: 'Invalid JSON — fix syntax before saving' };
  }
}

/** View-mode mask: Bearer keeps prefix; any other non-empty value is ••••. */
export function maskHeaderValue(value: string): string {
  if (/^bearer\s+/i.test(value)) {
    return 'Bearer ••••';
  }
  if (value.length > 0) {
    return '••••';
  }
  return '';
}

export function maskedHeadersEntries(
  headers?: Record<string, string> | null,
): Array<{ name: string; masked: string }> {
  if (!hasCustomHeaders(headers)) {
    return [];
  }
  return Object.entries(headers!).map(([name, value]) => ({
    name,
    masked: maskHeaderValue(value),
  }));
}
