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

const PERSONAL_VAULT = {
  id: 'vault_1',
  kind: 'personal',
  ownerId: 'user_1',
  name: 'Ada',
  description: null,
  createdBy: 'user_1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  role: 'manager',
};

/** A saved login as the worker lists it: GitHub, unless overridden. */
function login(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item_1',
    vaultId: 'vault_1',
    type: 'login',
    title: 'GitHub',
    subtitle: 'ada',
    url: 'https://github.com/login',
    host: 'github.com',
    hasTotp: false,
    passwordChangedAt: null,
    version: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The login with its secret fields, as `item:reveal` answers. */
function revealed(password: string) {
  return { ...login(), fields: { username: 'ada', password } };
}

/** A 2FA code that is valid for another `seconds`. */
function totpCode(seconds = 20) {
  return { code: '123456', period: 30, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
}

/** A notification as the worker lists it. */
function notification(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    userId: 'user_1',
    title: `Notification ${id}`,
    body: null,
    category: null,
    notificationType: 'weldpass.shared',
    actionUrl: null,
    entityType: null,
    entityId: null,
    icon: null,
    severity: 'info',
    data: null,
    isRead: false,
    readAt: null,
    actorType: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const writeText = vi.fn<(text: string) => Promise<void>>();

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

/** A key pressed on `target`, by default where the focus is, as the person types. */
async function press(key: string, target: Element = document.activeElement ?? document.body): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await settle();
}

/** A button whose text starts with `text`, for rows that say more than their name. */
function buttonStartingWith(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.startsWith(text),
  );
  if (!found) throw new Error(`no button starting with ${text}`);
  return found;
}

/** The status line at the bottom of the popup. */
function status(): string {
  return document.querySelector('[role="status"]')?.textContent ?? '';
}

/** The toolbar's search field, while it is open. */
function search(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[aria-label="Search logins"]');
}

/** The login rows' titles, top to bottom. */
function rowTitles(): string[] {
  return Array.from(document.querySelectorAll('li span.truncate.font-medium')).map((title) => title.textContent ?? '');
}

/** Opens a menu from the keyboard: ArrowDown opens it, Enter would toggle. */
async function openMenu(trigger: Element): Promise<void> {
  // Let a previous menu hand the focus back first (see pickWorkspace).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await press('ArrowDown', trigger);
}

function menuItem(name: string): HTMLElement {
  const found = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
    (candidate) => candidate.textContent === name,
  );
  if (!(found instanceof HTMLElement)) throw new Error(`no menu item ${name}`);
  return found;
}

/**
 * The popup opened on a tab at `url`, whose page answers the form filler with
 * `answer`. Call before mounting: the popup looks the tab up once.
 */
function openOn(url: string, answer: (command: { kind: string }) => unknown = () => ({ status: 'no-fields' })) {
  const stub = globalThis.chrome as unknown as { tabs: Record<string, unknown>; scripting?: unknown };
  stub.tabs.query = () => Promise.resolve([{ id: 7, url }]);
  stub.tabs.get = () => Promise.resolve({ id: 7, url });
  const executeScript = vi.fn(({ args }: { args: [{ kind: string }] }) =>
    Promise.resolve([{ result: answer(args[0]) }]),
  );
  stub.scripting = { executeScript };
  return executeScript;
}

