/**
 * Secret redaction for credential runs.
 *
 * Every resolved secret value is scrubbed from child output before anything
 * is returned, logged, or persisted — in its raw form and in the two
 * encodings a child (or its error paths) most plausibly emits: base64 and
 * URL-encoding. Matching is plain substring replacement, longest values
 * first, so overlapping secrets redact fully.
 */

export const CREDENTIAL_RUN_REDACTED = '[REDACTED]';

/** Every needle the redactor scrubs: raw, base64, and URL-encoded forms. */
function collectCredentialRunNeedles(secrets: string[]): Set<string> {
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (!secret) {
      continue;
    }
    needles.add(secret);
    try {
      needles.add(Buffer.from(secret, 'utf8').toString('base64'));
    } catch {
      // Non-encodable value: the raw form above still redacts.
    }
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) {
      needles.add(encoded);
    }
  }
  return needles;
}

/**
 * Longest needle length in UTF-8 bytes across the resolved secrets. The
 * executor buffers the output cap plus this overlap so a secret crossing
 * the cap boundary is fully present before redaction — no partial needle
 * survives the cut.
 */
export function maxCredentialRunNeedleLength(secrets: string[]): number {
  let max = 0;
  for (const needle of collectCredentialRunNeedles(secrets)) {
    const bytes = Buffer.byteLength(needle, 'utf8');
    if (bytes > max) {
      max = bytes;
    }
  }
  return max;
}

/**
 * Build a tail guard for a buffer that was cut mid-stream. The cut can split
 * a needle, leaving a prefix of it at the very end that no full-needle match
 * redacts. Earlier redactions shorten the text, so that tail can later fall
 * back inside the output cap. The guard strips the longest suffix of `text`
 * that is a proper prefix of any needle form (raw, base64, URL-encoded).
 * Apply it to the *redacted* text, and only when the stream was cut.
 */
export function buildCredentialRunTailGuard(secrets: string[]): (text: string) => string {
  const needles = [...collectCredentialRunNeedles(secrets)];
  return (text: string) => {
    let strip = 0;
    for (const needle of needles) {
      const max = Math.min(needle.length - 1, text.length);
      for (let len = max; len > strip; len--) {
        if (text.endsWith(needle.slice(0, len))) {
          strip = len;
          break;
        }
      }
    }
    return strip > 0 ? text.slice(0, text.length - strip) : text;
  };
}

/** Build one redactor over the resolved secret values. */
export function buildCredentialRunRedactor(secrets: string[]): (text: string) => string {
  const ordered = [...collectCredentialRunNeedles(secrets)].sort((a, b) => b.length - a.length);
  return (text: string) => {
    let out = text;
    for (const needle of ordered) {
      if (out.includes(needle)) {
        out = out.split(needle).join(CREDENTIAL_RUN_REDACTED);
      }
    }
    return out;
  };
}
