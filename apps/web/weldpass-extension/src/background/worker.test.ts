import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameCommand } from '../lib/protocol';
import type { SenderKind } from './senders';
import type { MemoryStore } from './save-queue';
import { WeldPassWorker, type WorkerEnv } from './worker';

const ORIGIN = 'https://app.weldsuite.eu';
const ISSUER = 'https://auth.weldsuite.eu';
const STORAGE_ID = 'ext.app.weldsuite.eu';
const NOW = 1_800_000_000_000;

type Content = Extract<SenderKind, { kind: 'content' }>;
const frame: Content = {
  kind: 'content',
  tabId: 5,
  frameId: 3,
  documentId: 'doc-1',
  url: 'https://login.example.com/signin?next=%2F',
};
const top: Content = { ...frame, frameId: 0, documentId: 'doc-top' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ITEMS = {
  good: {
    id: 'item-good',
    vaultId: 'vault-1',
    type: 'login',
    title: 'Example',
    subtitle: 'ada@example.com',
    url: 'https://login.example.com',
    host: 'login.example.com',
    hasTotp: true,
  },
  // A server that answers a login for another site (a bug, or worse): the worker must not fill it.
  evil: {
    id: 'item-evil',
    vaultId: 'vault-1',
    type: 'login',
    title: 'Evil',
    subtitle: 'ada@example.com',
    url: 'https://evil.example',
    host: 'evil.example',
    hasTotp: false,
  },
};

interface Harness {
  worker: WeldPassWorker;
  calls: Array<{ method: string; path: string; body: unknown }>;
  frames: Array<{ tabId: number; command: FrameCommand; target: { frameId: number; documentId?: string } }>;
  memory: Map<string, unknown>;
  local: Map<string, string>;
  revealed: { password: string };
  env: WorkerEnv;
  clock: { now: number };
}

function harness(): Harness {
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const memory = new Map<string, unknown>();
  const calls: Harness['calls'] = [];
  const frames: Harness['frames'] = [];
  const revealed = { password: 'correct horse' };
  const clock = { now: NOW };

  // A signed-in session with one workspace, as the OIDC session stores it.
  local.set(
    `weldsuite.oidc.${STORAGE_ID}`,
    JSON.stringify({ v: 1, sub: 'user-1', active: '*', tokens: { '*': { refresh: 'rt', at: NOW } } }),
  );
  local.set(
    `weldsuite:oidc-profile:${STORAGE_ID}`,
    JSON.stringify({
      sub: 'user-1',
      person: { id: 'user-1', fullName: 'Ada Lovelace', email: 'ada@example.com', firstName: null, lastName: null, username: null, imageUrl: '' },
      organizations: [{ id: 'ws_1', name: 'Acme', slug: null }],
      activeWorkspaceId: 'ws_1',
      directoryAt: NOW,
    }),
  );
  session.set(
    `weldsuite:oidc-access:${STORAGE_ID}`,
    JSON.stringify({ token: 'access.jwt', expiresAt: NOW + 600_000, key: '*', sub: 'user-1' }),
  );

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ method, path: `${url.pathname}${url.search}`, body });
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({
        issuer: url.origin,
        authorization_endpoint: `${url.origin}/oauth/authorize`,
        token_endpoint: `${url.origin}/oauth/token`,
        revocation_endpoint: `${url.origin}/oauth/revoke`,
      });
    }
    if (url.pathname === '/config.json') {
      return json({
        backend: 'rust',
        modules: ['pass'],
        auth: {
          provider: 'oidc',
          issuer: url.origin === ORIGIN ? ISSUER : 'https://auth.weld.example',
          clientId: 'weldsuite-web',
          extensionClientId: 'weldsuite-extension',
          audience: 'weldsuite-api',
          orgClaim: null,
          scopes: ['openid', 'profile', 'email', 'offline_access'],
          audienceScope: null,
          organizationScope: null,
          workspaceSource: 'header',
        },
      });
    }
    if (url.pathname === '/api/workspaces') return json({ data: [{ id: 'ws_1', name: 'Acme', slug: 'acme' }] });
    if (url.pathname === '/api/weldpass/items/match') return json({ data: [ITEMS.good, ITEMS.evil] });
    if (url.pathname === '/api/weldpass/vaults') {
      return json({ data: [{ id: 'vault-1', kind: 'personal', name: 'Personal', role: 'manager' }] });
    }
    const reveal = /^\/api\/weldpass\/vaults\/([^/]+)\/items\/([^/]+)\/reveal$/.exec(url.pathname);
    if (reveal) {
      const item = Object.values(ITEMS).find((entry) => entry.id === reveal[2]);
      return json({
        data: { ...item, fields: { username: 'ada@example.com', password: revealed.password, totp: '', notes: 'keep me' } },
      });
    }
    if (/\/totp$/.test(url.pathname)) return json({ data: { code: '123456', period: 30, expiresAt: new Date(NOW + 20_000).toISOString() } });
    if (url.pathname === '/api/weldpass/vaults/vault-1/items' && method === 'POST') return json({ data: { ...ITEMS.good, id: 'new' } });
    if (url.pathname.startsWith('/api/weldpass/vaults/vault-1/items/') && method === 'PUT') return json({ data: ITEMS.good });
    return json({ error: { code: 'NOT_FOUND' } }, 404);
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);

  const kv = (map: Map<string, string>) => ({
    getItem: async (key: string) => map.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: async (key: string) => {
      map.delete(key);
    },
  });
  const memoryStore: MemoryStore = {
    get: async <T,>(key: string) => memory.get(key) as T | undefined,
    set: async (key, value) => {
      memory.set(key, structuredClone(value));
    },
    remove: async (key) => {
      memory.delete(key);
    },
  };
  let id = 0;
  const env: WorkerEnv = {
    defaultServer: { origin: ORIGIN, issuer: ISSUER },
    fetchImpl,
    local: kv(local),
    secure: {
      getItemAsync: (key) => kv(local).getItem(key),
      setItemAsync: (key, value) => kv(local).setItem(key, value),
      deleteItemAsync: (key) => kv(local).removeItem(key),
    },
    session: kv(session),
    memory: memoryStore,
    memoryKeys: async () => [...memory.keys()],
    launchWebAuthFlow: async () => undefined,
    redirectUri: 'https://nlmnjlkgeoeklbahlemmlcfnlfgdimnp.chromiumapp.org/',
    hasPermission: async () => true,
    removePermission: async () => undefined,
    sendToFrame: async (tabId, command, target) => {
      frames.push({ tabId, command, target });
      return command.type.startsWith('fill:') ? { status: 'filled', fields: 2 } : { status: 'ok' };
    },
    broadcast: () => undefined,
    randomId: () => `nonce-${String((id += 1)).padStart(26, '0')}`,
    now: () => clock.now,
  };
  return { worker: new WeldPassWorker(env), calls, frames, memory, local, revealed, env, clock };
}

