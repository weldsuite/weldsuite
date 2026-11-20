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
 * offline_access.
 *
 * The refresh token is kept in `.weldid/<api host>.json` (git-ignored,
 * readable by the owner only). WeldID rotates it on every refresh and
 * revokes the whole family when a rotated one comes back after a 10 second
 * grace, so exactly one process refreshes, and it writes each new refresh
 * token to disk before handing out the access token that came with it. That
 * process is the broker; the VUs never see the refresh token. The sign-in
 * lasts as long as the WeldID session behind it: 7 days without a refresh,
 * 30 days at most, or until someone signs out of it.
 *
 * Nothing here logs a value that came from the environment (.env holds
 * keys and tokens): failures are fixed text per code (`describeFailure`),
 * and what the terminal shows otherwise comes from WeldID or the install.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { trimSlash } from './targets.mjs';

/** Refresh this long before the access token expires: earlier than any VU asks (20 to 60 s, lib/auth.js). */
const REFRESH_EARLY_SECONDS = 120;
/** How long one refresh request may take before it is given up. */
const REFRESH_TIMEOUT_MS = 6000;
/**
 * No retry is sent later than this after the first attempt went out. WeldID
 * may have rotated the token on an attempt whose answer was lost, and accepts
 * the old one again only within its 10 s reuse grace; a retry after that
 * looks like a stolen token and revokes the whole sign-in.
 */
const REFRESH_RETRY_WINDOW_MS = 9000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Text from a server, safe for one terminal line: control characters (CR, LF, ESC, …) become spaces. */
export function printable(value) {
  return String(value ?? '').replace(/\p{Cc}/gu, ' ');
}

/** What the terminal says for each failure: fixed text, never an error's own message. */
const FAILURES = {
  BAD_URL: 'Refused a URL: only https (or http on this machine), no credentials in it, and WeldID endpoints only on the issuer the install names.',
  CONFIG_UNREADABLE: "Could not read the install's /config.json. Is the target right?",
  NOT_OIDC: "The install doesn't sign in through OIDC. Is this the EU install?",
  NOT_HEADER_MODE: "The install takes the workspace from the token; the load test supports WeldID's membership mode (X-Weld-Workspace) only.",
  NO_DESKTOP_CLIENT: "The install's /config.json names no desktop client (OIDC_DESKTOP_CLIENT_ID), which the sign-in uses.",
  DISCOVERY_UNREADABLE: "Could not read WeldID's discovery document (/.well-known/openid-configuration).",
  ISSUER_MISMATCH: "WeldID's discovery document names another issuer than the install's /config.json.",
  SIGN_IN_FAILED: 'The sign-in did not complete. Run `pnpm load-test login --target eu` again.',
  SIGN_IN_TIMEOUT: 'No sign-in within 5 minutes. Run `pnpm load-test login --target eu` again.',
  TOKEN_REFUSED: "WeldID's token endpoint refused the request.",
  NO_REFRESH_TOKEN: 'WeldID sent no refresh token: the desktop client needs the refresh_token grant and the offline_access scope.',
  NO_SIGN_IN: 'No WeldID sign-in for this install yet. Run `pnpm load-test login --target eu` once first.',
  SIGN_IN_ENDED:
    'WeldID refused the stored refresh token: the sign-in ended (signed out, 7 days unused or 30 days old) or the token was used elsewhere. Run `pnpm load-test login --target eu` again.',
};

/** A one-word reason from a server (an OAuth error code), or nothing. */
function reasonWord(value) {
  return typeof value === 'string' && /^[a-z_]{1,64}$/.test(value) ? value : undefined;
}

/** A failure with a fixed message (FAILURES), and what it concerns, an HTTP status or a server's reason. */
export class WeldIdError extends Error {
  constructor(code, { what, status, reason } = {}) {
    super(FAILURES[code]);
    this.name = 'WeldIdError';
    this.code = code;
    this.what = what;
    this.status = status;
    this.oauthError = reasonWord(reason);
  }
}

/**
 * What to print for a failure: the fixed text of a WeldIdError with its
 * details, otherwise only the kind of error (a network or file error's code),
 * never its message: that may carry a URL or a setting.
 */
