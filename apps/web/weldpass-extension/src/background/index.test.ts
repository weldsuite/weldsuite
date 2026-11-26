/**
 * The service worker's entry: `chrome.*` wired to `WeldPassWorker`, and the
 * message router. The worker itself is replaced by a recording fake here; its
 * behaviour has its own tests (`worker.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerEnv } from './worker';

const fake = vi.hoisted(() => {
  const calls: Array<[string, unknown[]]> = [];
  const state: { env: unknown; result: unknown; error: unknown } = { env: null, result: 'ok', error: null };
  const answer = (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, args]);
      return state.error ? Promise.reject(state.error) : Promise.resolve(state.result);
    };
  const api = {
    matchItems: answer('matchItems'),
    listItems: answer('listItems'),
    listVaults: answer('listVaults'),
    revealItem: answer('revealItem'),
    generateTotp: answer('generateTotp'),
    createItem: answer('createItem'),
    passwordHealth: answer('passwordHealth'),
    listItemVersions: answer('listItemVersions'),
    notifications: {
      list: answer('notifications.list'),
      unreadCount: answer('notifications.unreadCount'),
      markRead: answer('notifications.markRead'),
      markAllRead: answer('notifications.markAllRead'),
    },
  };
  class FakeWorker {
    constructor(env: unknown) {
      state.env = env;
    }
    passwords() {
      calls.push(['passwords', []]);
      return state.error ? Promise.reject(state.error) : Promise.resolve(api);
    }
  }
  const methods = [
    'init',
    'state',
    'signIn',
    'signOut',
    'setWorkspace',
    'inspect',
    'setServer',
    'settings',
    'setSettings',
    'hello',
    'menuOpen',
    'menuClosed',
    'capture',
    'promptCheck',
    'promptClosed',
    'menuInit',
    'menuFill',
    'menuTotp',
    'menuGenerated',
    'menuClose',
    'promptInit',
    'promptSave',
    'promptUpdate',
    'promptNever',
    'promptDismiss',
    'permissionsChanged',
    'tabClosed',
  ];
  for (const name of methods) {
    (FakeWorker.prototype as unknown as Record<string, unknown>)[name] = answer(name);
  }
  return { calls, state, FakeWorker };
});

vi.mock('./worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./worker')>()),
  WeldPassWorker: fake.FakeWorker,
}));

type Listener = (...args: unknown[]) => unknown;
const EXT = 'weldpass-id';

let onMessage: Listener;
let listeners: Record<string, Listener>;
let local: Record<string, unknown>;
let session: Record<string, unknown>;
let chromeStub: ReturnType<typeof makeChrome>;

function area(data: Record<string, unknown>) {
  return {
    get: vi.fn(async (key: string | null) => (key === null ? { ...data } : key in data ? { [key]: data[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    }),
    remove: vi.fn(async (key: string) => {
      delete data[key];
    }),
  };
}

function event(name: string) {
  return {
    addListener: (listener: Listener) => {
      listeners[name] = listener;
    },
  };
}

function makeChrome() {
  return {
    runtime: {
      id: EXT,
      sendMessage: vi.fn(async () => undefined),
      onMessage: {
        addListener: (listener: Listener) => {
          onMessage = listener;
        },
      },
      onInstalled: event('installed'),
    },
    storage: { local: area(local), session: area(session) },
    identity: {
      getRedirectURL: () => `https://${EXT}.chromiumapp.org/`,
      launchWebAuthFlow: vi.fn(async () => `https://${EXT}.chromiumapp.org/?code=1`),
    },
    permissions: {
      contains: vi.fn(async () => true),
      remove: vi.fn(async () => true),
      onAdded: event('permissionsAdded'),
      onRemoved: event('permissionsRemoved'),
    },
    tabs: {
      sendMessage: vi.fn(async () => ({ status: 'ok' })),
      query: vi.fn(async () => [{ id: 1 }, { id: 2, discarded: true }, {}, { id: 3 }]),
      onRemoved: event('tabRemoved'),
    },
    scripting: { executeScript: vi.fn(async () => []) },
  };
}

const page = { id: EXT, url: `chrome-extension://${EXT}/popup.html` };
const menu = { id: EXT, url: `chrome-extension://dynamic/menu.html#n=x`, tab: { id: 7 } };
const prompt = { id: EXT, url: `chrome-extension://dynamic/prompt.html#n=x`, tab: { id: 7 } };
const content = { id: EXT, url: 'https://example.com/login', tab: { id: 7 }, frameId: 2, documentId: 'doc-1' };

/** Sends `message` from `sender` and resolves with what the router answered, or `'unanswered'`. */
async function send(message: unknown, sender: object): Promise<unknown> {
  let reply: (value: unknown) => void = () => undefined;
  const replied = new Promise((resolve) => {
    reply = resolve;
  });
  const keepOpen = onMessage(message, sender, reply);
  if (keepOpen !== true) return 'unanswered';
  return replied;
}