const LOGIN_FIELD = { kind: 'login' as const, hasPassword: true, hasUsername: true };
const reveals = (h: Harness) => h.calls.filter((call) => call.path.endsWith('/reveal'));

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the signed-in state', () => {
  it('reads the stored session without a refresh or a sign-in', async () => {
    const state = await h.worker.state();
    expect(state).toMatchObject({
      server: { origin: ORIGIN, label: 'app.weldsuite.eu', problem: null, isDefault: true },
      person: { name: 'Ada Lovelace', email: 'ada@example.com' },
      activeWorkspaceId: 'ws_1',
    });
    expect(h.calls.some((call) => call.path.includes('token'))).toBe(false);
  });

  it('sends the workspace and the client header on every API call', async () => {
    const api = await h.worker.passwords();
    const seen: Array<Record<string, string>> = [];
    vi.mocked(fetch).mockImplementationOnce(async (_input, init) => {
      seen.push(init?.headers as Record<string, string>);
      return json({ data: [] });
    });
    await api.listVaults();
    expect(seen[0]).toMatchObject({ 'X-Weld-Workspace': 'ws_1', 'X-WeldPass-Client': 'extension', Authorization: 'Bearer access.jwt' });
  });
});

describe('inline menus', () => {
  it('lists only the logins the fill policy allows in that frame', async () => {
    const opened = await h.worker.menuOpen(frame, LOGIN_FIELD, 'https://example.com');
    const context = await h.worker.menuInit(frame.tabId, opened!.nonce);
    expect(context).toMatchObject({ kind: 'login', frameOrigin: 'https://login.example.com', crossOrigin: true, blocked: false });
    expect(context?.items.map((item) => item.id)).toEqual(['item-good']);
    // Only the origin was sent for matching, never the path or query.
    expect(h.calls.find((call) => call.path.startsWith('/api/weldpass/items/match'))?.path).toBe(
      '/api/weldpass/items/match?url=https%3A%2F%2Flogin.example.com',
    );
  });

  it('refuses a login for another host without revealing it', async () => {
    const { nonce } = (await h.worker.menuOpen(frame, LOGIN_FIELD, null))!;
    await expect(h.worker.menuFill(frame.tabId, nonce, 'item-evil', 'vault-1')).resolves.toEqual({
      ok: false,
      reason: 'refused',
    });
    expect(reveals(h)).toHaveLength(0);
    expect(h.frames.filter((entry) => entry.command.type.startsWith('fill:'))).toHaveLength(0);
  });

  it('reveals a picked login and sends it to that frame and document only', async () => {
    const { nonce } = (await h.worker.menuOpen(frame, LOGIN_FIELD, null))!;
    await expect(h.worker.menuFill(frame.tabId, nonce, 'item-good', 'vault-1')).resolves.toEqual({ ok: true });
    expect(reveals(h)).toHaveLength(1);
    expect(h.frames[0]).toEqual({
      tabId: 5,
      target: { frameId: 3, documentId: 'doc-1' },
      command: {
        type: 'fill:login',
        nonce,
        expectedOrigin: 'https://login.example.com',
        itemHost: 'login.example.com',
        username: 'ada@example.com',
        password: 'correct horse',
      },
    });
    // The menu closes, and its registration is gone.
    expect(h.frames[1]?.command).toEqual({ type: 'menu:remove', nonce });
    await expect(h.worker.menuFill(frame.tabId, nonce, 'item-good', 'vault-1')).resolves.toMatchObject({ reason: 'expired' });
  });

  it('fills only the username, with no reveal, on the first step of a two-step login', async () => {
    const { nonce } = (await h.worker.menuOpen(frame, { kind: 'login', hasPassword: false, hasUsername: true }, null))!;
    await h.worker.menuFill(frame.tabId, nonce, 'item-good', 'vault-1');
    expect(reveals(h)).toHaveLength(0);
    expect(h.frames[0]?.command).toMatchObject({ type: 'fill:login', username: 'ada@example.com', password: null });
  });

  it('answers a menu only in the tab it was opened in', async () => {
    const { nonce } = (await h.worker.menuOpen(frame, LOGIN_FIELD, null))!;
    await expect(h.worker.menuInit(99, nonce)).resolves.toBeNull();
    await expect(h.worker.menuFill(99, nonce, 'item-good', 'vault-1')).resolves.toMatchObject({ ok: false, reason: 'expired' });
    expect(reveals(h)).toHaveLength(0);
  });

  it('mints a 2FA code for a one-time-code field', async () => {
    const { nonce } = (await h.worker.menuOpen(frame, { kind: 'one-time-code', hasPassword: false, hasUsername: false }, null))!;
    const context = await h.worker.menuInit(frame.tabId, nonce);
    expect(context?.items.map((item) => item.id)).toEqual(['item-good']);
    await h.worker.menuTotp(frame.tabId, nonce, 'item-good', 'vault-1');
    expect(h.frames[0]?.command).toMatchObject({ type: 'fill:otp', code: '123456', expectedOrigin: 'https://login.example.com' });
  });

  it('shows no menu on plain http, or on a site the person excluded', async () => {
    await expect(h.worker.hello({ ...frame, url: 'http://login.example.com/' })).resolves.toEqual({ inline: false });
    await expect(h.worker.hello({ ...frame, url: 'http://localhost:3000/' })).resolves.toEqual({ inline: true });
    await h.worker.setSettings({ neverMenuHosts: ['example.com'] });
    await expect(h.worker.hello(frame)).resolves.toEqual({ inline: false });
    await expect(h.worker.menuOpen(frame, LOGIN_FIELD, null)).resolves.toBeNull();
  });
});

