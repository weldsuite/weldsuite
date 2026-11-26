// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionState } from '../lib/protocol';
import { App } from './App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Message {
  type: string;
  [key: string]: unknown;
}

type Listener = (message: unknown, sender: { id?: string }) => void;

/** What the worker answers per message type: an envelope, or a promise of one. */
let replies: Record<string, (message: Message) => unknown>;
const sendMessage = vi.fn((message: Message) => {
  const reply = replies[message.type];
  return Promise.resolve(reply ? reply(message) : { ok: false, error: { code: 'unexpected' } });
});
const listeners = new Set<Listener>();
const createTab = vi.fn<(options: { url: string }) => Promise<unknown>>(() => Promise.resolve({}));

const ok = (value: unknown) => ({ ok: true, value });
const failure = { ok: false, error: { code: 'boom' } };

/** A worker answer the test hands over when it chooses. */
function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void } {
  let finish: (value: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  return { promise, resolve: (value) => finish(value) };
}

function extensionState(
  overrides: Partial<ExtensionState> = {},
  server: Partial<ExtensionState['server']> = {},
): ExtensionState {
  return {
    server: {
      origin: 'https://app.weldsuite.eu',
      label: 'app.weldsuite.eu',
      problem: null,
      missingPatterns: [],
      accountUrl: null,
      isDefault: true,
      ...server,
    },
    loaded: true,
    person: { name: 'Ada', email: 'ada@example.com' },
    workspaces: [{ id: 'ws_1', name: 'Acme' }],
    activeWorkspaceId: 'ws_1',
    loadingWorkspaces: false,
    ...overrides,
  };
}

const TWO_WORKSPACES = [
  { id: 'ws_1', name: 'Acme' },
  { id: 'ws_2', name: 'Globex' },
];

let root: Root | null = null;

/** Let the worker's answers (a few promise hops) land. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  const created = createRoot(container);
  root = created;
  await act(async () => created.render(<App />));
  await settle();
}

async function click(element: Element): Promise<void> {
  await act(async () => (element as HTMLElement).click());
  await settle();
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function text(): string {
  return document.body.textContent ?? '';
}

function heading(): string {
  return document.querySelector('h1')?.textContent ?? '';
}

function button(name: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === name || candidate.getAttribute('aria-label') === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

/** The header's workspace switch (a menu, shown with more than one workspace). */
function workspaceSwitch(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[data-workspace-switch]');
}

/** Opens the workspace menu from the keyboard and picks `name`. ArrowDown opens it; Enter would toggle. */
async function pickWorkspace(name: string): Promise<void> {
  const trigger = workspaceSwitch();
  if (!trigger) throw new Error('no workspace switch');
  // Let a previous close hand the focus back first, or that late focus counts
  // as focus leaving the new menu, which closes it.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await settle();
  const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
    (candidate) => candidate.textContent === name,
  );
  if (!(item instanceof HTMLElement)) {
    throw new Error(
      `no workspace ${name} in the menu: expanded=${trigger.getAttribute('aria-expanded')}, items=[${Array.from(document.querySelectorAll('[role^="menuitem"]')).map((i) => i.textContent).join(', ')}]`,
    );
  }
  await click(item);
}

/** Logins is the home page: the only one without a back button. */
function onLogins(): boolean {
  return document.querySelector('[aria-label^="Back to"]') === null;
}

function field(label: string): HTMLInputElement {
  const found = Array.from(document.querySelectorAll('label')).find((candidate) => candidate.textContent === label);
  const input = found ? document.getElementById(found.htmlFor) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error(`no field ${label}`);
  return input;
}

function sent(type: string): Message[] {
  return sendMessage.mock.calls.map(([message]) => message).filter((message) => message.type === type);
}

/** The worker says the session, workspace or server changed. */
async function broadcast(message: unknown, sender: { id?: string }): Promise<void> {
  await act(async () => {
    for (const listener of listeners) listener(message, sender);
  });
  await settle();
}

