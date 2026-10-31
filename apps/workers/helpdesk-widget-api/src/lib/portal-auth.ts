/**
 * Help-center sign-in: email codes and sessions, in KV.
 *
 * Same scheme as the commerce portal (@weldsuite/commerce-domain/portal-tokens,
 * whose generic pieces are reused): a 6-digit code per (workspace, email),
 * stored hashed for 15 minutes and dropped after 8 wrong guesses; a session
 * token, stored hashed for 30 days. The atomic counters behind the rate
 * limits are this worker's own PortalRateLimiter Durable Object.
 *
 * Nobody needs an invitation: anyone may sign in with an address they can
 * read mail for. A new address simply has no requests yet.
 */

import {
  consumeRateLimit,
  kvDelete,
  kvGetJson,
  kvPutJson,
  randomOtp,
  randomToken,
  releaseRateLimit,
  sha256Hex,
  type RateLimitOutcome,
} from '@weldsuite/commerce-domain/portal-tokens';
import type { Env } from '../index';

export const CODE_TTL_SECONDS = 15 * 60;
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Wrong codes one challenge survives. */
export const MAX_CODE_ATTEMPTS = 8;
/** Code emails per address per 15 minutes, and per workspace across addresses. */
export const REQUEST_LIMIT_EMAIL = 5;
export const REQUEST_LIMIT_WORKSPACE = 300;
/**
 * Failed code checks per 15 minutes: per address, and per workspace. A slot is
 * taken before checking and given back on success, so only failures count
 * and parallel guesses cannot all slip past.
 */
export const VERIFY_LIMIT_EMAIL = 10;
export const VERIFY_LIMIT_WORKSPACE = 300;
const LIMIT_WINDOW_SECONDS = 15 * 60;

export interface PortalChallenge {
  codeHash: string;
  email: string;
  workspaceId: string;
  attempts: number;
}

export interface PortalSession {
  workspaceId: string;
  visitorId: string;
  email: string;
  expiresAt: string;
}

const challengeKey = (workspaceId: string, email: string) => `dportal:code:${workspaceId}:${email}`;
const sessionKey = (tokenHash: string) => `dportal:sess:${tokenHash}`;

/** Count one hit against a limit of this workspace. `unavailable` means the counter could not be reached. */
export function hitLimit(env: Env, workspaceId: string, key: string, max: number): Promise<RateLimitOutcome> {
  return consumeRateLimit(env, workspaceId, `desk:${key}`, max, LIMIT_WINDOW_SECONDS);
}

export function releaseLimit(env: Env, workspaceId: string, key: string): Promise<void> {
  return releaseRateLimit(env, workspaceId, `desk:${key}`);
}

/** A new code for this address; replaces any earlier one. Returns the plain code for the email. */
export async function issueChallenge(env: Env, workspaceId: string, email: string): Promise<string> {
  const code = randomOtp();
  const challenge: PortalChallenge = { codeHash: await sha256Hex(code), email, workspaceId, attempts: 0 };
  await kvPutJson(env, challengeKey(workspaceId, email), challenge, CODE_TTL_SECONDS);
  return code;
}

export type CodeCheck = 'ok' | 'wrong' | 'expired';

/** Check a code. A right code consumes the challenge; the last wrong one drops it. */
export async function checkChallenge(env: Env, workspaceId: string, email: string, code: string): Promise<CodeCheck> {
  const key = challengeKey(workspaceId, email);
  const challenge = await kvGetJson<PortalChallenge>(env, key);
  if (!challenge || challenge.workspaceId !== workspaceId || challenge.attempts >= MAX_CODE_ATTEMPTS) return 'expired';
  if ((await sha256Hex(code)) === challenge.codeHash) {
    await kvDelete(env, key);
    return 'ok';
  }
  const attempts = challenge.attempts + 1;
  if (attempts >= MAX_CODE_ATTEMPTS) await kvDelete(env, key);
  else await kvPutJson(env, key, { ...challenge, attempts }, CODE_TTL_SECONDS);
  return 'wrong';
}

export async function createSession(
  env: Env,
  session: Omit<PortalSession, 'expiresAt'>,
): Promise<{ token: string; session: PortalSession }> {
  const token = randomToken();
  const full: PortalSession = { ...session, expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString() };
  await kvPutJson(env, sessionKey(await sha256Hex(token)), full, SESSION_TTL_SECONDS);
  return { token, session: full };
}

/** The session a token names, if it is live and for this workspace. */
export async function readSession(env: Env, workspaceId: string, token: string): Promise<PortalSession | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const session = await kvGetJson<PortalSession>(env, sessionKey(await sha256Hex(token)));
  if (!session || session.workspaceId !== workspaceId) return null;
  if (Date.parse(session.expiresAt) <= Date.now()) return null;
  return session;
}

export async function endSession(env: Env, token: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(token)) return;
  await kvDelete(env, sessionKey(await sha256Hex(token)));
}
