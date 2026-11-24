// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionState } from '../lib/protocol';
import type { Settings } from '../lib/settings';
import { SettingsPage } from './SettingsPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Message {
  type: string;
  [key: string]: unknown;
}

/** What the worker answers per message type: an envelope, or a promise of one. */
let replies: Record<string, (message: Message) => unknown>;
const sendMessage = vi.fn((message: Message) => {
  const reply = replies[message.type];
  return Promise.resolve(reply ? reply(message) : { ok: false, error: { code: 'unexpected' } });
});
const createTab = vi.fn<(options: { url: string }) => Promise<unknown>>(() => Promise.resolve({}));
const requestPermission = vi.fn<(permissions: { origins: string[] }) => Promise<boolean>>();
const containsPermission = vi.fn<(permissions: { origins: string[] }) => Promise<boolean>>();

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

const OWN_ORIGIN = 'https://weld.example.com';

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
    person: { name: 'Ada Lovelace', email: 'ada@example.com' },
    workspaces: [{ id: 'ws_1', name: 'Acme' }],
    activeWorkspaceId: 'ws_1',
    loadingWorkspaces: false,
    ...overrides,
  };
}

const ownServer = (): ExtensionState =>
  extensionState({}, { origin: OWN_ORIGIN, label: 'weld.example.com', isDefault: false });

let settings: Settings;
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
  await act(async () => created.render(<SettingsPage />));
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

function buttons(name: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('button')).filter(
    (candidate) => candidate.textContent === name || candidate.getAttribute('aria-label') === name,
  );
}