beforeEach(() => {
  replies = {
    'state:get': () => ok(extensionState()),
    'items:match': () => ok([]),
    'items:list': () => ok([]),
    'vaults:list': () => ok([]),
  };
  sendMessage.mockClear();
  createTab.mockClear();
  listeners.clear();
  // The library's menus (Radix) size themselves with ResizeObserver, which jsdom lacks.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'weldpass',
      sendMessage,
      getURL: (path: string) => `chrome-extension://weldpass/${path}`,
      onMessage: {
        addListener: (listener: Listener) => listeners.add(listener),
        removeListener: (listener: Listener) => listeners.delete(listener),
      },
    },
    tabs: { create: createTab },
  });
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('shows a spinner until the worker answers', async () => {
    replies['state:get'] = () => new Promise<never>(() => undefined);
    await mount();
    expect(heading()).toBe('WeldPass');
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Loading…');
  });

  it('offers a retry when the worker does not answer', async () => {
    replies['state:get'] = () => failure;
    await mount();
    expect(heading()).toBe("Can't check your sign-in");
    expect(text()).toContain("WeldPass can't reach its background service.");

    replies['state:get'] = () => ok(extensionState());
    await click(button('Try again'));
    expect(sent('state:get')).toHaveLength(2);
    expect(button('Tools')).toBeTruthy();
    expect(onLogins()).toBe(true);
  });

  it('names a server it cannot use, with a retry and a way to another server', async () => {
    replies['state:get'] = () => ok(extensionState({}, { problem: 'unreachable' }));
    await mount();
    expect(heading()).toBe('app.weldsuite.eu');
    expect(text()).toContain("Can't reach the server.");

    await click(button('Try again'));
    expect(sent('state:get')).toHaveLength(2);

    await click(button('Use another server'));
    expect(createTab).toHaveBeenCalledWith({ url: 'chrome-extension://weldpass/settings.html#server' });
  });

  it('sends the person to settings to grant host access', async () => {
    replies['state:get'] = () =>
      ok(extensionState({}, { problem: 'no-permission', missingPatterns: ['https://auth.weldsuite.eu/*'] }));
    await mount();
    expect(text()).toContain('WeldPass needs your permission to reach this server and its sign-in page.');
    await click(button('Allow access'));
    expect(createTab).toHaveBeenCalledWith({ url: 'chrome-extension://weldpass/settings.html#server' });
  });

  it('waits for the stored session to be read', async () => {
    replies['state:get'] = () => ok(extensionState({ loaded: false }));
    await mount();
    expect(text()).toContain('Loading…');
  });

  describe('signed out', () => {
    beforeEach(() => {
      replies['state:get'] = () => ok(extensionState({ person: null, workspaces: [], activeWorkspaceId: null }));
    });

    it('asks the person to sign in on the server it uses', async () => {
      replies['auth:sign-in'] = () => ok({ ok: true });
      await mount();
      expect(heading()).toBe('Sign in to WeldPass');
      expect(text()).toContain('Sign in with your WeldSuite account on app.weldsuite.eu.');

      await click(button('Sign in'));
      expect(sent('auth:sign-in')).toEqual([{ type: 'auth:sign-in' }]);
      expect(document.querySelector('.text-destructive')).toBeNull();
    });

    it('shows that it is signing in until the worker answers', async () => {
      const pending = deferred();
      replies['auth:sign-in'] = () => pending.promise;
      await mount();
      await click(button('Sign in'));
      expect(button('Signing in…').disabled).toBe(true);

      await act(async () => pending.resolve(ok({ ok: false, reason: 'cancelled' })));
      await settle();
      expect(button('Sign in').disabled).toBe(false);
      expect(document.querySelector('.text-destructive')).toBeNull();
    });

    it.each([
      ['unreachable', "The sign-in page couldn't be opened. Check your connection and try again."],
      ['failed', "Signing in didn't work. Try again."],
      ['server', "Can't reach the server. Check your connection and try again."],
    ])('explains a sign-in that ended with %s', async (reason, message) => {
      replies['auth:sign-in'] = () => ok({ ok: false, reason });
      await mount();
      await click(button('Sign in'));
      expect(document.querySelector('.text-destructive')?.textContent).toBe(message);
    });

    it('treats a worker failure as a failed sign-in', async () => {
      replies['auth:sign-in'] = () => failure;
      await mount();
      await click(button('Sign in'));
      expect(document.querySelector('.text-destructive')?.textContent).toBe("Signing in didn't work. Try again.");
    });

    it('links to the server settings', async () => {
      await mount();
      await click(button('Use another server'));
      expect(createTab).toHaveBeenCalledWith({ url: 'chrome-extension://weldpass/settings.html#server' });
    });
  });

  it('waits for the workspaces to load', async () => {
    replies['state:get'] = () =>
      ok(extensionState({ workspaces: [], activeWorkspaceId: null, loadingWorkspaces: true }));
    await mount();
    expect(text()).toContain('Loading your workspaces…');
  });

  it('sends a person without a workspace to the web app', async () => {
    replies['state:get'] = () => ok(extensionState({ workspaces: [], activeWorkspaceId: null }));
    await mount();
    expect(heading()).toBe('No workspace yet');
    await click(button('Open WeldSuite'));
    expect(createTab).toHaveBeenCalledWith({ url: 'https://app.weldsuite.eu' });
  });

  it('lets the person pick a workspace, and stays on the list when that fails', async () => {
    replies['state:get'] = () => ok(extensionState({ workspaces: TWO_WORKSPACES, activeWorkspaceId: null }));
    replies['workspace:set'] = () => failure;
    await mount();
    expect(heading()).toBe('Choose a workspace');

    await click(button('Globex'));
    expect(sent('workspace:set')).toEqual([{ type: 'workspace:set', workspaceId: 'ws_2' }]);
    expect(heading()).toBe('Choose a workspace');

    replies['workspace:set'] = () => ok(extensionState({ workspaces: TWO_WORKSPACES, activeWorkspaceId: 'ws_2' }));
    await click(button('Globex'));
    expect(workspaceSwitch()?.textContent).toBe('Globex');
  });

  it('reloads when the worker says the state changed, and only then', async () => {
    await mount();
    expect(sent('state:get')).toHaveLength(1);

    await broadcast({ type: 'state:changed' }, { id: 'someone-else' });
    await broadcast({ type: 'other' }, { id: 'weldpass' });
    await broadcast(null, { id: 'weldpass' });
    expect(sent('state:get')).toHaveLength(1);

    replies['state:get'] = () => ok(extensionState({ person: null, workspaces: [], activeWorkspaceId: null }));
    await broadcast({ type: 'state:changed' }, { id: 'weldpass' });
    expect(sent('state:get')).toHaveLength(2);
    expect(heading()).toBe('Sign in to WeldPass');

    const mounted = root;
    root = null;
    await act(async () => mounted?.unmount());
    expect(listeners.size).toBe(0);
  });
});

