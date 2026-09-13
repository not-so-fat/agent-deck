/**
 * Parse coordinator enrollment / execution-authority bearer tokens.
 * Forms: `enr_…:secret`, `authz_…:secret` (preferred), or raw secret with id header.
 */

export type EnrollmentBearer = {
  enrollmentId: string;
  secret: string;
};

export type AuthorityBearer = {
  authorityId: string;
  secret: string;
};

export function parseEnrollmentBearer(token: string): EnrollmentBearer | null {
  const trimmed = token.trim();
  const colon = trimmed.indexOf(':');
  if (colon <= 0) return null;
  const enrollmentId = trimmed.slice(0, colon);
  if (!/^enr_[A-Za-z0-9]+$/.test(enrollmentId)) return null;
  const secret = trimmed.slice(colon + 1);
  if (!secret) return null;
  return { enrollmentId, secret };
}

export function parseAuthorityBearer(token: string): AuthorityBearer | null {
  const trimmed = token.trim();
  const colon = trimmed.indexOf(':');
  if (colon <= 0) return null;
  const authorityId = trimmed.slice(0, colon);
  if (!/^authz_[A-Za-z0-9]+$/.test(authorityId)) return null;
  const secret = trimmed.slice(colon + 1);
  if (!secret) return null;
  return { authorityId, secret };
}
