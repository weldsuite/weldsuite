/**
 * Who a widget visitor is.
 *
 * Visitor token: issued here (`POST /api/visitor`), never made up by the
 * browser. An HS256 JWT under a key derived from WIDGET_TOKEN_SECRET, naming
 * the visitor row and bound to one workspace and widget. The widget keeps it
 * and sends it as `Authorization: Bearer`; every conversation route takes
 * the visitor from it.
 *
 * Identity token: signed by the customer's own server with the widget's
 * identity secret. Its `sub` (their user id) picks the visitor row and its
 * `email` becomes that visitor's verified email, so the email is covered by
 * the signature too: a signed-in user of the customer's site cannot claim
 * someone else's address.
 */

import { deriveSecret, signJwt, verifyJwt, type JwtFailure } from './tokens';

/** A year; every widget load refreshes it. */
export const VISITOR_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const VISITOR_TOKEN_AUDIENCE = 'desk-visitor';
const VISITOR_KEY_LABEL = 'weldsuite:desk-visitor-token:v1';

export interface VisitorTokenClaims {
  visitorId: string;
  /** `workspaces.id`. */
  workspaceId: string;
  widgetId: string;
}

async function visitorKey(secret: string): Promise<string> {
  return deriveSecret(secret, VISITOR_KEY_LABEL);
}

export async function issueVisitorToken(secret: string, claims: VisitorTokenClaims, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  return signJwt(await visitorKey(secret), {
    aud: VISITOR_TOKEN_AUDIENCE,
    sub: claims.visitorId,
    ws: claims.workspaceId,
    wid: claims.widgetId,
    iat: nowSeconds,
    exp: nowSeconds + VISITOR_TOKEN_TTL_SECONDS,
  });
}

/** The visitor a token names, or null when it is not one of ours (or expired). */
export async function readVisitorToken(secret: string, token: string): Promise<VisitorTokenClaims | null> {
  const result = await verifyJwt(await visitorKey(secret), token);
  if (!result.ok) return null;
  const { aud, sub, ws, wid, exp } = result.claims;
  if (aud !== VISITOR_TOKEN_AUDIENCE || typeof exp !== 'number') return null;
  if (typeof sub !== 'string' || !sub || typeof ws !== 'string' || typeof wid !== 'string') return null;
  return { visitorId: sub, workspaceId: ws, widgetId: wid };
}

/** Identity verification is on and anonymous visitors are refused (needs a secret to mean anything). */
export function requiresIdentity(config: { identitySecret: string | null; identityRequired: boolean }): boolean {
  return Boolean(config.identitySecret) && config.identityRequired;
}

export interface VerifiedIdentity {
  externalId: string;
  email: string | null;
  name: string | null;
}

export type IdentityFailure = JwtFailure | 'claims';

/** Longest a customer may let one identity token live. */
export const IDENTITY_TOKEN_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Check a customer-signed identity token. `sub` and `exp` are required, and
 * `exp` may be at most 30 days out, so a leaked token stops working.
 */
export async function verifyIdentityToken(
  secret: string,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ ok: true; identity: VerifiedIdentity } | { ok: false; reason: IdentityFailure }> {
  const result = await verifyJwt(secret, token, nowSeconds);
  if (!result.ok) return result;
  const { sub, email, name, exp } = result.claims;
  const externalId = typeof sub === 'string' || typeof sub === 'number' ? String(sub).trim() : '';
  if (!externalId || externalId.length > 255) return { ok: false, reason: 'claims' };
  if (typeof exp !== 'number' || exp > nowSeconds + IDENTITY_TOKEN_MAX_TTL_SECONDS) return { ok: false, reason: 'claims' };
  let verifiedEmail: string | null = null;
  if (email !== undefined && email !== null && email !== '') {
    if (typeof email !== 'string' || email.length > 255 || !EMAIL_PATTERN.test(email.trim())) {
      return { ok: false, reason: 'claims' };
    }
    verifiedEmail = email.trim().toLowerCase();
  }
  const displayName = typeof name === 'string' ? name.trim().slice(0, 255) || null : null;
  return { ok: true, identity: { externalId, email: verifiedEmail, name: displayName } };
}
