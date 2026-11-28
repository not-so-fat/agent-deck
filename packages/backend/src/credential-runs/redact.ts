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

/** Build one redactor over the resolved secret values. */
export function buildCredentialRunRedactor(secrets: string[]): (text: string) => string {
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
  const ordered = [...needles].sort((a, b) => b.length - a.length);
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
