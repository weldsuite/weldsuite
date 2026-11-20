/**
 * WeldID sessions for the EU target, on the Node side (run.mjs, not k6):
 * signing the test member in once, and the token broker the k6 VUs ask for
 * access tokens during a run (lib/auth.js).
 *
 * Sign-in is the authorization code flow with PKCE through the system
 * browser and a loopback redirect (RFC 8252), the way the desktop app signs
 * in (apps/desktop/docs/auth-handoff.md). The client is the install's
 * desktop client from `/config.json` (`auth.desktopClientId`;
 * `weldsuite-desktop` on EU): public, allowed to redirect to
 * http://127.0.0.1/callback on any port, with the refresh_token grant and
 * offline_access. WELDID_CLIENT_ID overrides it.
 *
 * The refresh token is kept in `.weldid/<api host>.json` (git-ignored,
 * readable by the owner only). WeldID rotates it on every refresh and
 * revokes the whole family when a rotated one comes back after a 10 second
 * grace, so exactly one process refreshes, and it writes each new refresh
 * token to disk before handing out the access token that came with it. That
 * process is the broker; the VUs never see the refresh token. The sign-in
 * lasts as long as the WeldID session behind it: 7 days without a refresh,
 * 30 days at most, or until someone signs out of it.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { trimSlash } from './targets.mjs';

/** Refresh this long before the access token expires: earlier than any VU asks (20 to 60 s, lib/auth.js). */
const REFRESH_EARLY_SECONDS = 120;
/** Under WeldID's 10 s refresh reuse grace, so a retried refresh never looks like a stolen token. */
const REFRESH_TIMEOUT_MS = 6000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function decodeJwtPayload(jwt) {
  const part = String(jwt || '').split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/** Where the sign-in for an install is kept: `<dir>/.weldid/<api host>.json`. */
export function sessionFile(dir, apiBase) {
  const host = new URL(apiBase).host.replace(/[^a-z0-9.-]/gi, '_');
  return path.join(dir, '.weldid', `${host}.json`);
}

function saveSession(file, session) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

function loadSession(file) {
  if (!existsSync(file)) {
    throw new Error(`No WeldID sign-in for this install (${file}). Run \`pnpm load-test login --target eu\` once first.`);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { res, body, text };
}

/** A token endpoint call; throws with `status` and `oauthError` set. */
async function tokenRequest(endpoint, params, timeoutMs = 15000) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!res.ok || !body || !body.access_token) {
    const detail = body ? `${body.error || ''} ${body.error_description || ''}`.trim() : text.slice(0, 200);
    const error = new Error(`WeldID's token endpoint answered ${res.status}: ${detail}`);
    error.status = res.status;
    error.oauthError = body && body.error;
    throw error;
  }
  return body;
}

/**
 * How the install signs in: `/config.json`'s auth block (the same one the
 * platform reads) and the issuer's discovery document.
 */
export async function discover(apiBase, env) {
  const config = await getJson(`${apiBase}/config.json`);
  if (!config.res.ok || !config.body) throw new Error(`${apiBase}/config.json answered ${config.res.status}`);
  const auth = config.body.auth;
  if (!auth || auth.provider !== 'oidc') {
    throw new Error(`${apiBase} doesn't sign in through OIDC (auth.provider: ${auth ? auth.provider : 'none'}). Is this the EU install?`);
  }
  if (auth.workspaceSource !== 'header') {
    throw new Error(
      `${apiBase} takes the workspace from the token (workspaceSource "${auth.workspaceSource}"); the load test supports WeldID's membership mode, where requests name it in X-Weld-Workspace.`,
    );
  }
  const clientId = env.WELDID_CLIENT_ID || auth.desktopClientId;
  if (!clientId) {
    throw new Error(
      `${apiBase}/config.json names no desktop client (OIDC_DESKTOP_CLIENT_ID). Set WELDID_CLIENT_ID to a public client with the refresh_token grant and the redirect http://127.0.0.1/callback.`,
    );
  }
  const issuer = trimSlash(auth.issuer);
  const discovery = await getJson(`${issuer}/.well-known/openid-configuration`);
  const meta = discovery.body;
  if (!discovery.res.ok || !meta || !meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error(`${issuer}/.well-known/openid-configuration answered ${discovery.res.status} without the endpoints`);
  }
  const scopes = new Set(Array.isArray(auth.scopes) && auth.scopes.length ? auth.scopes : ['openid', 'profile', 'email']);
  scopes.add('offline_access'); // the refresh token
  return {
    apiBase,
    issuer: meta.issuer || issuer,
    clientId,
    scope: [...scopes].join(' '),
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    revocationEndpoint: meta.revocation_endpoint || null,
  };
}