describe('save and update prompts', () => {
  it('keeps a new login in memory and shows the bar without the password', async () => {
    await h.worker.capture(top, 'grace@example.com', 'new secret');
    const prompt = await h.worker.promptCheck(top);
    const context = await h.worker.promptInit(top.tabId, prompt!.nonce);
    expect(context).toEqual({
      kind: 'save',
      host: 'login.example.com',
      username: 'grace@example.com',
      itemTitle: null,
      vaults: [{ id: 'vault-1', name: 'Personal', personal: true }],
    });
    expect(JSON.stringify(context)).not.toContain('new secret');

    await expect(h.worker.promptSave(top.tabId, prompt!.nonce, 'vault-1')).resolves.toEqual({ ok: true });
    const created = h.calls.find((call) => call.method === 'POST' && call.path === '/api/weldpass/vaults/vault-1/items');
    expect(created?.body).toEqual({
      type: 'login',
      title: 'login.example.com',
      url: 'https://login.example.com/signin',
      fields: { username: 'grace@example.com', password: 'new secret', totp: '', notes: '' },
    });
    expect([...h.memory.keys()].some((key) => key.startsWith('weldpass:pending:'))).toBe(false);
  });

  it('shows one bar per page, in the top frame only', async () => {
    await h.worker.capture(frame, 'grace@example.com', 'new secret');
    await expect(h.worker.promptCheck(frame)).resolves.toBeNull();
    const first = await h.worker.promptCheck(top);
    expect(first).not.toBeNull();
    await expect(h.worker.promptCheck(top)).resolves.toBeNull();
    // The next page in the tab gets it again.
    await expect(h.worker.promptCheck({ ...top, documentId: 'doc-next' })).resolves.not.toBeNull();
  });

  it('asks nothing after a submit of exactly what it filled', async () => {
    const { nonce } = (await h.worker.menuOpen(frame, LOGIN_FIELD, null))!;
    await h.worker.menuFill(frame.tabId, nonce, 'item-good', 'vault-1');
    await h.worker.capture(frame, 'ada@example.com', 'correct horse');
    await expect(h.worker.promptCheck(top)).resolves.toBeNull();
  });

  it('offers to update a saved login whose password changed, keeping its other fields', async () => {
    await h.worker.capture(top, 'ada@example.com', 'brand new');
    const prompt = await h.worker.promptCheck(top);
    await expect(h.worker.promptInit(top.tabId, prompt!.nonce)).resolves.toMatchObject({
      kind: 'update',
      itemTitle: 'Example',
      vaults: [],
    });
    await h.worker.promptUpdate(top.tabId, prompt!.nonce);
    const put = h.calls.find((call) => call.method === 'PUT');
    expect(put?.path).toBe('/api/weldpass/vaults/vault-1/items/item-good');
    expect(put?.body).toMatchObject({ fields: { password: 'brand new', notes: 'keep me' } });
  });

  it('asks nothing when a typed-in password equals the saved one', async () => {
    await h.worker.capture(top, 'ada@example.com', 'correct horse');
    await expect(h.worker.promptCheck(top)).resolves.toBeNull();
  });

  it('never asks again on a site the person said never to', async () => {
    await h.worker.capture(top, 'grace@example.com', 'one');
    const prompt = await h.worker.promptCheck(top);
    await h.worker.promptNever(top.tabId, prompt!.nonce);
    expect((await h.worker.settings()).neverSaveHosts).toEqual(['login.example.com']);
    await h.worker.capture(top, 'grace@example.com', 'two');
    await expect(h.worker.promptCheck({ ...top, documentId: 'doc-2' })).resolves.toBeNull();
  });

  it('drops pending logins and open menus on sign-out', async () => {
    await h.worker.menuOpen(frame, LOGIN_FIELD, null);
    await h.worker.capture(top, 'grace@example.com', 'pw');
    await h.worker.signOut();
    expect([...h.memory.keys()].filter((key) => /^weldpass:(menu|prompt|pending):/.test(key))).toEqual([]);
  });
});

