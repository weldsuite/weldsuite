// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuContext, MenuItem } from '../lib/protocol';
import { CLICK_DELAY_MS, moveFocus } from './guard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NONCE = '0123456789abcdef0123456789abcdef';

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

/** IntersectionObserver v2, as far as the click guard uses it. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  constructor(readonly callback: (entries: Array<{ isIntersecting: boolean; isVisible: boolean }>) => void) {
    FakeIntersectionObserver.instances.push(this);
  }
}

class FakeIntersectionObserverEntry {}
Object.defineProperty(FakeIntersectionObserverEntry.prototype, 'isVisible', { value: false });

function supportVisibility(): void {
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  vi.stubGlobal('IntersectionObserverEntry', FakeIntersectionObserverEntry);
}

function item(overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id: 'item_1',
    vaultId: 'vault_1',
    title: 'Example',
    username: 'ada@example.com',
    host: 'example.com',
    hasTotp: false,
    ...overrides,
  };
}

function context(overrides: Partial<MenuContext> = {}): MenuContext {
  return {
    kind: 'login',
    frameOrigin: 'https://example.com',
    crossOrigin: false,
    items: [item()],
    blocked: false,
    ...overrides,
  };
}

let root: Root | null = null;

/** Let the worker's answers (a few promise hops) land. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function mount(keyboard = false): Promise<void> {
  window.location.hash = `#n=${NONCE}&k=${keyboard ? 1 : 0}`;
  vi.resetModules();
  const { Menu } = await import('./Menu');
  const container = document.createElement('div');
  document.body.append(container);
  const created = createRoot(container);
  root = created;
  await act(async () => created.render(<Menu />));
  await settle();
}

/** The frame scrolls into view and stays visible past the click delay. */
async function showFrame(): Promise<void> {
  await act(async () => {
    for (const observer of FakeIntersectionObserver.instances) {
      observer.callback([{ isIntersecting: true, isVisible: true }]);
    }
  });
  await act(async () => {
    vi.advanceTimersByTime(CLICK_DELAY_MS);
  });
}

async function hideFrame(): Promise<void> {
  await act(async () => {
    for (const observer of FakeIntersectionObserver.instances) {
      observer.callback([{ isIntersecting: true, isVisible: false }]);
    }
  });
}

/** jsdom marks every dispatched event untrusted; flip it, as a person's click would be. */
async function trustedClick(element: Element): Promise<void> {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  const impl = Object.getOwnPropertySymbols(event).find((symbol) => symbol.description === 'impl');
  if (!impl) throw new Error('jsdom keeps no event implementation');
  const trust = () => {
    (Reflect.get(event, impl) as { isTrusted: boolean }).isTrusted = true;
  };
  window.addEventListener('click', trust, { capture: true, once: true });
  await act(async () => {
    element.dispatchEvent(event);
  });
  await settle();
}

async function click(element: Element): Promise<void> {
  await act(async () => (element as HTMLElement).click());
  await settle();
}

async function press(key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  await act(async () => {
    document.dispatchEvent(event);
  });
  await settle();
  return event;
}

function text(): string {
  return document.body.textContent ?? '';
}

function button(name: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.includes(name) || candidate.getAttribute('aria-label') === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

function items(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-item]'));
}