function button(name: string): HTMLButtonElement {
  const [found] = buttons(name);
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

function field(label: string): HTMLInputElement {
  const found = Array.from(document.querySelectorAll('label')).find((candidate) => candidate.textContent === label);
  const input = found ? document.getElementById(found.htmlFor) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error(`no field ${label}`);
  return input;
}

function errors(): string[] {
  return Array.from(document.querySelectorAll('p.border-destructive\\/40')).map((notice) => notice.textContent ?? '');
}

function sent(type: string): Message[] {
  return sendMessage.mock.calls.map(([message]) => message).filter((message) => message.type === type);
}

/** Type an address into "Use your own server" and press Connect. */
async function connect(address: string): Promise<void> {
  await type(field('Use your own server'), address);
  await click(button('Connect'));
}

beforeEach(() => {
  settings = {
    inlineMenus: true,
    savePrompts: true,
    neverMenuHosts: ['menu.example.com'],
    neverSaveHosts: ['save.example.com'],
  };
  replies = {
    'state:get': () => ok(extensionState()),
    'settings:get': () => ok(settings),
    'settings:set': (message) => {
      settings = { ...settings, ...(message.patch as Partial<Settings>) };
      return ok(settings);
    },
  };
  sendMessage.mockClear();
  createTab.mockClear();
  requestPermission.mockReset().mockResolvedValue(true);
  containsPermission.mockReset().mockResolvedValue(true);
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'weldpass',
      sendMessage,
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    tabs: { create: createTab },
    permissions: { request: requestPermission, contains: containsPermission },
  });
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('SettingsPage', () => {
  it('titles the tab and shows a spinner until the worker answers', async () => {
    replies['state:get'] = () => new Promise<never>(() => undefined);
    await mount();
    expect(document.title).toBe('Settings · WeldPass');
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Loading…');
  });

  it('says the background service is unreachable when the settings cannot be read', async () => {
    replies['settings:get'] = () => failure;
    await mount();
    expect(text()).toContain("WeldPass can't reach its background service.");
    expect(text()).not.toContain('Loading…');
    expect(text()).not.toContain('Your account');
  });

  it('says the background service is unreachable when the state cannot be read', async () => {
    replies['state:get'] = () => failure;
    await mount();
    expect(text()).toContain("WeldPass can't reach its background service.");
    expect(text()).not.toContain('Your account');
  });

  describe('account', () => {
    it('names who is signed in, on which server and workspace', async () => {
      await mount();
      expect(text()).toContain('Signed in as ada@example.com on app.weldsuite.eu.');
      expect(text()).toContain('Workspace: Acme');
      expect(buttons('Manage your account')).toHaveLength(0);
    });

    it('falls back to the name, then a dash, and leaves out a workspace it does not know', async () => {
      replies['state:get'] = () =>
        ok(extensionState({ person: { name: 'Ada Lovelace', email: null }, activeWorkspaceId: null }));
      await mount();
      expect(text()).toContain('Signed in as Ada Lovelace on app.weldsuite.eu.');
      expect(text()).not.toContain('Workspace:');

      await act(async () => root?.unmount());
      root = null;
      replies['state:get'] = () => ok(extensionState({ person: { name: null, email: null } }));
      await mount();
      expect(text()).toContain('Signed in as — on app.weldsuite.eu.');
    });

    it('opens the account pages of a provider that has them', async () => {
      replies['state:get'] = () => ok(extensionState({}, { accountUrl: 'https://id.weldsuite.eu/account' }));
      await mount();
      await click(button('Manage your account'));
      expect(createTab).toHaveBeenCalledWith({ url: 'https://id.weldsuite.eu/account' });
    });

    it('signs out, and stays signed in when that fails', async () => {
      replies['auth:sign-out'] = () => failure;
      await mount();
      await click(button('Sign out'));
      expect(sent('auth:sign-out')).toHaveLength(1);
      expect(text()).toContain('Signed in as ada@example.com');

      replies['auth:sign-out'] = () => ok(extensionState({ person: null, workspaces: [], activeWorkspaceId: null }));
      await click(button('Sign out'));
      expect(text()).toContain('Sign in with your WeldSuite account on app.weldsuite.eu.');
    });

    it('signs in from the settings page, showing progress', async () => {
      const pending = deferred();
      replies['state:get'] = () => ok(extensionState({ person: null, workspaces: [], activeWorkspaceId: null }));
      replies['auth:sign-in'] = () => pending.promise;
      await mount();
      await click(button('Sign in'));
      expect(sent('auth:sign-in')).toEqual([{ type: 'auth:sign-in' }]);
      expect(button('Signing in…').disabled).toBe(true);

      await act(async () => pending.resolve(failure));
      await settle();
      expect(button('Sign in').disabled).toBe(false);
    });

    it('cannot sign in while the server has a problem', async () => {
      replies['state:get'] = () =>
        ok(extensionState({ person: null, workspaces: [], activeWorkspaceId: null }, { problem: 'unreachable' }));
      await mount();
      expect(button('Sign in').disabled).toBe(true);
    });
  });

  describe('inline menus and save prompts', () => {
    it('turns inline menus and save prompts off', async () => {
      await mount();
      const menus = field('Show WeldPass in login fields');
      const prompts = field('Offer to save and update logins');
      expect(menus.checked).toBe(true);
      expect(menus.getAttribute('role')).toBe('switch');
      expect(prompts.checked).toBe(true);

      await click(menus);
      expect(sent('settings:set')).toEqual([{ type: 'settings:set', patch: { inlineMenus: false } }]);
      expect(menus.checked).toBe(false);

      await click(prompts);
      expect(sent('settings:set')[1]).toEqual({ type: 'settings:set', patch: { savePrompts: false } });
      expect(prompts.checked).toBe(false);
    });

    it('keeps the switch as it was when saving fails', async () => {
      replies['settings:set'] = () => failure;
      await mount();
      const menus = field('Show WeldPass in login fields');
      await click(menus);
      expect(sent('settings:set')).toHaveLength(1);
      expect(menus.checked).toBe(true);
    });

    it('removes sites from the never-lists', async () => {
      await mount();
      expect(text()).not.toContain('No sites excluded.');

      await click(button('Remove menu.example.com'));
      expect(sent('settings:set')).toEqual([{ type: 'settings:set', patch: { neverMenuHosts: [] } }]);
      await click(button('Remove save.example.com'));
      expect(sent('settings:set')[1]).toEqual({ type: 'settings:set', patch: { neverSaveHosts: [] } });
      expect(text().split('No sites excluded.')).toHaveLength(3);
    });

    it('adds a site where no inline menu shows, ignoring an empty entry', async () => {
      await mount();
      const input = document.querySelector<HTMLInputElement>('input[placeholder="example.com"]');
      if (!input) throw new Error('no site input');
      expect(field('Add site')).toBe(input);

      await type(input, '   ');
      await click(button('Add site'));
      expect(sent('settings:set')).toHaveLength(0);

      await type(input, '  new.example.com ');
      await click(button('Add site'));
      expect(sent('settings:set')).toEqual([
        { type: 'settings:set', patch: { neverMenuHosts: ['menu.example.com', 'new.example.com'] } },
      ]);
      expect(input.value).toBe('');
      expect(button('Remove new.example.com')).toBeTruthy();
    });
  });

  describe('server', () => {
    it('names the default server and offers no way back to it', async () => {
      await mount();
      expect(text()).toContain('WeldPass uses app.weldsuite.eu. (the default)');
      expect(buttons('Use WeldSuite EU again')).toHaveLength(0);
    });

    it('goes back to WeldSuite EU from another server', async () => {
      replies['state:get'] = () => ok(ownServer());
      replies['server:set'] = () => ok({ ok: false, problem: 'unreachable' });
      await mount();
      expect(text()).toContain('WeldPass uses weld.example.com.');
      expect(text()).not.toContain('(the default)');

      await click(button('Use WeldSuite EU again'));
      expect(sent('server:set')).toEqual([{ type: 'server:set', origin: null }]);
      expect(errors()).toEqual(["Can't reach the server. Check your connection and try again."]);

      replies['server:set'] = () => ok({ ok: true, state: extensionState() });
      await click(button('Use WeldSuite EU again'));
      expect(text()).toContain('WeldPass uses app.weldsuite.eu. (the default)');
      expect(errors()).toEqual([]);
    });

    it('shows a server problem as an error', async () => {
      replies['state:get'] = () => ok(extensionState({}, { problem: 'not-weldsuite' }));
      await mount();
      expect(errors()).toEqual([
        "That address isn't a WeldSuite server, or it runs an edition WeldPass can't use.",
      ]);
      expect(buttons('Allow access')).toHaveLength(0);
    });

    describe('missing host access', () => {
      const missingPatterns = ['https://auth.weldsuite.eu/*'];

      it('asks for it and reconnects to the default server', async () => {
        replies['state:get'] = () => ok(extensionState({}, { problem: 'no-permission', missingPatterns }));
        replies['server:set'] = () => ok({ ok: true, state: extensionState() });
        await mount();
        expect(text()).toContain('WeldPass needs your permission to reach this server and its sign-in page.');

        await click(button('Allow access'));
        expect(requestPermission).toHaveBeenCalledWith({ origins: missingPatterns });
        expect(sent('server:set')).toEqual([{ type: 'server:set', origin: null }]);
        expect(buttons('Allow access')).toHaveLength(0);
      });

      it('reconnects to the own server it was on, and says why that failed', async () => {
        replies['state:get'] = () =>
          ok(
            extensionState(
              {},
              { origin: OWN_ORIGIN, label: 'weld.example.com', isDefault: false, problem: 'no-permission', missingPatterns },
            ),
          );
        replies['server:set'] = () => ok({ ok: false, problem: 'no-weldpass' });
        await mount();
        await click(button('Allow access'));
        expect(sent('server:set')).toEqual([{ type: 'server:set', origin: OWN_ORIGIN }]);
        expect(errors()).toEqual(["This server doesn't offer WeldPass."]);
      });

      it('does nothing more when the person declines', async () => {
        replies['state:get'] = () => ok(extensionState({}, { problem: 'no-permission', missingPatterns }));
        requestPermission.mockResolvedValue(false);
        await mount();
        await click(button('Allow access'));
        expect(sent('server:set')).toHaveLength(0);
      });

      it('reconnects without a prompt when nothing is left to grant', async () => {
        replies['state:get'] = () => ok(extensionState({}, { problem: 'no-permission', missingPatterns: [] }));
        replies['server:set'] = () => ok({ ok: true, state: extensionState() });
        await mount();
        await click(button('Allow access'));
        expect(requestPermission).not.toHaveBeenCalled();
        expect(sent('server:set')).toHaveLength(1);
      });
    });

    describe('use your own server', () => {
      it.each([
        ['', "Enter your server's address."],
        ['https://weldsuite', "That isn't a server address."],
        ['http://weld.example.com', 'Use an https address. Plain http only works for localhost.'],
      ])('refuses %j before asking for anything', async (address, message) => {
        await mount();
        await connect(address);
        expect(errors()).toEqual([message]);
        expect(requestPermission).not.toHaveBeenCalled();
      });

      it('takes a bare host, as https', async () => {
        await mount();
        await connect('weld.example.com');
        expect(requestPermission).toHaveBeenCalledWith({ origins: ['https://weld.example.com/*'] });
      });

      it('needs host access to the server first', async () => {
        requestPermission.mockResolvedValue(false);
        await mount();
        await connect(`${OWN_ORIGIN}/app`);
        expect(requestPermission).toHaveBeenCalledWith({ origins: ['https://weld.example.com/*'] });
        expect(sent('server:inspect')).toHaveLength(0);
        expect(errors()).toEqual(['WeldPass needs your permission to reach this server and its sign-in page.']);
      });

      it('treats a failing permission prompt as a refusal', async () => {
        requestPermission.mockRejectedValue(new Error('not in a user gesture'));
        await mount();
        await connect(OWN_ORIGIN);
        expect(errors()).toEqual(['WeldPass needs your permission to reach this server and its sign-in page.']);
      });

      it('says why a server is not usable', async () => {
        replies['server:inspect'] = () => ok({ ok: false, problem: 'no-extension-sign-in' });
        await mount();
        await connect(OWN_ORIGIN);
        expect(sent('server:inspect')).toEqual([{ type: 'server:inspect', origin: OWN_ORIGIN }]);
        expect(errors()[0]).toContain("This server doesn't support signing in from the WeldPass extension yet.");
      });

      it('shows the generic message when the worker fails', async () => {
        replies['server:inspect'] = () => failure;
        await mount();
        await connect(OWN_ORIGIN);
        expect(errors()).toEqual(['Something went wrong. Try again.']);
        expect(button('Connect').disabled).toBe(false);
      });

      it('switches straight away when access to the sign-in server is already granted', async () => {
        replies['server:inspect'] = () =>
          ok({ ok: true, issuer: 'https://id.example.com', patterns: ['https://weld.example.com/*', 'https://id.example.com/*'] });
        replies['server:set'] = () => ok({ ok: true, state: ownServer() });
        await mount();
        await connect(OWN_ORIGIN);
        expect(containsPermission).toHaveBeenCalledTimes(2);
        expect(sent('server:set')).toEqual([{ type: 'server:set', origin: OWN_ORIGIN }]);
        expect(text()).toContain('WeldPass uses weld.example.com.');
        expect(field('Use your own server').value).toBe('');
      });

      it('says why switching failed', async () => {
        replies['server:inspect'] = () => ok({ ok: true, issuer: 'https://id.example.com', patterns: [] });
        replies['server:set'] = () => ok({ ok: false, problem: 'no-permission' });
        await mount();
        await connect(OWN_ORIGIN);
        expect(errors()).toEqual(['WeldPass needs your permission to reach this server and its sign-in page.']);
        expect(field('Use your own server').value).toBe(OWN_ORIGIN);
      });

      it('asks for the sign-in server in a second click, then switches', async () => {
        replies['server:inspect'] = () =>
          ok({ ok: true, issuer: 'https://id.example.com', patterns: ['https://weld.example.com/*', 'https://id.example.com/*'] });
        replies['server:set'] = () => ok({ ok: true, state: ownServer() });
        containsPermission.mockImplementation(async ({ origins }) => origins[0] === 'https://weld.example.com/*');
        await mount();
        await connect(OWN_ORIGIN);
        expect(text()).toContain('This server signs you in at id.example.com. Allow WeldPass to reach that too.');
        expect(sent('server:set')).toHaveLength(0);
        requestPermission.mockClear();

        await click(button('Allow access'));
        expect(requestPermission).toHaveBeenCalledWith({ origins: ['https://id.example.com/*'] });
        expect(sent('server:set')).toEqual([{ type: 'server:set', origin: OWN_ORIGIN }]);
        expect(text()).not.toContain('This server signs you in at');
        expect(text()).toContain('WeldPass uses weld.example.com.');
      });

      it('says access is missing when the second prompt is declined', async () => {
        replies['server:inspect'] = () =>
          ok({ ok: true, issuer: 'https://id.example.com', patterns: ['https://id.example.com/*'] });
        containsPermission.mockResolvedValue(false);
        await mount();
        await connect(OWN_ORIGIN);
        requestPermission.mockResolvedValue(false);
        await click(button('Allow access'));
        expect(sent('server:set')).toHaveLength(0);
        expect(errors()).toEqual(['WeldPass needs your permission to reach this server and its sign-in page.']);
      });
    });
  });
});