// ── the edges: server, account, menus and prompts ─────────────────────────────

const configCalls = (harness: Harness) => harness.calls.filter((call) => call.path === '/config.json');
const reject = async () => {
  throw new Error('offline');
};

describe('the server', () => {
  it('starts from a stored profile, and checks it again once it is old', async () => {
    await h.worker.state();
    const stored = JSON.parse(h.local.get('weldpass:server')!) as { checkedAt: number };
    h.local.set('weldpass:server', JSON.stringify({ ...stored, checkedAt: NOW - 7 * 60 * 60_000 }));
    const before = configCalls(h).length;
    const again = new WeldPassWorker(h.env);
    await expect(again.state()).resolves.toMatchObject({ server: { problem: null } });
    await vi.waitFor(() => expect(configCalls(h)).toHaveLength(before + 1));
  });

  it('keeps a known server working on its profile while it is unreachable', async () => {
    await h.worker.state();
    h.clock.now = NOW + 7 * 60 * 60_000;
    h.env.fetchImpl = reject as unknown as typeof fetch;
    await h.worker.refreshServer();
    await expect(h.worker.state()).resolves.toMatchObject({ server: { problem: null } });
  });

  it("reports a server it can't use", async () => {
    h.env.fetchImpl = reject as unknown as typeof fetch;
    await expect(h.worker.state()).resolves.toMatchObject({ server: { problem: 'unreachable' } });
    await expect(h.worker.passwords()).rejects.toMatchObject({ code: 'no-server' });
    await expect(h.worker.hello(frame)).resolves.toEqual({ inline: false });
    await expect(h.worker.signIn()).resolves.toEqual({ ok: false, reason: 'server' });
  });

  it("ignores a stored server it can't read", async () => {
    h.local.set('weldpass:server', '{broken');
    await expect(h.worker.state()).resolves.toMatchObject({ server: { origin: ORIGIN, problem: null } });
    h.local.set('weldpass:server', JSON.stringify({ origin: 42 }));
    await expect(new WeldPassWorker(h.env).state()).resolves.toMatchObject({ server: { origin: ORIGIN } });
  });

  it('names the host access it lacks, and picks up a grant', async () => {
    h.env.hasPermission = async (origins) => origins.length === 1 && origins[0]!.startsWith(ORIGIN);
    await expect(h.worker.state()).resolves.toMatchObject({
      server: { problem: 'no-permission', missingPatterns: [`${ISSUER}/*`] },
    });
    h.env.hasPermission = async () => true;
    await h.worker.permissionsChanged();
    await expect(h.worker.state()).resolves.toMatchObject({ server: { problem: null, missingPatterns: [] } });
  });

  it('inspects another server before switching to it', async () => {
    await expect(h.worker.inspect('https://weld.example')).resolves.toEqual({
      ok: true,
      issuer: 'https://auth.weld.example',
      patterns: ['https://weld.example/*', 'https://auth.weld.example/*'],
    });
    h.env.fetchImpl = reject as unknown as typeof fetch;
    await expect(h.worker.inspect('https://down.example')).resolves.toMatchObject({ ok: false });
  });

  it('switches server, signs out of the old one and gives back host access it no longer needs', async () => {
    const removed: string[][] = [];
    h.env.removePermission = async (origins) => {
      removed.push(origins);
    };
    await h.worker.menuOpen(frame, LOGIN_FIELD, null);
    const switched = await h.worker.setServer('https://weld.example');
    expect(switched).toMatchObject({ ok: true, state: { server: { origin: 'https://weld.example', isDefault: false } } });
    expect([...h.memory.keys()].some((key) => key.startsWith('weldpass:menu:'))).toBe(false);

    const back = await h.worker.setServer(null);
    expect(back).toMatchObject({ ok: true, state: { server: { origin: ORIGIN, isDefault: true } } });
    expect(removed).toEqual([['https://weld.example/*', 'https://auth.weld.example/*']]);
  });

  it('refuses a server it has no host access to, or that answers no config', async () => {
    h.env.hasPermission = async (origins) => origins.every((origin) => origin.includes('weldsuite.eu'));
    await expect(h.worker.setServer('https://weld.example')).resolves.toEqual({ ok: false, problem: 'no-permission' });
    h.env.fetchImpl = reject as unknown as typeof fetch;
    await expect(h.worker.setServer('https://down.example')).resolves.toMatchObject({ ok: false });
  });
});

