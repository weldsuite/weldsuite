/**
 * Respondent sessions and verification tokens (weldsuite-documentation/plans/weldforms.md,
 * "Respondent sessions").
 *
 * A session token is HMAC-signed with `FORMS_SESSION_SECRET` and bound to the
 * workspace, the form, the version, a pre-generated response id, the respondent
 * mode and, when known, the invitation or verified email. Valid 7 days, so a
 * respondent can come back to an unfinished form. It can only write this one
 * response. The response row itself is created on the first saved progress, so
 * what the respondent arrived with (hidden fields, metadata, the hashed IP)
 * waits in a cache entry, the "seed", until then. A bounce writes nothing to the
 * tenant database.
 */

import { FORM_LIMITS, type FormRespondentMode, type SessionMetadata } from '@weldsuite/app-api-client/schemas/weldforms';
import { hmacHex, signToken, verifyToken } from '../lib/crypto';
import { FormsError } from '../lib/errors';
import type { Env } from '../types';

export interface RespondentSession {
  exp: number;
  /** Clerk org id of the workspace (opens the tenant DB). */
  org: string;
  /** `workspaces.id`. */
  ws: string;
  form: string;
  pub: string;
  ver: string;
  resp: string;
  mode: FormRespondentMode;
  /** Verified email (code or invitation). */
  email?: string;
  inv?: string;
}

interface VerificationToken {
  exp: number;
  typ: 'verify';
  form: string;
  email: string;
}

/** The secret must exist before any session work; without it the public routes answer 503. */
export function sessionSecret(env: Pick<Env, 'FORMS_SESSION_SECRET'>): string {
  if (!env.FORMS_SESSION_SECRET) throw new FormsError(503, 'SERVICE_UNAVAILABLE', 'Forms are not configured on this deployment.');
  return env.FORMS_SESSION_SECRET;
}

export async function issueSession(env: Env, session: Omit<RespondentSession, 'exp'>, now = Date.now()): Promise<{ token: string; expiresAt: Date }> {
  const exp = now + FORM_LIMITS.sessionTtlSeconds * 1000;
  return { token: await signToken(sessionSecret(env), { ...session, exp }), expiresAt: new Date(exp) };
}

export async function readSession(env: Env, token: string | null | undefined, now = Date.now()): Promise<RespondentSession | null> {
  if (!token) return null;
  const session = await verifyToken<RespondentSession>(sessionSecret(env), token, now);
  return session && session.org && session.form && session.resp && session.ver ? session : null;
}

/** The session in `Authorization: Bearer <token>`; 401 `UNAUTHORIZED` when it is missing, forged or expired. */
export async function requireSession(env: Env, authorization: string | undefined): Promise<RespondentSession> {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
  const session = await readSession(env, token);
  if (!session) throw new FormsError(401, 'UNAUTHORIZED', 'Your session has expired. Open the form again.');
  return session;
}

// ---------------------------------------------------------------------------
// Verification tokens (the result of /verify)
// ---------------------------------------------------------------------------

export const VERIFICATION_TTL_SECONDS = 30 * 60;

export function issueVerification(env: Env, formId: string, email: string, now = Date.now()): Promise<string> {
  return signToken(sessionSecret(env), { typ: 'verify', form: formId, email, exp: now + VERIFICATION_TTL_SECONDS * 1000 });
}

/** The verified email in a token made for this form, or null. */
export async function readVerification(env: Env, token: string | undefined, formId: string, now = Date.now()): Promise<string | null> {
  if (!token) return null;
  const payload = await verifyToken<VerificationToken>(sessionSecret(env), token, now);
  return payload && payload.typ === 'verify' && payload.form === formId ? payload.email : null;
}

// ---------------------------------------------------------------------------
// Seeds: what a session arrived with, until its response row exists
// ---------------------------------------------------------------------------

export interface SessionSeed {
  hidden: Record<string, string>;
  metadata: SessionMetadata & { country?: string };
  ipHash: string | null;
  /** Hash of the browser key, for the soft one-per-browser limit. */
  browserHash: string | null;
  startedAt: number;
}

const seedKey = (responseId: string) => `forms:seed:${responseId}`;

export async function saveSeed(kv: KVNamespace, responseId: string, seed: SessionSeed): Promise<void> {
  await kv.put(seedKey(responseId), JSON.stringify(seed), { expirationTtl: FORM_LIMITS.sessionTtlSeconds });
}

export async function readSeed(kv: KVNamespace, responseId: string): Promise<SessionSeed | null> {
  const raw = await kv.get(seedKey(responseId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionSeed;
  } catch {
    return null;
  }
}

export async function dropSeed(kv: KVNamespace, responseId: string): Promise<void> {
  await kv.delete(seedKey(responseId));
}

// ---------------------------------------------------------------------------
// Keyed hashes (never stored raw)
// ---------------------------------------------------------------------------

/** A keyed hash of something personal (IP, browser key, member id), tied to a purpose. */
export function keyedHash(env: Env, purpose: string, value: string): Promise<string> {
  return hmacHex(sessionSecret(env), `${purpose}:${value}`);
}