/** The loopback redirect: resolves with the code once the browser comes back. */
function listenForCallback(expectedState, issuer) {
  let settle;
  const code = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  const page = (title, text) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;margin:3rem"><h1>${title}</h1><p>${text}</p></body>`;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const params = url.searchParams;
    const fail = (message) => {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Sign-in failed', message));
      settle.reject(new Error(message));
    };
    if (params.get('state') !== expectedState) return fail('The answer does not belong to this sign-in (state mismatch). Run login again.');
    // RFC 9207: the issuer that answered, when it says.
    if (params.get('iss') && trimSlash(params.get('iss')) !== trimSlash(issuer)) {
      return fail(`The answer came from ${params.get('iss')}, not ${issuer}.`);
    }
    if (params.get('error')) return fail(`WeldID said ${params.get('error')}: ${params.get('error_description') || ''}`);
    if (!params.get('code')) return fail('WeldID sent no code.');
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(page('Signed in', 'The load test has its session. Close this window, but don\'t sign out: that ends the test\'s session too.'));
    settle.resolve(params.get('code'));
  });
  const timer = setTimeout(() => settle.reject(new Error('No sign-in within 5 minutes.')), LOGIN_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        code,
        close: () => {
          clearTimeout(timer);
          server.closeAllConnections();
          server.close();
        },
      }),
    );
  });
}

function openInBrowser(url) {
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The link is printed as well.
  }
}

/**
 * Sign the test member in and keep the refresh token. Returns who signed in
 * and the workspaces they can use (`GET /api/workspaces`, which in
 * membership mode needs no workspace and names each by `workspaces.id`).
 */
export async function login({ apiBase, file, env, openBrowser = true, log = console.log }) {
  const oidc = await discover(apiBase, env);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  const callback = await listenForCallback(state, oidc.issuer);
  const redirectUri = `http://127.0.0.1:${callback.port}/callback`;

  const authorize = new URL(oidc.authorizationEndpoint);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: oidc.clientId,
    redirect_uri: redirectUri,
    scope: oidc.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Always show the sign-in screen, so a browser signed in as someone
    // else doesn't hand over their session.
    prompt: 'login',
    ...(env.WELD_TEST_EMAIL ? { login_hint: env.WELD_TEST_EMAIL } : {}),
  }).toString();

  log(`Signing in to ${oidc.issuer} for ${apiBase} (client ${oidc.clientId}).`);
  log('Sign in as the TEST MEMBER, not as yourself. A private window is easiest. Open this link if no browser opens:\n');
  log(`  ${authorize}\n`);
  if (openBrowser) openInBrowser(authorize.toString());

  let code;
  try {
    code = await callback.code;
  } finally {
    callback.close();
  }
  const tokens = await tokenRequest(oidc.tokenEndpoint, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    client_id: oidc.clientId,
  });
  if (!tokens.refresh_token) {
    throw new Error(`WeldID sent no refresh token: client ${oidc.clientId} needs the refresh_token grant and the offline_access scope.`);
  }
  const claims = { ...decodeJwtPayload(tokens.id_token), ...decodeJwtPayload(tokens.access_token) };
  saveSession(file, {
    version: 1,
    apiBase,
    issuer: oidc.issuer,
    clientId: oidc.clientId,
    tokenEndpoint: oidc.tokenEndpoint,
    revocationEndpoint: oidc.revocationEndpoint,
    scope: tokens.scope || oidc.scope,
    subject: claims.sub,
    email: claims.email || null,
    refreshToken: tokens.refresh_token,
    savedAt: new Date().toISOString(),
  });

  const list = await getJson(`${apiBase}/api/workspaces`, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
  });
  const workspaces = list.res.ok && list.body && Array.isArray(list.body.data) ? list.body.data : null;
  return { subject: claims.sub, email: claims.email, workspaces, workspacesStatus: list.res.status };
}