describe('the account', () => {
  it("switches between the person's workspaces only", async () => {
    await expect(h.worker.setWorkspace('ws_1')).resolves.toMatchObject({ activeWorkspaceId: 'ws_1' });
    await expect(h.worker.setWorkspace('ws_other')).rejects.toMatchObject({ code: 'not-found' });
  });

  it("reports a cancelled sign-in, in the browser's language", async () => {
    const urls: string[] = [];
    h.env.launchWebAuthFlow = async ({ url }) => {
      urls.push(url);
      return undefined;
    };
    vi.stubGlobal('chrome', { i18n: { getUILanguage: () => 'nl-NL' } });
    await expect(h.worker.signIn()).resolves.toEqual({ ok: false, reason: 'cancelled' });
    expect(new URL(urls[0]!).searchParams.get('ui_locales')).toBe('nl');
  });

  it("reports a sign-in page that can't be loaded, and a sign-in that fails", async () => {
    h.env.launchWebAuthFlow = async () => {
      throw new Error('Authorization page could not be loaded.');
    };
    vi.stubGlobal('chrome', {
      i18n: {
        getUILanguage: () => {
          throw new Error('no i18n');
        },
      },
    });
    await expect(h.worker.signIn()).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
      message: 'Authorization page could not be loaded.',
    });

    // A redirect that comes back right, with an ID token for another sign-in.
    const payload = Buffer.from(JSON.stringify({ sub: 'user-1', nonce: 'another' })).toString('base64url');
    const working = h.env.fetchImpl;
    h.env.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/oauth/token')
        ? json({ access_token: 'at', token_type: 'Bearer', expires_in: 600, id_token: `e30.${payload}.sig` })
        : working(input, init)) as typeof fetch;
    h.env.launchWebAuthFlow = async ({ url }) => {
      const state = new URL(url).searchParams.get('state');
      return `https://nlmnjlkgeoeklbahlemmlcfnlfgdimnp.chromiumapp.org/?code=abc&state=${state}`;
    };
    await expect(h.worker.signIn()).resolves.toMatchObject({ ok: false, reason: 'failed' });
  });

  it('reports an issuer that is down', async () => {
    const working = h.env.fetchImpl;
    h.env.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('openid-configuration') ? reject() : working(input, init)) as typeof fetch;
    await expect(h.worker.signIn()).resolves.toEqual({ ok: false, reason: 'unreachable' });
  });

  it('needs a person, and in header mode a workspace, before the API', async () => {
    h.local.delete(`weldsuite.oidc.${STORAGE_ID}`);
    await expect(h.worker.passwords()).rejects.toMatchObject({ code: 'signed-out' });

    const other = harness();
    const profile = JSON.parse(other.local.get(`weldsuite:oidc-profile:${STORAGE_ID}`)!) as Record<string, unknown>;
    other.local.set(
      `weldsuite:oidc-profile:${STORAGE_ID}`,
      JSON.stringify({
        ...profile,
        organizations: [
          { id: 'ws_1', name: 'Acme', slug: null },
          { id: 'ws_2', name: 'Globex', slug: null },
        ],
        activeWorkspaceId: null,
      }),
    );
    await expect(other.worker.passwords()).rejects.toMatchObject({ code: 'no-workspace' });
  });
});

