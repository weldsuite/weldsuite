/**
 * Session tokens for the first-party API, per target.
 *
 * Global (Clerk). The module workers accept a Clerk session JWT that carries
 * an org claim (packages/core/worker-kit/src/middleware/clerk.ts). Those JWTs
 * live 60s by default, so we mint them from an existing browser session
 * through the Clerk Backend API (`POST /v1/sessions/{id}/tokens`) with the
 * instance's secret key, asking for a longer lifetime, and re-mint when one
 * runs low.
 *
 *   CLERK_SECRET_KEY   secret key of the Clerk instance the test env uses
 *   CLERK_SESSION_ID   `Clerk.session.id` from a browser signed in to the
 *                      test workspace (that workspace must be the active one)
 *
 * EU (WeldID). The Rust server accepts WeldID access tokens (ES256, audience
 * weldsuite-api, 10 minutes) and reads the workspace from X-Weld-Workspace
 * (config.js, `workspaceHeaders`). WeldID rotates refresh tokens and revokes
 * the whole family when a rotated one is used again, so VUs can't each
 * refresh: `run.mjs` runs a token broker on 127.0.0.1 that holds the refresh
 * token from `pnpm load-test login --target eu` (lib/weldid.mjs), refreshes
 * once for everybody, and hands out the current access token.
 *
 *   TOKEN_BROKER_URL   set by run.mjs: http://127.0.0.1:<port>
 *   TOKEN_BROKER_KEY   set by run.mjs: a per-run secret the broker checks
 *   WELD_WORKSPACE     the test workspace's id (ws_…) or slug; several,
 *                      comma separated, spread the VUs over them
 *
 * Either target: WELD_TOKEN is a ready-made token (only good for short runs:
 * 60s on Clerk, 10 minutes on WeldID).
 */

import http from 'k6/http';
import encoding from 'k6/encoding';
import { sleep } from 'k6';
import { IS_EU, random, WORKSPACES } from './config.js';

const CLERK_API = (__ENV.CLERK_API_URL || 'https://api.clerk.com/v1').replace(/\/$/, '');
const TOKEN_TTL_SECONDS = Number(__ENV.TOKEN_TTL_SECONDS || 3600);
const BROKER_URL = (__ENV.TOKEN_BROKER_URL || '').replace(/\/$/, '');

export function decodeJwt(jwt) {
  const part = String(jwt).split('.')[1];
  if (!part) throw new Error('Not a JWT');
  return JSON.parse(encoding.b64decode(part, 'rawurl', 's'));
}

/** Whether this run has a first-party session at all (cleanup falls back to the public API without one). */
export function hasPlatformCredentials() {
  if (__ENV.WELD_TOKEN) return true;
  return IS_EU ? Boolean(BROKER_URL) : Boolean(__ENV.CLERK_SESSION_ID && __ENV.CLERK_SECRET_KEY);
}

/** Whether tokens can be renewed during the run (else WELD_TOKEN is all there is). */
function canRenew() {
  return IS_EU ? Boolean(BROKER_URL) : Boolean(__ENV.CLERK_SESSION_ID);
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

/** The current WeldID access token from run.mjs's broker (lib/weldid.mjs). */
function brokerToken() {
  if (!BROKER_URL) {
    throw new Error('No WeldID session: run `pnpm load-test login --target eu` once, then start the test through `pnpm load-test` (or set WELD_TOKEN).');
  }
  const params = {
    headers: { Authorization: `Bearer ${__ENV.TOKEN_BROKER_KEY}` },
    // No `api` tag: broker calls stay out of the thresholds and the report.
    tags: { name: 'token broker' },
    responseCallback: http.expectedStatuses(200),
    timeout: '60s',
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = http.get(`${BROKER_URL}/token`, params);
    if (res.status === 200) {
      const jwt = res.json('access_token');
      return { jwt, exp: Number(res.json('exp')) || decodeJwt(jwt).exp };
    }
    if (res.status !== 503) {
      throw new Error(`Token broker answered ${res.status}: ${String(res.body).slice(0, 300)}`);
    }
    sleep(attempt + random());
  }
  throw new Error('The token broker could not refresh the WeldID session (see the runner output)');
}

function renew() {
  return IS_EU ? brokerToken() : mintClerkToken();
}

/** Called once from setup(): mint (or take) the shared token and sanity-check it. */
export function initialToken() {
  const token = __ENV.WELD_TOKEN ? { jwt: __ENV.WELD_TOKEN, exp: decodeJwt(__ENV.WELD_TOKEN).exp } : renew();
  const claims = decodeJwt(token.jwt);
  const ttl = token.exp - Math.floor(Date.now() / 1000);

  let workspace;
  if (IS_EU) {
    // Membership mode: the token names no workspace; the header does.
    if (WORKSPACES.length === 0) {
      throw new Error(
        'Set WELD_WORKSPACE to the test workspace (its ws_… id or slug; several comma separated; `pnpm load-test login --target eu` lists them). EU requests name their workspace in X-Weld-Workspace.',
      );
    }
    workspace = WORKSPACES.join(',');
    const client = claims.client_id || claims.azp || '?';
    const which = WORKSPACES.length === 1 ? 'workspace' : String(WORKSPACES.length) + ' workspaces';
    console.log(`Auth: WeldID user ${claims.sub} (client ${client}), ${which} ${workspace} (X-Weld-Workspace), token valid for ${ttl}s`);
  } else {
    workspace = claims.o?.id || claims.org_id;
    if (!workspace) {
      throw new Error(
        'The Clerk session has no active workspace (no org claim). Open the test workspace in the browser, then copy Clerk.session.id again.',
      );
    }
    console.log(`Auth: user ${claims.sub}, workspace ${workspace}, token valid for ${ttl}s`);
  }
  if (ttl < 120 && !canRenew()) {
    console.warn('WELD_TOKEN expires within 2 minutes and there is nothing to renew it with.');
  }
  return { ...token, orgId: workspace };
}

// Per-VU state. Each VU renews a little before expiry, at a random margin so
// hundreds of VUs don't all ask Clerk (or the broker) in the same second.
// The broker itself refreshes earlier than any VU asks (lib/weldid.mjs), so
// one WeldID refresh serves every VU.
let vuToken = null;
let retryRenewAt = 0;
const refreshMargin = 20 + random() * 40;

/** Current bearer token for this VU; `shared` is setup()'s token. */
export function bearerToken(shared) {
  const now = Date.now() / 1000;
  if (vuToken && vuToken.exp - now > refreshMargin) return vuToken.jwt;
  if (shared && shared.exp - now > refreshMargin) return shared.jwt;
  const held = vuToken || shared;
  if (!canRenew()) return held.jwt; // nothing to renew with
  // After a failed renewal, keep going on the token in hand while it lasts
  // and try again 10s later instead of on every request.
  if (now < retryRenewAt && held.exp > now) return held.jwt;
  try {
    vuToken = renew();
  } catch (error) {
    retryRenewAt = now + 10;
    if (held.exp > now) return held.jwt;
    throw error;
  }
  return vuToken.jwt;
}