describe('Vault', () => {
  it('shows the logins with a tab for saving, the tools, and settings under the avatar', async () => {
    await mount();
    expect(onLogins()).toBe(true);
    expect(text()).toContain('No logins saved yet.');
    // One workspace: nothing to switch.
    expect(workspaceSwitch()).toBeNull();

    // The generator is one of the tools now.
    await click(button('Tools'));
    // Off the home page the top bar goes; the page's own header leads back.
    expect(onLogins()).toBe(false);
    expect(document.querySelector('button[aria-label="Tools"]')).toBeNull();
    expect(text()).toContain('Data breach scanner');
    const generator = Array.from(document.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.startsWith('Password generator'),
    );
    if (!generator) throw new Error('no generator tool');
    await click(generator);
    expect(text()).toContain('Generated password');
    await click(button('Back to tools'));
    expect(text()).toContain('Password health');
    await click(button('Back to logins'));
    expect(onLogins()).toBe(true);

    // Settings sits in the avatar's menu.
    await act(async () => {
      button('Your account').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    const settings = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent === 'Settings',
    );
    if (!(settings instanceof HTMLElement)) throw new Error('no Settings in the avatar menu');
    await click(settings);
    expect(createTab).toHaveBeenCalledWith({ url: 'chrome-extension://weldpass/settings.html' });
  });

  it('opens the save form and goes back on Cancel', async () => {
    replies['vaults:list'] = () =>
      ok([
        {
          id: 'vault_1',
          kind: 'personal',
          ownerId: 'user_1',
          name: 'Ada',
          description: null,
          createdBy: 'user_1',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          role: 'manager',
        },
      ]);
    await mount();
    // The header's + and the list's "Save login for this site" both open the form.
    await click(button('Save login for this site'));
    expect(onLogins()).toBe(false);
    // No note above the form: it fills in what it can from the page.
    expect(document.querySelector('form [data-slot="alert"]')).toBeNull();

    await click(button('Cancel'));
    expect(onLogins()).toBe(true);

    replies['item:create'] = () => ok({ id: 'item_1' });
    await click(button('Save login for this site'));
    await type(field('Title'), 'Example');
    await click(button('Save login'));
    expect(sent('item:create')).toEqual([
      expect.objectContaining({ type: 'item:create', vaultId: 'vault_1', input: expect.objectContaining({ title: 'Example' }) }),
    ]);
    expect(onLogins()).toBe(true);
    expect(text()).toContain('Login saved.');
    // The lists reload after a save.
    expect(sent('items:list')).toHaveLength(2);
  });

  it('switches workspace from the header, and keeps the old one when that fails', async () => {
    replies['state:get'] = () => ok(extensionState({ workspaces: TWO_WORKSPACES }));
    replies['workspace:set'] = () => failure;
    await mount();
    expect(workspaceSwitch()?.textContent).toBe('Acme');
    expect(workspaceSwitch()?.getAttribute('aria-label')).toBe('Workspace: Acme');

    await pickWorkspace('Globex');
    expect(sent('workspace:set')).toEqual([{ type: 'workspace:set', workspaceId: 'ws_2' }]);
    expect(sent('items:list')).toHaveLength(1);
    expect(workspaceSwitch()?.textContent).toBe('Acme');

    replies['workspace:set'] = () => ok(extensionState({ workspaces: TWO_WORKSPACES, activeWorkspaceId: 'ws_2' }));
    await pickWorkspace('Globex');
    expect(workspaceSwitch()?.textContent).toBe('Globex');
    expect(sent('items:list')).toHaveLength(2);
  });
});
