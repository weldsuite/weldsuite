/**
 * What the Playwright run talks to, on localhost:
 *
 * - port APP: a WeldSuite server (`/config.json`, `/api/workspaces`, the
 *   WeldPass routes the extension calls), a minimal OIDC issuer at `/idp`
 *   (discovery, an authorize endpoint that signs in at once, token, revoke),
 *   and the login pages;
 * - port FRAME: a login page on another origin, framed by `/frame-host`.
 *
 * The API checks the bearer token and `X-Weld-Workspace` like the real one
 * would, and records what the extension asked for.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export const APP_PORT = 4510;
export const FRAME_PORT = 4511;
export const APP = `http://localhost:${APP_PORT}`;
export const FRAME = `http://localhost:${FRAME_PORT}`;
export const ISSUER = `${APP}/idp`;
export const EXTENSION_ID = 'nlmnjlkgeoeklbahlemmlcfnlfgdimnp';
const REDIRECT = `https://${EXTENSION_ID}.chromiumapp.org/`;
const ACCESS = 'access-token-1';

export interface Recorded {
  reveals: string[];
  created: unknown[];
  updated: Array<{ path: string; body: unknown }>;
  matchUrls: string[];
  workspaceHeaders: string[];
}

export interface FakeState {
  /** `evil`: the server answers a login for another site (a bug, or worse). */
  matches: 'normal' | 'evil';
  password: string;
  recorded: Recorded;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

const jwt = (claims: Record<string, unknown>) => `${base64url({ alg: 'none' })}.${base64url(claims)}.sig`;

const LOCAL_ITEM = {
  id: 'item-local',
  vaultId: 'vault-1',
  type: 'login',
  title: 'Local app',
  subtitle: 'ada@example.com',
  url: `${APP}/login`,
  host: 'localhost',
  hasTotp: false,
  passwordChangedAt: null,
  version: 1,
  createdBy: null,
  updatedBy: null,
  createdAt: '2026-11-24T00:00:00Z',
  updatedAt: '2026-11-24T00:00:00Z',
};
const EVIL_ITEM = { ...LOCAL_ITEM, id: 'item-evil', title: 'Evil', url: 'https://evil.example', host: 'evil.example' };

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const LOGIN_FORM = (action: string) => `<!doctype html><html><head><title>Sign in</title></head><body>
  <h1>Sign in</h1>
  <form action="${action}" method="post">
    <label>Email <input name="username" type="email" autocomplete="username"></label>
    <label>Password <input name="password" type="password" autocomplete="current-password"></label>
    <button type="submit">Sign in</button>
  </form>
</body></html>`;

