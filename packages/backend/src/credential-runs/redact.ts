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
 * Longest needle length across the resolved secrets. The executor buffers
 * the output cap plus this overlap so a secret crossing the cap boundary
 * is fully present before redaction — no partial needle survives the cut.
 */
export function maxCredentialRunNeedleLength(secrets: string[]): number {
  let max = 0;
  for (const needle of collectCredentialRunNeedles(secrets)) {
    if (needle.length > max) {
      max = needle.length;
    }
  }
  return max;
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