describe('settings', () => {
  it('falls back to the defaults for broken settings, and merges changes', async () => {
    h.local.set('weldpass:settings', '{broken');
    await expect(h.worker.settings()).resolves.toMatchObject({ inlineMenus: true, savePrompts: true });
    await expect(h.worker.setSettings({ savePrompts: false })).resolves.toMatchObject({ savePrompts: false });
    await expect(h.worker.settings()).resolves.toMatchObject({ inlineMenus: true, savePrompts: false });
  });
});

describe('inline menu edges', () => {
  it('opens no menu where inline menus are off', async () => {
    await h.worker.setSettings({ inlineMenus: false });
    await expect(h.worker.menuOpen(frame, LOGIN_FIELD, null)).resolves.toBeNull();
  });

  it('forgets a menu after ten minutes, and ignores a nonce that is too short', async () => {
    const { nonce } = (await h.worker.menuOpen(frame, LOGIN_FIELD, null))!;
    await expect(h.worker.menuInit(frame.tabId, 'short')).resolves.toBeNull();
    h.clock.now = NOW + 11 * 60_000;
    await expect(h.worker.menuInit(frame.tabId, nonce)).resolves.toBeNull();
    expect(h.memory.has(`weldpass:menu:${nonce}`)).toBe(false);
  });

  it('names a cross-origin frame', async () => {
    const { nonce } = (await h.worker.menuOpen(frame, LOGIN_FIELD, 'https://portal.example'))!;
    await expect(h.worker.menuInit(frame.tabId, nonce)).resolves.toMatchObject({
      crossOrigin: true,
      frameOrigin: 'https://login.example.com',
    });
  });

  it('fills a generated password into a new-password field only', async () => {
    const field = { kind: 'new-password' as const, hasPassword: false, hasUsername: false };
    const { nonce } = (await h.worker.menuOpen(frame, field, null))!;
    await expect(h.worker.menuInit(frame.tabId, nonce)).resolves.toMatchObject({ items: [], blocked: false });
    await expect(h.worker.menuGenerated(frame.tabId, nonce, 'short')).resolves.toEqual({ ok: false, reason: 'refused' });
    await expect(h.worker.menuGenerated(frame.tabId, nonce, 'Generated-password-1')).resolves.toEqual({ ok: true });
    expect(h.frames.map((sent) => sent.command.type)).toEqual(['fill:new-password', 'menu:remove']);
    await expect(h.worker.menuGenerated(frame.tabId, nonce, 'Generated-password-1')).resolves.toEqual({
      ok: false,
      reason: 'expired',
    });

    const login = (await h.worker.menuOpen(frame, LOGIN_FIELD, null))!;
    await expect(h.worker.menuGenerated(frame.tabId, login.nonce, 'Generated-password-1')).resolves.toEqual({
      ok: false,
      reason: 'refused',
    });
  });

  it("refuses 2FA codes for a login it can't find, and expired menus", async () => {
    const otp = { kind: 'one-time-code' as const, hasPassword: false, hasUsername: false };
    const { nonce } = (await h.worker.menuOpen(frame, otp, null))!;
    await expect(h.worker.menuTotp(frame.tabId, nonce, 'missing', 'vault-1')).resolves.toEqual({
      ok: false,
      reason: 'refused',
    });
    await expect(h.worker.menuTotp(frame.tabId, 'x'.repeat(32), 'item-good', 'vault-1')).resolves.toEqual({
      ok: false,
      reason: 'expired',
    });
    await expect(h.worker.menuFill(frame.tabId, 'x'.repeat(32), 'item-good', 'vault-1')).resolves.toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('tells the menu what the frame answered', async () => {
    const answers: Array<() => Promise<unknown>> = [
      reject,
      async () => ({ status: 'origin-mismatch' }),
      async () => ({ status: 'refused' }),
      async () => ({ status: 'no-fields' }),
    ];
    const reasons: unknown[] = [];
    for (const answer of answers) {
      h.env.sendToFrame = answer as WorkerEnv['sendToFrame'];
      const { nonce } = (await h.worker.menuOpen(frame, LOGIN_FIELD, null))!;
      reasons.push(await h.worker.menuFill(frame.tabId, nonce, 'item-good', 'vault-1'));
    }
    expect(reasons).toEqual([
      { ok: false, reason: 'page-changed' },
      { ok: false, reason: 'page-changed' },
      { ok: false, reason: 'refused' },
      { ok: false, reason: 'no-fields' },
    ]);
  });

  it('refuses a username-only fill for a login without a username', async () => {
    const step = { kind: 'login' as const, hasPassword: false, hasUsername: true };
    const { nonce } = (await h.worker.menuOpen(frame, step, null))!;
    vi.mocked(fetch).mockImplementationOnce(async () => json({ data: [{ ...ITEMS.good, subtitle: null }] }));
    await expect(h.worker.menuFill(frame.tabId, nonce, 'item-good', 'vault-1')).resolves.toEqual({
      ok: false,
      reason: 'no-fields',
    });
  });

  it('closes a menu for the frame that opened it only, and targets frames without a document id', async () => {
    const sender = { ...frame, documentId: undefined };
    const { nonce } = (await h.worker.menuOpen(sender, LOGIN_FIELD, null))!;
    await h.worker.menuClosed({ ...sender, frameId: 9 }, nonce);
    expect(h.memory.has(`weldpass:menu:${nonce}`)).toBe(true);
    await h.worker.menuClose(frame.tabId, nonce);
    expect(h.frames.at(-1)).toMatchObject({ command: { type: 'menu:remove' }, target: { frameId: frame.frameId } });
    expect(h.frames.at(-1)!.target).not.toHaveProperty('documentId');
    await h.worker.menuClose(frame.tabId, nonce);
    expect(h.frames).toHaveLength(1);

    const second = (await h.worker.menuOpen(sender, LOGIN_FIELD, null))!;
    await h.worker.menuClosed(sender, second.nonce);
    expect(h.memory.has(`weldpass:menu:${second.nonce}`)).toBe(false);
  });
});

describe('save prompt edges', () => {
  it("ignores what it can't or mustn't keep", async () => {
    await h.worker.capture(top, 'x'.repeat(256), 'pw');
    await h.worker.capture(top, 'ada', 'x'.repeat(4097));
    await h.worker.capture({ ...top, url: 'http://login.example.com/' }, 'ada', 'pw');
    await h.worker.capture(top, 42 as unknown as string, 'pw');
    await h.worker.setSettings({ savePrompts: false });
    await h.worker.capture(top, 'ada', 'pw');
    expect(await h.worker.promptCheck(top)).toBeNull();
  });

  it('asks nothing when signed out', async () => {
    h.local.delete(`weldsuite.oidc.${STORAGE_ID}`);
    await h.worker.capture(top, 'grace@example.com', 'pw');
    await expect(h.worker.promptCheck(top)).resolves.toBeNull();
  });

  it('remembers the username of a two-step login for the password step', async () => {
    await h.worker.capture(top, 'grace@example.com', '');
    await h.worker.capture(top, '', 'second step');
    const prompt = (await h.worker.promptCheck(top))!;
    await expect(h.worker.promptInit(top.tabId, prompt.nonce)).resolves.toMatchObject({
      kind: 'save',
      username: 'grace@example.com',
    });
  });

  it('acts on no expired bar, nor on the wrong kind of bar', async () => {
    const stale = 'x'.repeat(32);
    await expect(h.worker.promptSave(top.tabId, stale, 'vault-1')).resolves.toEqual({ ok: false, reason: 'expired' });
    await expect(h.worker.promptUpdate(top.tabId, stale)).resolves.toEqual({ ok: false, reason: 'expired' });
    await expect(h.worker.promptNever(top.tabId, stale)).resolves.toEqual({ ok: false, reason: 'expired' });
    await expect(h.worker.promptDismiss(top.tabId, stale)).resolves.toEqual({ ok: false, reason: 'expired' });

    await h.worker.capture(top, 'grace@example.com', 'pw');
    const prompt = (await h.worker.promptCheck(top))!;
    await expect(h.worker.promptUpdate(top.tabId, prompt.nonce)).resolves.toEqual({ ok: false, reason: 'expired' });
    await expect(h.worker.promptInit(99, prompt.nonce)).resolves.toBeNull();
  });

  it('saves a new login', async () => {
    await h.worker.capture(top, 'grace@example.com', 'pw');
    const prompt = (await h.worker.promptCheck(top))!;
    await expect(h.worker.promptSave(top.tabId, prompt.nonce, 'vault-1')).resolves.toEqual({ ok: true });
    const created = h.calls.find((call) => call.method === 'POST' && call.path === '/api/weldpass/vaults/vault-1/items');
    expect(created?.body).toMatchObject({ title: 'login.example.com', fields: { username: 'grace@example.com' } });
    expect(h.frames.at(-1)).toMatchObject({ command: { type: 'prompt:remove' } });
    await expect(h.worker.promptCheck(top)).resolves.toBeNull();
  });

  it('dismisses a bar, and forgets one its page closed', async () => {
    await h.worker.capture(top, 'grace@example.com', 'pw');
    const first = (await h.worker.promptCheck(top))!;
    await h.worker.promptClosed(top, first.nonce);
    expect(h.memory.has(`weldpass:prompt:${first.nonce}`)).toBe(false);

    const second = (await h.worker.promptCheck(top))!;
    await expect(h.worker.promptDismiss(top.tabId, second.nonce)).resolves.toEqual({ ok: true });
    await expect(h.worker.promptCheck(top)).resolves.toBeNull();
  });

  it("drops a tab's menus, bars and pending logins when it closes", async () => {
    await h.worker.menuOpen(frame, LOGIN_FIELD, null);
    await h.worker.menuOpen({ ...frame, tabId: 8 }, LOGIN_FIELD, null);
    await h.worker.capture(top, 'grace@example.com', 'pw');
    await h.worker.promptCheck(top);
    await h.worker.tabClosed(frame.tabId);
    const left = [...h.memory.keys()].filter((key) => /^weldpass:(menu|prompt|pending):/.test(key));
    expect(left).toHaveLength(1);
    expect(h.memory.get(left[0]!)).toMatchObject({ tabId: 8 });
  });
});
