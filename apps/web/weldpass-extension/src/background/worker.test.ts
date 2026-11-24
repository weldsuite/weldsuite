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
}

function harness(): Harness {
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const memory = new Map<string, unknown>();
  const calls: Harness['calls'] = [];
  const frames: Harness['frames'] = [];
  const revealed = { password: 'correct horse' };

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
    if (url.href === `${ORIGIN}/config.json`) {
      return json({
        backend: 'rust',
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
    now: () => NOW,
  };
  return { worker: new WeldPassWorker(env), calls, frames, memory, local, revealed };
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