/** A page with a login form where only the username field shows (step one of two). */
function usernameStep(command: { kind: string }) {
  return command.kind === 'probe'
    ? { status: 'probed', hasUsername: true, hasPassword: false }
    : { status: 'filled', username: true, password: false, passwordFields: 0 };
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
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
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
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'clipboard');
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

  it('searches as you type on the list, but not over the details page of a login', async () => {
    replies['items:list'] = () => ok([login()]);
    await mount();

    // The details page covers the list, and the focus stays on the row.
    const row = button('Open GitHub');
    await act(async () => row.focus());
    await click(row);
    expect(text()).toContain('History');
    await press('g');
    expect(search()).toBeNull();

    // Back on the list, typing opens the search with that letter.
    await click(button('Back'));
    expect(text()).not.toContain('History');
    await press('g');
    expect(search()?.value).toBe('g');
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

describe('Logins', () => {
  it('fills, copies and opens a login from its row', async () => {
    const executeScript = openOn('https://github.com/login', usernameStep);
    replies['items:match'] = () => ok([login({ hasTotp: true })]);
    replies['items:list'] = () => ok([login({ hasTotp: true })]);
    replies['item:reveal'] = () => ok(revealed('s3cret'));
    replies['item:totp'] = () => ok(totpCode());
    await mount();
    expect(text()).toContain('For github.com');
    // Listed for the page, so not again under All logins.
    expect(rowTitles()).toEqual(['GitHub']);

    await click(button('Fill GitHub'));
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(status()).toBe('Filled the username. Continue to the password step, then press Fill again.');

    await click(button('Copy username'));
    expect(writeText).toHaveBeenLastCalledWith('ada');
    expect(status()).toBe('Username copied.');
    await click(button('Copy password'));
    expect(writeText).toHaveBeenLastCalledWith('s3cret');
    expect(status()).toBe('Password copied.');
    await click(button('Copy 2FA code'));
    expect(writeText).toHaveBeenLastCalledWith('123456');
    expect(status()).toMatch(/^2FA code copied\./);
    await click(button('Open site'));
    expect(createTab).toHaveBeenLastCalledWith({ url: 'https://github.com/login' });

    // A copy the browser refuses, a login without a password and an API
    // failure each end in a status line.
    writeText.mockRejectedValueOnce(new Error('denied'));
    await click(button('Copy username'));
    expect(status()).toBe("Couldn't copy to the clipboard.");
    replies['item:reveal'] = () => ok(revealed(''));
    await click(button('Copy password'));
    expect(status()).toBe('This login has no password.');
    replies['item:totp'] = () => failure;
    await click(button('Copy 2FA code'));
    expect(document.querySelector('[role="status"]')?.className).toContain('text-destructive');
  });

  it('searches from the toolbar: Enter fills the first match, Escape clears and then closes', async () => {
    const executeScript = openOn('https://github.com/login', usernameStep);
    replies['items:list'] = () =>
      ok([
        login(),
        login({ id: 'item_2', title: 'Figma', subtitle: 'ada@figma.com', url: 'https://figma.com/', host: 'figma.com' }),
      ]);
    await mount();

    await press('f');
    expect(search()?.value).toBe('f');
    expect(text()).toContain('Results');
    expect(rowTitles()).toEqual(['Figma']);

    await type(search()!, 'zzz');
    expect(text()).toContain('No logins match your search.');
    // The × clears the text and keeps the field open.
    await click(button('Clear search'));
    expect(search()?.value).toBe('');

    await type(search()!, 'git');
    expect(rowTitles()).toEqual(['GitHub']);
    await press('Enter', search()!);
    expect(executeScript).toHaveBeenCalled();

    await press('Escape', search()!);
    expect(search()?.value).toBe('');
    await press('Escape', search()!);
    expect(search()).toBeNull();

    // The search button opens it; leaving it empty closes it again.
    await click(button('Search logins'));
    expect(search()).not.toBeNull();
    await act(async () => search()!.blur());
    await settle();
    expect(search()).toBeNull();
  });

  it('sorts the logins by name, and clears the sort', async () => {
    replies['items:list'] = () => ok([login({ id: 'b', title: 'Beta' }), login({ id: 'a', title: 'Alpha' })]);
    await mount();
    // By name until sorted otherwise.
    expect(rowTitles()).toEqual(['Alpha', 'Beta']);

    await openMenu(button('Sort'));
    await press('ArrowRight', menuItem('Name'));
    await click(menuItem('Descending'));
    expect(rowTitles()).toEqual(['Beta', 'Alpha']);
    expect(button('Sort').className).toContain('bg-primary/10');

    await openMenu(button('Sort'));
    await press('ArrowRight', menuItem('Name'));
    await click(menuItem('Ascending'));
    expect(rowTitles()).toEqual(['Alpha', 'Beta']);

    await openMenu(button('Sort'));
    await press('ArrowRight', menuItem('Name'));
    await click(menuItem('Descending'));
    await openMenu(button('Sort'));
    await click(menuItem('Clear sort'));
    expect(rowTitles()).toEqual(['Alpha', 'Beta']);
    expect(button('Sort').className).not.toContain('bg-primary/10');
  });

  it('says why a list has nothing, and retries one that failed', async () => {
    openOn('http://example.com/login');
    replies['items:list'] = () => failure;
    await mount();
    // Logins never go into a plain http page: a warning instead of the page's logins.
    expect(text()).not.toContain('For example.com');
    expect(document.querySelector('[data-slot="alert"]')?.className).toContain('text-amber-700');

    replies['items:list'] = () => ok([login()]);
    await click(button('Try again'));
    expect(rowTitles()).toEqual(['GitHub']);
  });

  it('retries the logins for the page when they fail', async () => {
    openOn('https://github.com/login');
    replies['items:match'] = () => failure;
    await mount();
    replies['items:match'] = () => ok([]);
    await click(button('Try again'));
    expect(text()).toContain('No saved logins for this site.');
  });

  it('shows the site icon from the favicon cache, and a globe when it does not load', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    replies['items:list'] = () => ok([login()]);
    await mount();
    const icon = document.querySelector<HTMLImageElement>('li img');
    expect(icon?.getAttribute('src')).toBe(
      'chrome-extension://weldpass//_favicon/?pageUrl=https%3A%2F%2Fgithub.com%2Flogin&size=32',
    );
    await act(async () => icon?.dispatchEvent(new Event('load')));
    expect(document.querySelector('li img')?.className).toBe('size-5');
    await act(async () => icon?.dispatchEvent(new Event('error')));
    expect(document.querySelector('li img')).toBeNull();
  });
});

describe('Login details', () => {
  it('shows the username, the password on request, the 2FA code, the website and the vault', async () => {
    const executeScript = openOn('https://github.com/login', usernameStep);
    replies['items:list'] = () => ok([login({ hasTotp: true, passwordChangedAt: '2026-02-01T10:00:00.000Z' })]);
    replies['vaults:list'] = () => ok([PERSONAL_VAULT]);
    replies['item:reveal'] = () => ok(revealed('s3cret'));
    replies['item:totp'] = () => ok(totpCode());
    await mount();
    await click(button('Open GitHub'));
    // The details page comes before the list, so its buttons are found first.
    expect(text()).toContain('Personal');
    expect(text()).not.toContain('s3cret');

    await click(button('Show password'));
    expect(text()).toContain('s3cret');
    await click(button('Copy password'));
    expect(writeText).toHaveBeenLastCalledWith('s3cret');
    // The password on screen is copied, not fetched again.
    expect(sent('item:reveal')).toHaveLength(1);
    await click(button('Hide password'));
    expect(text()).not.toContain('s3cret');
    await click(button('Copy password'));
    expect(sent('item:reveal')).toHaveLength(2);
    await click(button('Copy username'));
    expect(writeText).toHaveBeenLastCalledWith('ada');

    await click(button('Show code'));
    expect(text()).toContain('123 456');
    await click(button('Copy 2FA code'));
    expect(writeText).toHaveBeenLastCalledWith('123456');
    // The countdown runs every second.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1050));
    });
    expect(text()).toMatch(/1[89]s/);

    await click(button('https://github.com/login'));
    expect(createTab).toHaveBeenLastCalledWith({ url: 'https://github.com/login' });
    createTab.mockClear();
    await click(button('Open site'));
    expect(createTab).toHaveBeenCalledWith({ url: 'https://github.com/login' });

    await click(button('Fill'));
    expect(executeScript).toHaveBeenCalledTimes(2);

    // Failures end in a status line, and a login without a password says so.
    replies['item:reveal'] = () => ok(revealed(''));
    await click(button('Copy password'));
    expect(status()).toBe('This login has no password.');
    await click(button('Show password'));
    expect(status()).toBe('This login has no password.');
    replies['item:reveal'] = () => failure;
    await click(button('Show password'));
    expect(document.querySelector('[role="status"]')?.className).toContain('text-destructive');
  });

  it('hides a 2FA code once it has run out', async () => {
    replies['items:list'] = () => ok([login({ hasTotp: true })]);
    replies['item:totp'] = () => ok(totpCode(0));
    await mount();
    await click(button('Open GitHub'));
    await click(button('Show code'));
    expect(text()).not.toContain('123 456');
    expect(button('Show code')).toBeTruthy();
  });

  it('lists the versions, newest first, and says when there are none', async () => {
    replies['items:list'] = () => ok([login({ url: null, host: null, subtitle: null })]);
    replies['item:versions'] = () =>
      ok([
        { id: 'v1', version: 1, action: 'created', createdBy: null, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'v3', version: 3, action: 'archived', createdBy: null, createdAt: 'not a date' },
        { id: 'v2', version: 2, action: 'updated', createdBy: null, createdAt: '2026-02-01T00:00:00.000Z' },
      ]);
    await mount();
    await click(button('Open GitHub'));
    // No website: nothing to open.
    expect(document.querySelector('button[aria-label="Open site"]')).toBeNull();

    await click(button('History'));
    const versions = Array.from(document.querySelectorAll('li')).map((row) => row.textContent ?? '');
    expect(versions[0]).toContain('archived');
    expect(versions[0]).toContain('current');
    expect(versions[0]).toContain('Version 3');
    expect(versions[1]).toContain('Updated');
    expect(versions[2]).toContain('Created');
    await click(button('Details'));
    expect(text()).toContain('Username');
  });

  it('retries a history that failed, and says when it is empty', async () => {
    replies['items:list'] = () => ok([login()]);
    replies['item:versions'] = () => failure;
    await mount();
    await click(button('Open GitHub'));
    await click(button('History'));
    replies['item:versions'] = () => ok([]);
    await click(button('Try again'));
    expect(text()).toContain('No earlier versions.');
  });
});