const lastCall = () => fake.calls.at(-1);
const env = () => fake.state.env as WorkerEnv;

beforeEach(async () => {
  fake.calls.length = 0;
  fake.state.result = 'ok';
  fake.state.error = null;
  listeners = {};
  local = {};
  session = {};
  chromeStub = makeChrome();
  vi.stubGlobal('chrome', chromeStub);
  vi.resetModules();
  await import('./index');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('routing', () => {
  it('answers the popup and the settings page', async () => {
    expect(fake.calls[0]).toEqual(['init', []]);
    const cases: Array<[object, string, unknown[]]> = [
      [{ type: 'state:get' }, 'state', []],
      [{ type: 'auth:sign-in' }, 'signIn', []],
      [{ type: 'auth:sign-out' }, 'signOut', []],
      [{ type: 'workspace:set', workspaceId: 'ws_1' }, 'setWorkspace', ['ws_1']],
      [{ type: 'server:inspect', origin: 'https://weld.example' }, 'inspect', ['https://weld.example']],
      [{ type: 'server:set', origin: 'https://weld.example' }, 'setServer', ['https://weld.example']],
      [{ type: 'server:set', origin: 42 }, 'setServer', [null]],
      [{ type: 'settings:get' }, 'settings', []],
      [{ type: 'settings:set', patch: { savePrompts: false } }, 'setSettings', [{ savePrompts: false }]],
      [{ type: 'settings:set' }, 'setSettings', [{}]],
    ];
    for (const [message, method, args] of cases) {
      expect(await send(message, page)).toEqual({ ok: true, value: 'ok' });
      expect(lastCall()).toEqual([method, args]);
    }
  });

  it('passes the popup\'s WeldPass calls to the API, returning their data', async () => {
    fake.state.result = { data: ['row'] };
    const cases: Array<[object, string, unknown[]]> = [
      [{ type: 'items:match', url: 'https://example.com' }, 'matchItems', ['https://example.com']],
      [{ type: 'items:list' }, 'listItems', [{ type: 'login' }]],
      [{ type: 'vaults:list' }, 'listVaults', []],
      [{ type: 'health:get' }, 'passwordHealth', []],
      [{ type: 'notifications:read', id: 'n' }, 'notifications.markRead', ['n']],
      [{ type: 'notifications:read-all' }, 'notifications.markAllRead', []],
      [{ type: 'item:reveal', vaultId: 'v', itemId: 'i' }, 'revealItem', ['v', 'i']],
      [{ type: 'item:totp', vaultId: 'v', itemId: 'i' }, 'generateTotp', ['v', 'i']],
      [{ type: 'item:versions', vaultId: 'v', itemId: 'i' }, 'listItemVersions', ['v', 'i']],
      [{ type: 'item:create', vaultId: 'v', input: { title: 'x' } }, 'createItem', ['v', { title: 'x' }]],
    ];
    for (const [message, method, args] of cases) {
      expect(await send(message, page)).toEqual({ ok: true, value: ['row'] });
      expect(lastCall()).toEqual([method, args]);
    }
  });

  it("lists the bell's notifications with the unread count", async () => {
    fake.state.result = { data: { count: 2 } };
    expect(await send({ type: 'notifications:list' }, page)).toEqual({
      ok: true,
      value: { items: { count: 2 }, unread: 2 },
    });
    expect(fake.calls).toContainEqual(['notifications.list', [{ limit: 20 }]]);
    expect(fake.calls).toContainEqual(['notifications.unreadCount', []]);
  });

  it('answers a content script with its frame as the sender', async () => {
    const sender = { kind: 'content', tabId: 7, frameId: 2, documentId: 'doc-1', url: 'https://example.com/login' };
    const field = { kind: 'login', hasPassword: true, hasUsername: true };
    const cases: Array<[object, string, unknown[]]> = [
      [{ type: 'content:hello' }, 'hello', [sender]],
      [{ type: 'content:menu-open', field, topOrigin: null }, 'menuOpen', [sender, field, null]],
      [{ type: 'content:menu-closed', nonce: 'n' }, 'menuClosed', [sender, 'n']],
      [{ type: 'content:capture', username: 'u', password: 'p' }, 'capture', [sender, 'u', 'p']],
      [{ type: 'content:prompt-check' }, 'promptCheck', [sender]],
      [{ type: 'content:prompt-closed', nonce: 'n' }, 'promptClosed', [sender, 'n']],
    ];
    for (const [message, method, args] of cases) {
      expect(await send(message, content)).toEqual({ ok: true, value: 'ok' });
      expect(lastCall()).toEqual([method, args]);
    }
  });

  it('answers the menu and the bar for their own tab', async () => {
    const menuCases: Array<[object, string, unknown[]]> = [
      [{ type: 'menu:init', nonce: 'n' }, 'menuInit', [7, 'n']],
      [{ type: 'menu:fill', nonce: 'n', itemId: 'i', vaultId: 'v' }, 'menuFill', [7, 'n', 'i', 'v']],
      [{ type: 'menu:totp', nonce: 'n', itemId: 'i', vaultId: 'v' }, 'menuTotp', [7, 'n', 'i', 'v']],
      [{ type: 'menu:generated', nonce: 'n', password: 'pw' }, 'menuGenerated', [7, 'n', 'pw']],
      [{ type: 'menu:close', nonce: 'n' }, 'menuClose', [7, 'n']],
    ];
    for (const [message, method, args] of menuCases) {
      await send(message, menu);
      expect(lastCall()).toEqual([method, args]);
    }
    const promptCases: Array<[object, string, unknown[]]> = [
      [{ type: 'prompt:init', nonce: 'n' }, 'promptInit', [7, 'n']],
      [{ type: 'prompt:save', nonce: 'n', vaultId: 'v' }, 'promptSave', [7, 'n', 'v']],
      [{ type: 'prompt:update', nonce: 'n' }, 'promptUpdate', [7, 'n']],
      [{ type: 'prompt:never', nonce: 'n' }, 'promptNever', [7, 'n']],
      [{ type: 'prompt:dismiss', nonce: 'n' }, 'promptDismiss', [7, 'n']],
    ];
    for (const [message, method, args] of promptCases) {
      await send(message, prompt);
      expect(lastCall()).toEqual([method, args]);
    }
  });

  it('answers an undefined result as null', async () => {
    fake.state.result = undefined;
    expect(await send({ type: 'content:capture', username: 'u', password: 'p' }, content)).toEqual({
      ok: true,
      value: null,
    });
  });

  it('refuses unknown types of a known prefix', async () => {
    const invalid = { ok: false, error: { code: 'invalid' } };
    expect(await send({ type: 'unknown' }, page)).toEqual(invalid);
    expect(await send({ type: 'content:unknown' }, content)).toEqual(invalid);
    expect(await send({ type: 'menu:unknown', nonce: 'n' }, menu)).toEqual(invalid);
    expect(await send({ type: 'prompt:unknown', nonce: 'n' }, prompt)).toEqual(invalid);
  });

  it('ignores other senders, malformed messages and messages of another kind', async () => {
    expect(await send({ type: 'state:get' }, { id: 'another-extension', url: page.url })).toBe('unanswered');
    expect(await send('state:get', page)).toBe('unanswered');
    expect(await send({ type: 42 }, page)).toBe('unanswered');
    expect(await send({ type: 'item:reveal', vaultId: 'v', itemId: 'i' }, content)).toBe('unanswered');
    expect(await send({ type: 'menu:fill', nonce: 'n' }, prompt)).toBe('unanswered');
    expect(fake.calls.map(([name]) => name)).toEqual(['init']);
  });

  it('turns errors into codes, never their text', async () => {
    const { WorkerError } = await import('./worker');
    const cases: Array<[unknown, unknown]> = [
      [new WorkerError('no-workspace'), { code: 'no-workspace' }],
      [{ isNetworkError: true }, { code: 'network' }],
      [{ isApiError: true, status: 403 }, { code: 'api', status: 403 }],
      [new Error('Authentication required'), { code: 'signed-out' }],
      [new Error('secret detail'), { code: 'error' }],
    ];
    for (const [error, expected] of cases) {
      fake.state.error = error;
      expect(await send({ type: 'state:get' }, page)).toEqual({ ok: false, error: expected });
    }
  });
});

describe('the chrome wiring', () => {
  it('gives the worker chrome-backed stores', async () => {
    const worker = env();
    await worker.local.setItem('a', '1');
    expect(await worker.local.getItem('a')).toBe('1');
    expect(local.a).toBe('1');
    await worker.secure.setItemAsync('refresh', 'token');
    expect(local.refresh).toBe('token');
    await worker.session.setItem('access', 'token');
    expect(session.access).toBe('token');
    await worker.memory.set('weldpass:menu:x', { tabId: 1 });
    expect(await worker.memoryKeys()).toEqual(['access', 'weldpass:menu:x']);
  });

  it('wires sign-in, permissions, frames and broadcasts to chrome', async () => {
    const worker = env();
    expect(worker.redirectUri).toBe(`https://${EXT}.chromiumapp.org/`);
    await worker.launchWebAuthFlow({ url: 'https://auth.example/authorize', interactive: true });
    expect(chromeStub.identity.launchWebAuthFlow).toHaveBeenCalledWith({
      url: 'https://auth.example/authorize',
      interactive: true,
    });
    expect(await worker.hasPermission(['https://weld.example/*'])).toBe(true);
    await worker.removePermission(['https://weld.example/*']);
    expect(chromeStub.permissions.remove).toHaveBeenCalledWith({ origins: ['https://weld.example/*'] });
    await worker.sendToFrame(7, { type: 'prompt:poke' }, { frameId: 0 });
    expect(chromeStub.tabs.sendMessage).toHaveBeenCalledWith(7, { type: 'prompt:poke' }, { frameId: 0 });
    worker.broadcast();
    expect(chromeStub.runtime.sendMessage).toHaveBeenCalledWith({ type: 'state:changed' });
    chromeStub.runtime.sendMessage.mockRejectedValueOnce(new Error('no receiver'));
    expect(() => worker.broadcast()).not.toThrow();
    expect(worker.randomId()).toMatch(/^[0-9a-f]{32}$/);
    expect(worker.randomId()).not.toBe(worker.randomId());
  });

  it('fetches through the global fetch', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await env().fetchImpl('https://weld.example/config.json', { method: 'GET' });
    expect(fetchMock).toHaveBeenCalledWith('https://weld.example/config.json', { method: 'GET' });
  });

  it('tells the worker about permission changes and closed tabs', async () => {
    listeners.permissionsAdded!();
    listeners.permissionsRemoved!();
    listeners.tabRemoved!(9);
    expect(fake.calls.slice(1)).toEqual([
      ['permissionsChanged', []],
      ['permissionsChanged', []],
      ['tabClosed', [9]],
    ]);
  });

  it('puts the content script into tabs that were open at install', async () => {
    listeners.installed!();
    await vi.waitFor(() => expect(chromeStub.scripting.executeScript).toHaveBeenCalledTimes(2));
    expect(chromeStub.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 1, allFrames: true },
      files: ['content.js'],
    });
    expect(chromeStub.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 3, allFrames: true },
      files: ['content.js'],
    });
  });

  it('survives a failing tab query at install', async () => {
    chromeStub.tabs.query.mockRejectedValueOnce(new Error('no tabs'));
    listeners.installed!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chromeStub.scripting.executeScript).not.toHaveBeenCalled();
  });
});