export function describeFailure(error) {
  if (error instanceof WeldIdError) {
    const details = [error.what, typeof error.status === 'number' ? `HTTP ${error.status}` : undefined, error.oauthError].filter(Boolean);
    const text = FAILURES[error.code];
    return details.length ? `${text} (${details.join(', ')})` : text;
  }
  const kind = [error?.cause?.code, error?.code, error?.name].find((value) => typeof value === 'string' && /^[A-Za-z_]{1,40}$/.test(value));
  return `Stopped on an unexpected error (${kind || 'unknown'}).`;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `value` as a URL this tool may call or open: https, or plain http on this
 * machine only (a local install or a mock), without credentials in it. With
 * `origin`, it must be on that origin as well: WeldID's endpoints must be
 * on the issuer that the install's /config.json names. `what` names it in
 * the failure (a fixed label). Throws a WeldIdError otherwise.
 */
export function checkedUrl(value, origin, what = 'a URL') {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new WeldIdError('BAD_URL', { what });
  }
  const local = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new WeldIdError('BAD_URL', { what });
  if (url.username || url.password) throw new WeldIdError('BAD_URL', { what });
  if (origin && url.origin !== origin) throw new WeldIdError('BAD_URL', { what });
  return url;
}

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
  if (!existsSync(file)) throw new WeldIdError('NO_SIGN_IN');
  return JSON.parse(readFileSync(file, 'utf8'));
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** GET a JSON document; `origin`, when given, is the only origin allowed (checkedUrl). */
async function getJson(url, { origin, what, headers } = {}) {
  const target = checkedUrl(url, origin, what);
  const res = await fetch(target.href, { headers, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  return { res, body: parseJson(text) };
}

/**
 * A call to WeldID's token endpoint, which must be on the issuer's origin;
 * throws a WeldIdError with `status` and `oauthError` set.
 */
async function tokenRequest(endpoint, issuerOrigin, params, timeoutMs = 15000) {
  const target = checkedUrl(endpoint, issuerOrigin, 'the token endpoint');
  const res = await fetch(target.href, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = parseJson(await res.text());
  if (!res.ok || !body?.access_token) throw new WeldIdError('TOKEN_REFUSED', { status: res.status, reason: body?.error });
  return body;
}

/**
 * How the install signs in: `/config.json`'s auth block (the same one the
 * platform reads) and the issuer's discovery document.
 */
export async function discover(apiBase) {
  const base = trimSlash(checkedUrl(apiBase, undefined, 'the API base URL').href);
  const config = await getJson(`${base}/config.json`, { what: 'the API base URL' });
  if (!config.res.ok || !config.body) throw new WeldIdError('CONFIG_UNREADABLE', { status: config.res.status });
  const auth = config.body.auth;
  if (auth?.provider !== 'oidc') throw new WeldIdError('NOT_OIDC');
  if (auth.workspaceSource !== 'header') throw new WeldIdError('NOT_HEADER_MODE');
  if (!auth.desktopClientId) throw new WeldIdError('NO_DESKTOP_CLIENT');
  // The issuer the install names; its endpoints must live on its origin.
  const issuerUrl = checkedUrl(auth.issuer, undefined, 'the issuer');
  const issuer = trimSlash(issuerUrl.href);
  const origin = issuerUrl.origin;
  const discovery = await getJson(`${issuer}/.well-known/openid-configuration`, { origin, what: 'the issuer' });
  const meta = discovery.body;
  if (!discovery.res.ok || !meta?.authorization_endpoint || !meta?.token_endpoint) {
    throw new WeldIdError('DISCOVERY_UNREADABLE', { status: discovery.res.status });
  }
  if (meta.issuer && trimSlash(meta.issuer) !== issuer) throw new WeldIdError('ISSUER_MISMATCH');
  const scopes = new Set(Array.isArray(auth.scopes) && auth.scopes.length ? auth.scopes : ['openid', 'profile', 'email']);
  scopes.add('offline_access'); // the refresh token
  return {
    apiBase: base,
    issuer,
    issuerOrigin: origin,
    clientId: auth.desktopClientId,
    scope: [...scopes].join(' '),
    authorizationEndpoint: checkedUrl(meta.authorization_endpoint, origin, 'the authorization endpoint').href,
    tokenEndpoint: checkedUrl(meta.token_endpoint, origin, 'the token endpoint').href,
    revocationEndpoint: meta.revocation_endpoint ? checkedUrl(meta.revocation_endpoint, origin, 'the revocation endpoint').href : null,
  };
}

/** The loopback redirect: resolves with the code once the browser comes back. */
function listenForCallback(expectedState, issuer) {
  let settle;
  const code = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The pages are fixed text: nothing from the request goes into them. Why a
  // sign-in failed is told in the terminal (the rejected error).
  const page = (title, text) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;margin:3rem"><h1>${title}</h1><p>${text}</p></body>`;
  const FAILED_PAGE = page('Sign-in failed', 'The load test did not get a session. The terminal says why.');
  const SIGNED_IN_PAGE = page(
    'Signed in',
    "The load test has its session. Close this window, but don't sign out: that ends the test's session too.",
  );
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const params = url.searchParams;
    const fail = (what, reason) => {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(FAILED_PAGE);
      settle.reject(new WeldIdError('SIGN_IN_FAILED', { what, reason }));
    };
    if (params.get('state') !== expectedState) return fail('the answer belongs to another sign-in');
    // RFC 9207: the issuer that answered, when it says.
    if (params.get('iss') && trimSlash(params.get('iss')) !== trimSlash(issuer)) return fail('another issuer answered');
    if (params.get('error')) return fail('WeldID answered with an error', params.get('error'));
    if (!params.get('code')) return fail('WeldID sent no code');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(SIGNED_IN_PAGE);
    settle.resolve(params.get('code'));
  });
  const timer = setTimeout(() => settle.reject(new WeldIdError('SIGN_IN_TIMEOUT')), LOGIN_TIMEOUT_MS);
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

/**
 * Open the sign-in page. Only an https (or local) page on the issuer's
 * origin, handed to the system's opener as one argument, never through a
 * shell.
 */
function openInBrowser(url, issuerOrigin) {
  const target = checkedUrl(url, issuerOrigin, 'the sign-in page').href;
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', target]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [target]];
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
export async function login({ apiBase, file, openBrowser = true, log = console.log }) {
  const oidc = await discover(apiBase);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  const callback = await listenForCallback(state, oidc.issuer);
  const redirectUri = `http://127.0.0.1:${callback.port}/callback`;

  // Everything in the link comes from the install and WeldID, or is made here.
  const authorize = checkedUrl(oidc.authorizationEndpoint, oidc.issuerOrigin, 'the authorization endpoint');
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
  }).toString();

  log(`Signing in to WeldID at ${printable(new URL(oidc.issuer).host)} (client ${printable(oidc.clientId)}).`);
  log('Sign in as the TEST MEMBER, not as yourself. A private window is easiest. Open this link if no browser opens:\n');
  log(`  ${printable(authorize.href)}\n`);
  if (openBrowser) openInBrowser(authorize.href, oidc.issuerOrigin);

  let code;
  try {
    code = await callback.code;
  } finally {
    callback.close();
  }
  const tokens = await tokenRequest(oidc.tokenEndpoint, oidc.issuerOrigin, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    client_id: oidc.clientId,
  });
  if (!tokens.refresh_token) throw new WeldIdError('NO_REFRESH_TOKEN');
  const claims = { ...decodeJwtPayload(tokens.id_token), ...decodeJwtPayload(tokens.access_token) };
  saveSession(file, {
    version: 1,
    apiBase: oidc.apiBase,
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

  const list = await getJson(`${oidc.apiBase}/api/workspaces`, {
    what: 'the API base URL',
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
  });
  const workspaces = list.res.ok && Array.isArray(list.body?.data) ? list.body.data : null;
  return { subject: claims.sub, email: claims.email, workspaces, workspacesStatus: list.res.status };
}

/** Revoke the stored refresh token at WeldID and forget it. */
export async function logout({ file, log = console.log }) {
  if (!existsSync(file)) {
    log('No stored WeldID sign-in for this install.');
    return;
  }
  const session = loadSession(file);
  if (session.revocationEndpoint) {
    try {
      const issuerOrigin = checkedUrl(session.issuer, undefined, 'the issuer').origin;
      const endpoint = checkedUrl(session.revocationEndpoint, issuerOrigin, 'the revocation endpoint');
      const res = await fetch(endpoint.href, {
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
      log(`Could not revoke the token at WeldID (${describeFailure(error)}); forgetting it anyway.`);
    }
  }
  rmSync(file);
  log('Removed the stored sign-in.');
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
  // The token endpoint must be on the issuer the sign-in was made with.
  const issuerOrigin = checkedUrl(session.issuer, undefined, 'the issuer').origin;
  const key = randomBytes(24).toString('base64url');
  let current = null;
  let inflight = null;
  let fatal = null;

  async function refresh() {
    let lastError;
    const firstSentAt = Date.now();
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const tokens = await tokenRequest(
          session.tokenEndpoint,
          issuerOrigin,
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
        // Never send the same refresh token outside WeldID's reuse grace.
        if (Date.now() + 1000 * attempt - firstSentAt > REFRESH_RETRY_WINDOW_MS) break;
        await sleep(1000 * attempt);
      }
    }
    if (lastError.oauthError === 'invalid_grant') {
      fatal = new WeldIdError('SIGN_IN_ENDED');
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
        const failure = describeFailure(error);
        log(`[token broker] ${failure}`);
        res.writeHead(fatal ? 502 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: failure }));
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