describe('Notifications', () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  it('lists them, marks them read, and opens only links on the server', async () => {
    replies['notifications:list'] = () =>
      ok({
        items: [
          notification('n1', { actionUrl: '/weldpass/passwords', body: 'Ada shared a login', createdAt: minutesAgo(5) }),
          notification('n2', { actionUrl: 'https://evil.example/', isRead: true, createdAt: minutesAgo(180) }),
          notification('n3', { title: null, actionUrl: 'http://[', isRead: true, createdAt: minutesAgo(60 * 24 * 3) }),
          notification('n4', { isRead: true, createdAt: minutesAgo(60 * 24 * 30) }),
          notification('n5', { isRead: true, createdAt: 'not a date' }),
        ],
        unread: 1,
      });
    replies['notifications:read'] = () => ok(notification('n1', { isRead: true }));
    replies['notifications:read-all'] = () => ok({ updated: 1 });
    await mount();

    await click(button('Notifications, 1 unread'));
    expect(onLogins()).toBe(false);
    expect(text()).toContain('Ada shared a login');
    expect(text()).toContain('5 min. ago');
    expect(text()).toContain('3 hr. ago');
    expect(text()).toContain('3 days ago');
    expect(text()).toContain('4 wk. ago');
    expect(text()).toContain('Just now');
    // No title: the notification's type names it.
    expect(text()).toContain('weldpass.shared');

    await click(buttonStartingWith('Notification n1'));
    expect(sent('notifications:read')).toEqual([{ type: 'notifications:read', id: 'n1' }]);
    expect(createTab).toHaveBeenLastCalledWith({ url: 'https://app.weldsuite.eu/weldpass/passwords' });
    createTab.mockClear();
    // Another site's link, or one that isn't a link, opens nothing; read ones aren't marked again.
    await click(buttonStartingWith('Notification n2'));
    await click(buttonStartingWith('weldpass.shared'));
    expect(createTab).not.toHaveBeenCalled();
    expect(sent('notifications:read')).toHaveLength(1);

    await click(button('Mark all as read'));
    expect(sent('notifications:read-all')).toHaveLength(1);
    await click(button('Back to logins'));
    expect(onLogins()).toBe(true);
  });

  it('counts more than nine as 9+, and says when there are none', async () => {
    replies['notifications:list'] = () => ok({ items: [], unread: 12 });
    await mount();
    expect(button('Notifications, 12 unread').textContent).toBe('9+');
    await click(button('Notifications, 12 unread'));
    expect(text()).toContain("You're all caught up.");
  });

  it('retries the list when it fails', async () => {
    replies['notifications:list'] = () => failure;
    await mount();
    await click(button('Notifications'));
    replies['notifications:list'] = () => ok({ items: [], unread: 0 });
    await click(button('Try again'));
    expect(text()).toContain("You're all caught up.");
    expect(document.querySelector('button[aria-label="Mark all as read"]')).toBeNull();
  });
});