function sent(type: string): Message[] {
  return sendMessage.mock.calls.map(([message]) => message).filter((message) => message.type === type);
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  replies = { 'menu:init': () => ok(context()), 'menu:close': () => ok(null) };
  sendMessage.mockClear();
  vi.stubGlobal('chrome', { runtime: { id: 'weldpass', sendMessage } });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Menu', () => {
  it('asks for its context with the nonce from the frame URL and shows loading meanwhile', async () => {
    replies['menu:init'] = () => new Promise<never>(() => undefined);
    await mount();
    expect(sent('menu:init')).toEqual([{ type: 'menu:init', nonce: NONCE }]);
    expect(text()).toContain('Loading…');
  });

  it('says the menu has closed when the worker no longer knows it', async () => {
    replies['menu:init'] = () => ok(null);
    await mount();
    expect(text()).toContain('This menu has closed. Click the field again.');
  });

  it('says the menu has closed when asking for it fails', async () => {
    replies['menu:init'] = () => failure;
    await mount();
    expect(text()).toContain('This menu has closed. Click the field again.');
  });

  it('refuses to offer anything in a browser without trackVisibility', async () => {
    await mount();
    expect(text()).toContain("This browser can't confirm that the menu is visible");
    expect(items()).toHaveLength(0);
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
  });

  describe('with trackVisibility', () => {
    beforeEach(supportVisibility);

    it('explains a frame the fill policy blocks', async () => {
      replies['menu:init'] = () => ok(context({ blocked: true }));
      await mount();
      expect(text()).toContain('For your safety, WeldPass only fills on https pages.');
      expect(items()).toHaveLength(0);
    });

    it('names the frame it fills into when that is another origin than the tab', async () => {
      replies['menu:init'] = () => ok(context({ crossOrigin: true, frameOrigin: 'https://login.example.net:8443' }));
      await mount();
      expect(text()).toContain('Fills into login.example.net:8443, a frame inside this page.');
    });

    it('lists the saved logins, by username, then host, then a dash', async () => {
      replies['menu:init'] = () =>
        ok(
          context({
            items: [
              item({ id: 'a', title: 'Work' }),
              item({ id: 'b', title: 'Shop', username: null, host: 'shop.example.com' }),
              item({ id: 'c', title: 'Bare', username: null, host: null }),
            ],
          }),
        );
      await mount();
      expect(document.querySelector('ul')?.getAttribute('aria-label')).toBe('Saved logins for this site');
      expect(items().map((entry) => entry.textContent)).toEqual([
        'Workada@example.com',
        'Shopshop.example.com',
        'Bare—',
      ]);
    });

    it('says when there are no logins, or no 2FA codes, for the site', async () => {
      replies['menu:init'] = () => ok(context({ items: [] }));
      await mount();
      expect(text()).toContain('No saved logins for this site.');

      await act(async () => root?.unmount());
      root = null;
      document.body.innerHTML = '';
      replies['menu:init'] = () => ok(context({ kind: 'one-time-code', items: [] }));
      await mount();
      expect(text()).toContain('No 2FA codes saved for this site.');
    });

    it('keeps the items disabled until the frame has been visible for the click delay', async () => {
      await mount();
      expect(items()[0].getAttribute('aria-disabled')).toBe('true');
      await trustedClick(items()[0]);
      expect(sent('menu:fill')).toHaveLength(0);

      await showFrame();
      expect(items()[0].getAttribute('aria-disabled')).toBeNull();
    });

    it('fills the picked login after a trusted click', async () => {
      replies['menu:fill'] = () => ok({ ok: true });
      await mount();
      await showFrame();
      await trustedClick(items()[0]);
      expect(sent('menu:fill')).toEqual([{ type: 'menu:fill', nonce: NONCE, itemId: 'item_1', vaultId: 'vault_1' }]);
      expect(document.querySelector('footer output')?.textContent).toBe('');
    });

    it('ignores a click a script made', async () => {
      replies['menu:fill'] = () => ok({ ok: true });
      await mount();
      await showFrame();
      await click(items()[0]);
      expect(sent('menu:fill')).toHaveLength(0);
    });

    it('disarms when the page covers or hides the frame', async () => {
      replies['menu:fill'] = () => ok({ ok: true });
      await mount();
      await showFrame();
      await hideFrame();
      expect(items()[0].getAttribute('aria-disabled')).toBe('true');
      await trustedClick(items()[0]);
      expect(sent('menu:fill')).toHaveLength(0);
    });

    it('fills a 2FA code on a one-time-code field', async () => {
      replies['menu:init'] = () => ok(context({ kind: 'one-time-code', items: [item({ hasTotp: true })] }));
      replies['menu:totp'] = () => ok({ ok: true });
      await mount();
      expect(text()).toContain('2FA code for ada@example.com');
      await showFrame();
      await trustedClick(items()[0]);
      expect(sent('menu:totp')).toEqual([{ type: 'menu:totp', nonce: NONCE, itemId: 'item_1', vaultId: 'vault_1' }]);
    });

    it('shows why a fill did not happen', async () => {
      replies['menu:fill'] = () => ok({ ok: false, reason: 'refused' });
      await mount();
      await showFrame();
      await trustedClick(items()[0]);
      expect(document.querySelector('footer output')?.textContent).toBe('This login belongs to a different site.');
    });

    it('shows the generic message when the worker fails', async () => {
      replies['menu:fill'] = () => failure;
      await mount();
      await showFrame();
      await trustedClick(items()[0]);
      expect(document.querySelector('footer output')?.textContent).toBe('Something went wrong. Try again.');
    });

    it('acts on one pick at a time', async () => {
      const pending = deferred();
      replies['menu:fill'] = () => pending.promise;
      replies['menu:init'] = () => ok(context({ items: [item({ id: 'a' }), item({ id: 'b' })] }));
      await mount();
      await showFrame();
      await trustedClick(items()[0]);
      await trustedClick(items()[1]);
      expect(sent('menu:fill')).toHaveLength(1);
      await act(async () => pending.resolve(ok({ ok: false, reason: 'page-changed' })));
      await settle();
      expect(document.querySelector('footer output')?.textContent).toBe(
        'The page changed while filling. Nothing was filled.',
      );
    });

    it('offers a generated password on a new-password field', async () => {
      replies['menu:init'] = () => ok(context({ kind: 'new-password', items: [] }));
      replies['menu:generated'] = () => ok({ ok: true });
      await mount(true);
      expect(text()).toContain('Generated password');
      expect(text()).toContain('Strong');
      const output = document.querySelector('main output');
      const first = output?.textContent ?? '';
      expect(first).toHaveLength(20);

      await click(button('New password'));
      const second = output?.textContent ?? '';
      expect(second).toHaveLength(20);
      expect(second).not.toBe(first);

      // Not armed yet: nothing is sent.
      await trustedClick(button('Use this password'));
      expect(sent('menu:generated')).toHaveLength(0);

      await showFrame();
      await trustedClick(button('Use this password'));
      expect(sent('menu:generated')).toEqual([{ type: 'menu:generated', nonce: NONCE, password: second }]);
    });

    it('focuses the first item when opened from the keyboard', async () => {
      replies['menu:init'] = () => ok(context({ items: [item({ id: 'a' }), item({ id: 'b' })] }));
      await mount(true);
      expect(document.activeElement).toBe(items()[0]);
    });

    it('leaves focus alone when opened with the mouse', async () => {
      await mount(false);
      expect(document.activeElement).not.toBe(items()[0]);
    });

    it('moves focus with the arrow keys, Home and End', async () => {
      replies['menu:init'] = () =>
        ok(context({ items: [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })] }));
      await mount(true);
      const [first, second, third] = items();

      expect((await press('ArrowDown')).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(second);
      await press('End');
      expect(document.activeElement).toBe(third);
      await press('ArrowDown');
      expect(document.activeElement).toBe(first);
      await press('ArrowUp');
      expect(document.activeElement).toBe(third);
      await press('Home');
      expect(document.activeElement).toBe(first);

      const other = await press('a');
      expect(other.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(first);
    });
  });

  it('closes on Escape and with the close button', async () => {
    await mount();
    await press('Escape');
    await click(button('Close'));
    expect(sent('menu:close')).toEqual([
      { type: 'menu:close', nonce: NONCE },
      { type: 'menu:close', nonce: NONCE },
    ]);
  });

  it('swallows a failure to close', async () => {
    replies['menu:close'] = () => failure;
    await mount();
    await press('Escape');
    expect(sent('menu:close')).toHaveLength(1);
  });
});

describe('moveFocus', () => {
  function list(html: string): HTMLElement {
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.append(container);
    return container;
  }

  function keyEvent(key: string) {
    return { key, preventDefault: vi.fn() };
  }

  it('does nothing without a list, for other keys, or with no enabled items', () => {
    const none = keyEvent('ArrowDown');
    moveFocus(none, null);
    expect(none.preventDefault).not.toHaveBeenCalled();

    const container = list('<button data-item>a</button>');
    const inherited = keyEvent('toString');
    moveFocus(inherited, container);
    expect(inherited.preventDefault).not.toHaveBeenCalled();

    const empty = list('<button data-item disabled>a</button><button>b</button>');
    const down = keyEvent('ArrowDown');
    moveFocus(down, empty);
    expect(down.preventDefault).not.toHaveBeenCalled();
  });

  it('skips disabled items and starts from the top when nothing has focus', () => {
    const container = list(
      '<button data-item id="a">a</button><button data-item disabled>x</button><button data-item id="b">b</button>',
    );
    const down = keyEvent('ArrowDown');
    moveFocus(down, container);
    expect(down.preventDefault).toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('a');
    moveFocus(keyEvent('ArrowDown'), container);
    expect(document.activeElement?.id).toBe('b');
  });
});