function appRoutes(state: FakeState) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', APP);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // ── pages ──
    if (path === '/login') return send(res, 200, LOGIN_FORM('/welcome'), 'text/html');
    if (path === '/welcome') {
      await readBody(req);
      return send(res, 200, '<!doctype html><title>Welcome</title><h1>Welcome back</h1>', 'text/html');
    }
    if (path === '/frame-host') {
      return send(
        res,
        200,
        `<!doctype html><title>Shop</title><h1>Checkout</h1>
         <iframe src="${FRAME}/login" title="Sign in" style="width:520px;height:420px;border:1px solid #ccc"></iframe>`,
        'text/html',
      );
    }

    // ── /config.json ──
    if (path === '/config.json') {
      return send(res, 200, {
        backend: 'rust',
        edition: 'self-hosted',
        modules: ['pass'],
        auth: {
          provider: 'oidc',
          issuer: ISSUER,
          clientId: 'weldsuite-web',
          extensionClientId: 'weldsuite-extension',
          audience: 'weldsuite-api',
          orgClaim: null,
          scopes: ['openid', 'profile', 'email', 'offline_access'],
          audienceScope: null,
          organizationScope: null,
          workspaceSource: 'header',
          identityProvider: 'weldid',
        },
      });
    }

    // ── the issuer ──
    if (path === '/idp/.well-known/openid-configuration') {
      return send(res, 200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        revocation_endpoint: `${ISSUER}/revoke`,
      });
    }
    if (path === '/idp/authorize') {
      // The redirect must be exactly the registered one, as WeldID checks.
      if (url.searchParams.get('redirect_uri') !== REDIRECT || url.searchParams.get('client_id') !== 'weldsuite-extension') {
        return send(res, 400, 'bad redirect_uri or client_id', 'text/plain');
      }
      const target = new URL(REDIRECT);
      target.searchParams.set('code', 'code-1');
      target.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: target.href });
      return res.end();
    }
    if (path === '/idp/token' && method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      if (params.get('client_id') !== 'weldsuite-extension') return send(res, 400, { error: 'invalid_client' });
      return send(res, 200, {
        access_token: ACCESS,
        refresh_token: 'refresh-1',
        expires_in: 3600,
        id_token: jwt({ sub: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com' }),
      });
    }
    if (path === '/idp/revoke') return send(res, 200, {});

    // ── the API ──
    if (path.startsWith('/api/')) {
      if (req.headers.authorization !== `Bearer ${ACCESS}`) return send(res, 401, { error: { code: 'UNAUTHORIZED' } });
      if (path === '/api/workspaces') return send(res, 200, { data: [{ id: 'ws_1', name: 'Acme', slug: 'acme' }] });
      state.recorded.workspaceHeaders.push(String(req.headers['x-weld-workspace'] ?? ''));
      if (req.headers['x-weld-workspace'] !== 'ws_1') return send(res, 403, { error: { code: 'ORG_REQUIRED' } });

      if (path === '/api/weldpass/items/match') {
        state.recorded.matchUrls.push(url.searchParams.get('url') ?? '');
        return send(res, 200, { data: state.matches === 'evil' ? [EVIL_ITEM] : [LOCAL_ITEM] });
      }
      if (path === '/api/weldpass/items') return send(res, 200, { data: [LOCAL_ITEM] });
      if (path === '/api/weldpass/vaults') {
        return send(res, 200, { data: [{ id: 'vault-1', kind: 'personal', name: 'Personal', role: 'manager' }] });
      }
      const reveal = /^\/api\/weldpass\/vaults\/([^/]+)\/items\/([^/]+)\/reveal$/.exec(path);
      if (reveal) {
        state.recorded.reveals.push(reveal[2]!);
        const item = reveal[2] === EVIL_ITEM.id ? EVIL_ITEM : LOCAL_ITEM;
        return send(res, 200, {
          data: { ...item, fields: { username: 'ada@example.com', password: state.password, totp: '', notes: '' } },
        });
      }
      if (path === '/api/weldpass/vaults/vault-1/items' && method === 'POST') {
        state.recorded.created.push(JSON.parse(await readBody(req)));
        return send(res, 201, { data: { ...LOCAL_ITEM, id: 'item-new' } });
      }
      if (path.startsWith('/api/weldpass/vaults/vault-1/items/') && method === 'PUT') {
        state.recorded.updated.push({ path, body: JSON.parse(await readBody(req)) });
        return send(res, 200, { data: LOCAL_ITEM });
      }
      return send(res, 404, { error: { code: 'NOT_FOUND' } });
    }
    return send(res, 404, 'not found', 'text/plain');
  };
}

function frameRoutes() {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', FRAME);
    if (url.pathname === '/login') return send(res, 200, LOGIN_FORM('/done'), 'text/html');
    return send(res, 200, '<!doctype html><title>Done</title>', 'text/html');
  };
}

export function freshState(): FakeState {
  return {
    matches: 'normal',
    password: 'correct horse battery',
    recorded: { reveals: [], created: [], updated: [], matchUrls: [], workspaceHeaders: [] },
  };
}

export async function startFakeServers(state: FakeState): Promise<() => Promise<void>> {
  const servers: Server[] = [
    createServer((req, res) => void appRoutes(state)(req, res)),
    createServer(frameRoutes()),
  ];
  await Promise.all(
    servers.map(
      (server, index) =>
        new Promise<void>((resolve) => server.listen(index === 0 ? APP_PORT : FRAME_PORT, 'localhost', resolve)),
    ),
  );
  return async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  };
}