describe('Tools', () => {
  it('shows the password health report, and links to fixing it in WeldSuite', async () => {
    replies['health:get'] = () =>
      ok({
        checked: 3,
        healthy: 1,
        weak: 1,
        reused: 2,
        old: 1,
        items: [
          { ...login(), issues: ['reused', 'weak'], reuseCount: 2 },
          { ...login({ id: 'item_2', title: 'Figma', subtitle: null, host: null }), issues: ['old'], reuseCount: 1 },
        ],
      });
    await mount();
    await click(button('Tools'));
    // The breach scanner isn't built yet.
    const breach = buttonStartingWith('Data breach scanner');
    expect(breach.disabled).toBe(true);
    expect(breach.textContent).toContain('Coming soon');

    await click(buttonStartingWith('Password health'));
    expect(text()).toContain('1/3');
    const issues = Array.from(document.querySelectorAll('li')).map((row) => row.textContent ?? '');
    // Weak first, as on the platform.
    expect(issues[0]).toMatch(/GitHub.*Weak.*Reused on 2 logins/);
    expect(issues[1]).toMatch(/Figma—Old/);

    await click(button('Fix in WeldSuite'));
    expect(createTab).toHaveBeenCalledWith({ url: 'https://app.weldsuite.eu/weldpass/passwords/health' });
  });

  it('says when nothing is checked or all is healthy, and retries a failure', async () => {
    replies['health:get'] = () => failure;
    await mount();
    await click(button('Tools'));
    await click(buttonStartingWith('Password health'));
    replies['health:get'] = () => ok({ checked: 0, healthy: 0, weak: 0, reused: 0, old: 0, items: [] });
    await click(button('Try again'));
    expect(text()).toContain('Add logins with a password and they will be checked here.');

    replies['health:get'] = () => ok({ checked: 2, healthy: 2, weak: 0, reused: 0, old: 0, items: [] });
    await click(button('Back to tools'));
    await click(buttonStartingWith('Password health'));
    expect(text()).toContain('All passwords look healthy.');
    expect(document.querySelector('button[aria-label="Fix in WeldSuite"]')).toBeNull();
  });

  it('generates a password: regenerate, length and character classes', async () => {
    await mount();
    await click(button('Tools'));
    await click(buttonStartingWith('Password generator'));
    const output = () => document.querySelector('output')?.textContent ?? '';
    const first = output();
    await click(button('New password'));
    expect(output()).not.toBe(first);

    const slider = document.querySelector<HTMLElement>('[role="slider"]')!;
    const before = output().length;
    await press('ArrowRight', slider);
    expect(output()).toHaveLength(before + 1);

    const checkbox = document.querySelector<HTMLButtonElement>('button[role="checkbox"]')!;
    const checked = checkbox.getAttribute('aria-checked');
    await click(checkbox);
    expect(checkbox.getAttribute('aria-checked')).not.toBe(checked);
  });
});

