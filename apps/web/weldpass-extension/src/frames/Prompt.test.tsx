// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptContext } from '../lib/protocol';
import { CLICK_DELAY_MS } from './guard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NONCE = 'fedcba9876543210fedcba9876543210';

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

function context(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    kind: 'save',
    host: 'example.com',
    username: 'ada@example.com',
    itemTitle: null,
    vaults: [{ id: 'vault_personal', name: 'Ada', personal: true }],
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

async function mount(): Promise<void> {
  window.location.hash = `#n=${NONCE}&k=0`;
  vi.resetModules();
  const { Prompt } = await import('./Prompt');
  const container = document.createElement('div');
  document.body.append(container);
  const created = createRoot(container);
  root = created;
  await act(async () => created.render(<Prompt />));
  await settle();
}

/** The bar is visible, uncovered, for longer than the click delay. */
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

async function press(key: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
  await settle();
}

function text(): string {
  return document.body.textContent ?? '';
}

function button(name: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent === name);
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

function iconButton(label: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`no icon button ${label}`);
  return found;
}

function status(): string {
  return document.querySelector('output[aria-live]')?.textContent ?? '';
}

function sent(type: string): Message[] {
  return sendMessage.mock.calls.map(([message]) => message).filter((message) => message.type === type);
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  replies = {
    'prompt:init': () => ok(context()),
    'prompt:save': () => ok({ ok: true }),
    'prompt:update': () => ok({ ok: true }),
    'prompt:never': () => ok({ ok: true }),
    'prompt:dismiss': () => ok({ ok: true }),
  };
  sendMessage.mockClear();
  vi.stubGlobal('chrome', { runtime: { id: 'weldpass', sendMessage } });
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  vi.stubGlobal('IntersectionObserverEntry', FakeIntersectionObserverEntry);
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

describe('Prompt', () => {
  it('asks for its context with the nonce from the frame URL and shows loading meanwhile', async () => {
    replies['prompt:init'] = () => new Promise<never>(() => undefined);
    await mount();
    expect(sent('prompt:init')).toEqual([{ type: 'prompt:init', nonce: NONCE }]);
    expect(text()).toContain('Loading…');
  });

  it('says the login is no longer waiting when the worker has forgotten it', async () => {
    replies['prompt:init'] = () => ok(null);
    await mount();
    expect(text()).toContain('This login is no longer waiting to be saved.');
  });

  it('says the login is no longer waiting when asking fails', async () => {
    replies['prompt:init'] = () => failure;
    await mount();
    expect(text()).toContain('This login is no longer waiting to be saved.');
  });

  it('offers to save into the only vault there is', async () => {
    replies['prompt:init'] = () => ok(context({ vaults: [{ id: 'vault_team', name: 'Team', personal: false }] }));
    await mount();
    expect(document.querySelector('h1')?.textContent).toBe('Save login for example.com?');
    expect(text()).toContain('ada@example.com');
    expect(document.querySelector('select')).toBeNull();

    await showFrame();
    await trustedClick(button('Save login'));
    expect(sent('prompt:save')).toEqual([{ type: 'prompt:save', nonce: NONCE, vaultId: 'vault_team' }]);
    expect(status()).toBe('');
  });

  it('lets the person pick a vault, starting with their personal one', async () => {
    replies['prompt:init'] = () =>
      ok(
        context({
          vaults: [
            { id: 'vault_team', name: 'Team', personal: false },
            { id: 'vault_personal', name: 'Ada', personal: true },
          ],
        }),
      );
    await mount();
    const select = document.querySelector('select');
    if (!select) throw new Error('no vault select');
    expect(select.value).toBe('vault_personal');
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(['Team', 'Personal']);
    expect(document.querySelector(`label[for="${select.id}"]`)?.textContent).toBe('Vault');

    await act(async () => {
      select.value = 'vault_team';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await showFrame();
    await trustedClick(button('Save login'));
    expect(sent('prompt:save')).toEqual([{ type: 'prompt:save', nonce: NONCE, vaultId: 'vault_team' }]);
  });

  it('cannot save without a vault the person may add to', async () => {
    replies['prompt:init'] = () => ok(context({ vaults: [] }));
    await mount();
    expect(text()).toContain("You don't have a vault you can add logins to.");
    expect(button('Save login').disabled).toBe(true);
  });

  it('offers to update a saved login, named by its title or else the host', async () => {
    replies['prompt:init'] = () => ok(context({ kind: 'update', itemTitle: 'Example account', vaults: [] }));
    await mount();
    expect(document.querySelector('h1')?.textContent).toBe('Update the password of Example account?');
    expect(text()).not.toContain("You don't have a vault");

    await showFrame();
    await trustedClick(button('Update'));
    expect(sent('prompt:update')).toEqual([{ type: 'prompt:update', nonce: NONCE }]);
  });

  it('names the host and says there is no username when the update has neither title nor username', async () => {
    replies['prompt:init'] = () => ok(context({ kind: 'update', itemTitle: null, username: '', vaults: [] }));
    await mount();
    expect(document.querySelector('h1')?.textContent).toBe('Update the password of example.com?');
    expect(text()).toContain('No username');
  });

  it('keeps Save looking disabled, and ignores it, until the bar is armed', async () => {
    await mount();
    const save = button('Save login');
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(save.className).toContain('opacity-60');
    await trustedClick(save);
    expect(sent('prompt:save')).toHaveLength(0);

    await showFrame();
    expect(save.getAttribute('aria-disabled')).toBeNull();
    // A script's click is still ignored.
    await click(save);
    expect(sent('prompt:save')).toHaveLength(0);
  });

  it('never asks again for this site, from a trusted click on an armed bar', async () => {
    await mount();
    await click(button('Never for this site'));
    expect(sent('prompt:never')).toHaveLength(0);

    await showFrame();
    await trustedClick(button('Never for this site'));
    expect(sent('prompt:never')).toEqual([{ type: 'prompt:never', nonce: NONCE }]);
  });

  it('dismisses with Not now, the close button or Escape, without the guard', async () => {
    await mount();
    await click(button('Not now'));
    await click(iconButton('Not now'));
    await press('Escape');
    await press('Enter');
    expect(sent('prompt:dismiss')).toEqual([
      { type: 'prompt:dismiss', nonce: NONCE },
      { type: 'prompt:dismiss', nonce: NONCE },
      { type: 'prompt:dismiss', nonce: NONCE },
    ]);
  });

  it('says the login expired when the worker no longer has it', async () => {
    replies['prompt:save'] = () => ok({ ok: false, reason: 'expired' });
    await mount();
    await showFrame();
    await trustedClick(button('Save login'));
    expect(status()).toBe('This login is no longer waiting to be saved.');
  });

  it('shows the generic message for any other outcome or a failure', async () => {
    replies['prompt:save'] = () => ok({ ok: false, reason: 'error' });
    replies['prompt:never'] = () => failure;
    await mount();
    await showFrame();
    await trustedClick(button('Save login'));
    expect(status()).toBe('Something went wrong. Try again.');

    await trustedClick(button('Never for this site'));
    expect(status()).toBe('Something went wrong. Try again.');
  });

  it('acts on one choice at a time', async () => {
    const pending = deferred();
    replies['prompt:never'] = () => pending.promise;
    await mount();
    await showFrame();
    await trustedClick(button('Never for this site'));
    expect(button('Not now').disabled).toBe(true);
    await press('Escape');
    expect(sent('prompt:dismiss')).toHaveLength(0);

    await act(async () => pending.resolve(ok({ ok: true })));
    await settle();
    expect(button('Not now').disabled).toBe(false);
  });
});
