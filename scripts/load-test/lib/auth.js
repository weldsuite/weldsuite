/**
 * Clerk session tokens for the first-party API.
 *
 * The module workers accept a Clerk session JWT that carries an org claim
 * (packages/core/worker-kit/src/middleware/clerk.ts). Those JWTs live 60s
 * by default, so we mint them from an existing browser session through the
 * Clerk Backend API (`POST /v1/sessions/{id}/tokens`) with the instance's
 * secret key, asking for a longer lifetime, and re-mint when one runs low.
 *
 * Inputs (scripts/load-test/.env):
 *   CLERK_SECRET_KEY   secret key of the Clerk instance the test env uses
 *   CLERK_SESSION_ID   `Clerk.session.id` from a browser signed in to the
 *                      test workspace (that workspace must be the active one)
 *   WELD_TOKEN         alternative: a ready-made JWT (only good for ~60s runs)
 */

import http from 'k6/http';
import encoding from 'k6/encoding';
import { sleep } from 'k6';
import { random } from './config.js';

const CLERK_API = (__ENV.CLERK_API_URL || 'https://api.clerk.com/v1').replace(/\/$/, '');
const TOKEN_TTL_SECONDS = Number(__ENV.TOKEN_TTL_SECONDS || 3600);

export function decodeJwt(jwt) {
  const part = String(jwt).split('.')[1];
  if (!part) throw new Error('Not a JWT');
  return JSON.parse(encoding.b64decode(part, 'rawurl', 's'));
}

function mintClerkToken() {
  const sessionId = __ENV.CLERK_SESSION_ID;
  const secretKey = __ENV.CLERK_SECRET_KEY;
  if (!sessionId || !secretKey) {
    throw new Error('Set CLERK_SECRET_KEY and CLERK_SESSION_ID (or WELD_TOKEN) in scripts/load-test/.env');
  }
  const url = `${CLERK_API}/sessions/${sessionId}/tokens`;
  const params = {
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
    // No `api` tag: Clerk calls stay out of the thresholds and the report.
    tags: { name: 'clerk token' },
    responseCallback: http.expectedStatuses(200),
  };

  for (let attempt = 1; attempt <= 4; attempt++) {
    let res = http.post(url, JSON.stringify({ expires_in_seconds: TOKEN_TTL_SECONDS }), params);
    // Instances that don't accept a custom lifetime: fall back to the default 60s token.
    if (res.status === 400 || res.status === 422) res = http.post(url, null, params);
    if (res.status === 200) {
      const jwt = res.json('jwt');
      return { jwt, exp: decodeJwt(jwt).exp };
    }
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`Clerk refused to mint a token (${res.status}): ${String(res.body).slice(0, 300)}`);
    }
    sleep(attempt + random());
  }
  throw new Error('Clerk token mint kept failing (rate limited or down)');
}

/** Called once from setup(): mint (or take) the shared token and sanity-check it. */
export function initialToken() {
  const token = __ENV.WELD_TOKEN ? { jwt: __ENV.WELD_TOKEN, exp: decodeJwt(__ENV.WELD_TOKEN).exp } : mintClerkToken();
  const claims = decodeJwt(token.jwt);
  const orgId = (claims.o && claims.o.id) || claims.org_id;
  if (!orgId) {
    throw new Error(
      'The Clerk session has no active workspace (no org claim). Open the test workspace in the browser, then copy Clerk.session.id again.',
    );
  }
  const ttl = token.exp - Math.floor(Date.now() / 1000);
  console.log(`Auth: user ${claims.sub}, workspace ${orgId}, token valid for ${ttl}s`);
  if (ttl < 120 && !__ENV.CLERK_SESSION_ID) {
    console.warn('WELD_TOKEN expires within 2 minutes and there is no CLERK_SESSION_ID to renew it.');
  }
  return { ...token, orgId };
}

// Per-VU state. Each VU re-mints a little before expiry, at a random margin
// so hundreds of VUs don't all call Clerk in the same second.
let vuToken = null;
const refreshMargin = 20 + random() * 40;

/** Current bearer token for this VU; `shared` is setup()'s token. */
export function bearerToken(shared) {
  const now = Date.now() / 1000;
  if (vuToken && vuToken.exp - now > refreshMargin) return vuToken.jwt;
  if (shared && shared.exp - now > refreshMargin) return shared.jwt;
  if (!__ENV.CLERK_SESSION_ID) return (vuToken || shared).jwt; // nothing to renew with
  vuToken = mintClerkToken();
  return vuToken.jwt;
}