describe('Account menu', () => {
  it('opens the web app and the account, and signs out', async () => {
    replies['state:get'] = () =>
      ok(extensionState({ person: { name: 'Ada Lovelace', email: 'ada@example.com' } }, { accountUrl: 'https://auth.weldsuite.eu/ui/console' }));
    replies['auth:sign-out'] = () => ok(extensionState({ person: null }));
    await mount();
    expect(button('Your account').textContent).toBe('AL');

    await openMenu(button('Your account'));
    expect(text()).toContain('ada@example.com');
    await click(menuItem('Open WeldSuite'));
    expect(createTab).toHaveBeenLastCalledWith({ url: 'https://app.weldsuite.eu' });
    await openMenu(button('Your account'));
    await click(menuItem('Manage your account'));
    expect(createTab).toHaveBeenLastCalledWith({ url: 'https://auth.weldsuite.eu/ui/console' });
    await openMenu(button('Your account'));
    await click(menuItem('Sign out'));
    expect(sent('auth:sign-out')).toHaveLength(1);
    expect(document.querySelector('button[aria-label="Your account"]')).toBeNull();
  });

  it('shows the initial of the email address without a name', async () => {
    replies['state:get'] = () => ok(extensionState({ person: { name: null, email: 'grace@example.com' } }));
    replies['auth:sign-out'] = () => failure;
    await mount();
    expect(button('Your account').textContent).toBe('G');
    await openMenu(button('Your account'));
    await click(menuItem('Sign out'));
    // A failed sign-out keeps the person signed in.
    expect(button('Your account')).toBeTruthy();
  });
});

describe('Save login', () => {
  it('fills in what the page holds, and shows the password on request', async () => {
    openOn('https://github.com/login', (command) =>
      command.kind === 'read-login'
        ? { status: 'read', username: 'ada', password: 's3cret', hasPasswordField: true }
        : { status: 'no-fields' },
    );
    replies['vaults:list'] = () => ok([PERSONAL_VAULT]);
    await mount();
    await click(button('Save login for this site'));
    expect(field('Username').value).toBe('ada');
    const password = field('Password');
    expect(password.value).toBe('s3cret');
    expect(password.type).toBe('password');
    await click(button('Show password'));
    expect(password.type).toBe('text');
  });
});