/** Revoke the stored refresh token at WeldID and forget it. */
export async function logout({ file, log = console.log }) {
  if (!existsSync(file)) {
    log(`No stored WeldID sign-in (${file}).`);
    return;
  }
  const session = loadSession(file);
  if (session.revocationEndpoint) {
    try {
      const res = await fetch(session.revocationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: session.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: session.clientId,
        }).toString(),
        signal: AbortSignal.timeout(15000),
      });
      log(res.ok ? 'Refresh token revoked at WeldID.' : `WeldID's revocation answered ${res.status}; forgetting the token anyway.`);
    } catch (error) {
      log(`Could not reach WeldID (${error.message}); forgetting the token anyway.`);
    }
  }
  rmSync(file);
  log(`Removed ${file}.`);
}

/**
 * The token broker: an HTTP server on 127.0.0.1 that answers
 * `GET /token` (with `Authorization: Bearer <key>`) with
 * `{ access_token, exp }`, refreshing at WeldID once for every VU. It
 * refreshes once before it returns, so a dead sign-in stops the run before
 * k6 starts.
 */
export async function startTokenBroker({ file, log = console.log }) {
  const session = loadSession(file);
  const key = randomBytes(24).toString('base64url');
  let current = null;
  let inflight = null;
  let fatal = null;

  async function refresh() {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const tokens = await tokenRequest(
          session.tokenEndpoint,
          { grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: session.clientId },
          REFRESH_TIMEOUT_MS,
        );
        // The old refresh token is spent: keep the new one before anything else.
        if (tokens.refresh_token) {
          session.refreshToken = tokens.refresh_token;
          session.savedAt = new Date().toISOString();
          saveSession(file, session);
        }
        const exp = decodeJwtPayload(tokens.access_token).exp || nowSeconds() + Number(tokens.expires_in || 0);
        current = { accessToken: tokens.access_token, exp };
        log(`[token broker] WeldID access token refreshed, valid for ${exp - nowSeconds()}s`);
        return current;
      } catch (error) {
        lastError = error;
        // A refused grant or client won't get better by asking again.
        if (error.status && error.status < 500 && error.status !== 429) break;
        await sleep(1000 * attempt);
      }
    }
    if (lastError.oauthError === 'invalid_grant') {
      fatal = new Error(
        'WeldID refused the stored refresh token: the sign-in ended (signed out, 7 days unused or 30 days old) or the token was used elsewhere. Run `pnpm load-test login --target eu` again.',
      );
      throw fatal;
    }
    if (lastError.status && lastError.status < 500 && lastError.status !== 429) fatal = lastError;
    throw lastError;
  }

  function token() {
    if (fatal) return Promise.reject(fatal);
    if (current && current.exp - nowSeconds() > REFRESH_EARLY_SECONDS) return Promise.resolve(current);
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  await token();

  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/token' || req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(404).end();
      return;
    }
    token().then(
      (t) => {
        res
          .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          .end(JSON.stringify({ access_token: t.accessToken, exp: t.exp }));
      },
      (error) => {
        log(`[token broker] ${error.message}`);
        res.writeHead(fatal ? 502 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
      },
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    key,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
