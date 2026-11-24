// @vitest-environment jsdom
/**
 * The content script end to end in jsdom, with `chrome` stubbed.
 *
 * jsdom's own events are never `isTrusted`, and the script ignores untrusted
 * ones. So the test records the listeners the script adds and calls them with
 * event objects it controls, the way a person's clicks and keys would arrive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameCommand, FrameResult } from '../lib/protocol';

type Handler = (event: unknown) => void;
type Command = (message: unknown, sender: chrome.runtime.MessageSender, respond: (result: FrameResult) => void) => void;

const NONCE = 'n'.repeat(32);
const listeners: Array<{ target: EventTarget; type: string; handler: Handler }> = [];
const addEventListener = EventTarget.prototype.addEventListener;

let sent: Array<{ type: string } & Record<string, unknown>> = [];
let answers: Record<string, unknown> = {};
let commandListener: Command | null = null;
let runtimeId: string | undefined = 'weldpass-id';
let failSend = false;

function stubChrome(): void {
  vi.stubGlobal('chrome', {
    runtime: {
      get id() {
        return runtimeId;
      },
      getURL: (path: string) => `chrome-extension://weldpass-id/${path}`,
      sendMessage: vi.fn(async (message: { type: string }) => {
        sent.push(message as { type: string } & Record<string, unknown>);
        if (failSend) throw new Error('Extension context invalidated.');
        return message.type in answers ? { ok: true, value: answers[message.type] } : { ok: false, error: { code: 'x' } };
      }),
      onMessage: {
        addListener: (listener: Command) => {
          commandListener = listener;
        },
        removeListener: (listener: Command) => {
          if (commandListener === listener) commandListener = null;
        },
      },
    },
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function load(): Promise<void> {
  vi.resetModules();
  await import('./index');
  await settle();
}

/** Calls what the script registered for `type` on `target`, as a trusted event unless told otherwise. */
async function fire(target: EventTarget, type: string, event: Record<string, unknown>): Promise<void> {
  const full = { isTrusted: true, composedPath: () => [], preventDefault: vi.fn(), ...event };
  for (const entry of listeners.filter((item) => item.target === target && item.type === type)) {
    entry.handler(full);
  }
  await settle();
}

function command(message: FrameCommand | Record<string, unknown> | string, sender: chrome.runtime.MessageSender = { id: 'weldpass-id' }) {
  let result: FrameResult | undefined;
  commandListener?.(message, sender, (value) => {
    result = value;
  });
  return result;
}

function rect(input: Element, box: { left: number; top: number; width: number; height: number }): void {
  input.getBoundingClientRect = () =>
    ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top }) as DOMRect;
}

function loginPage(): { email: HTMLInputElement; password: HTMLInputElement; form: HTMLFormElement } {
  document.body.innerHTML = `<form>
    <input type="email" name="email" />
    <input type="password" name="password" />
    <button type="submit">Sign in</button>
  </form>`;
  const email = document.querySelector<HTMLInputElement>('[name=email]')!;
  const password = document.querySelector<HTMLInputElement>('[name=password]')!;
  rect(email, { left: 20, top: 40, width: 240, height: 32 });
  rect(password, { left: 20, top: 80, width: 240, height: 32 });
  return { email, password, form: document.querySelector('form')! };
}

const icon = () => document.querySelector('weldpass-icon');
const menuHost = () => document.querySelector('weldpass-menu');
const promptHost = () => document.querySelector('weldpass-prompt');
const types = () => sent.map((message) => message.type);

async function focus(input: HTMLInputElement): Promise<void> {
  input.focus();
  await fire(document, 'focusin', { composedPath: () => [input, input.form, document] });
}

/** Focuses `input` and opens the menu from the icon, as a click on it would. */
async function openMenu(input: HTMLInputElement): Promise<void> {
  await focus(input);
  const button = listeners.find((item) => item.type === 'click' && item.target instanceof HTMLButtonElement);
  button?.handler({ isTrusted: true, detail: 1 });
  await settle();
}

beforeEach(() => {
  listeners.length = 0;
  sent = [];
  answers = { 'content:hello': { inline: true }, 'content:menu-open': { nonce: NONCE }, 'content:prompt-check': null };
  commandListener = null;
  runtimeId = 'weldpass-id';
  failSend = false;
  vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (
    this: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (typeof handler === 'function') listeners.push({ target: this, type, handler: handler as Handler });
    addEventListener.call(this, type, handler, options);
  });
  // jsdom's window has an addEventListener of its own.
  const windowAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(((
    type: string,
    handler: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (typeof handler === 'function') listeners.push({ target: window, type, handler: handler as Handler });
    if (handler) windowAdd(type, handler, options);
  }) as typeof window.addEventListener);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  stubChrome();
});

afterEach(() => {
  globalThis.__weldpassTeardown?.();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the field icon and the inline menu', () => {
  it('shows the icon in a login field once the worker allows inline menus', async () => {
    const { email } = loginPage();
    await load();
    await focus(email);
    expect(types()).toContain('content:hello');
    expect(icon()?.isConnected).toBe(true);
  });

  it('shows nothing when inline menus are off for the site', async () => {
    answers['content:hello'] = { inline: false };
    const { email } = loginPage();
    await load();
    await focus(email);
    expect(icon()).toBeNull();
  });

  it('hides the icon on a field that is none of ours', async () => {
    loginPage();
    document.body.insertAdjacentHTML('beforeend', '<input type="search" name="q" />');
    const search = document.querySelector<HTMLInputElement>('[name=q]')!;
    const email = document.querySelector<HTMLInputElement>('[name=email]')!;
    await load();
    await focus(email);
    expect(icon()).not.toBeNull();
    await focus(search);
    expect(icon()).toBeNull();
  });

  it('opens the menu from the icon, with the field and the top origin', async () => {
    const { password } = loginPage();
    await load();
    await openMenu(password);
    const open = sent.find((message) => message.type === 'content:menu-open');
    expect(open).toMatchObject({
      field: { kind: 'login', hasPassword: true, hasUsername: true },
      topOrigin: location.origin,
    });
    const frame = menuHost();
    expect(frame?.isConnected).toBe(true);
  });

  it('opens the menu on a click in an empty field, and closes it on Escape', async () => {
    const { email } = loginPage();
    await load();
    await focus(email);
    await fire(document, 'pointerdown', { composedPath: () => [email] });
    expect(menuHost()).not.toBeNull();

    await fire(document, 'keydown', { key: 'Escape', composedPath: () => [email] });
    expect(menuHost()).toBeNull();
    expect(types()).toContain('content:menu-closed');
  });

  it('opens the menu after focus when the field was clicked first', async () => {
    const { email } = loginPage();
    await load();
    await fire(document, 'pointerdown', { composedPath: () => [email] });
    await focus(email);
    expect(menuHost()).not.toBeNull();
  });

  it('opens the menu from the keyboard with Alt+ArrowDown', async () => {
    const { email } = loginPage();
    await load();
    await focus(email);
    const preventDefault = vi.fn();
    await fire(document, 'keydown', { key: 'ArrowDown', altKey: true, preventDefault, composedPath: () => [email] });
    expect(preventDefault).toHaveBeenCalled();
    expect(menuHost()).not.toBeNull();
  });

  it('closes the menu when the person types, or clicks somewhere else', async () => {
    const { email } = loginPage();
    await load();
    await openMenu(email);
    await fire(document, 'input', { composedPath: () => [email] });
    expect(menuHost()).toBeNull();

    await openMenu(email);
    await fire(document, 'pointerdown', { composedPath: () => [document.body] });
    expect(menuHost()).toBeNull();
  });

  it('ignores untrusted events and events on its own elements', async () => {
    const { email } = loginPage();
    await load();
    await focus(email);
    await fire(document, 'pointerdown', { isTrusted: false, composedPath: () => [email] });
    await fire(document, 'keydown', { isTrusted: false, key: 'ArrowDown', altKey: true, composedPath: () => [email] });
    expect(menuHost()).toBeNull();
    await fire(document, 'focusin', { composedPath: () => [icon()] });
    expect(icon()).not.toBeNull();
  });

  it('opens no menu when the worker refuses', async () => {
    answers['content:menu-open'] = null;
    const { email } = loginPage();
    await load();
    await openMenu(email);
    expect(menuHost()).toBeNull();
  });

  it('moves the icon and the menu with the page, and drops a menu whose field is gone', async () => {
    const { email, form } = loginPage();
    await load();
    await openMenu(email);
    await fire(window, 'scroll', {});
    expect(menuHost()).not.toBeNull();
    form.remove();
    await fire(window, 'resize', {});
    expect(menuHost()).toBeNull();
    expect(icon()).toBeNull();
  });

  it('considers a field that already has focus when the script arrives', async () => {
    const { email } = loginPage();
    email.focus();
    await load();
    expect(icon()).not.toBeNull();
  });
});

describe('fills from the worker', () => {
  it('fills the login after a pick, for the open menu only', async () => {
    const { email, password } = loginPage();
    await load();
    await openMenu(email);
    const result = command({
      type: 'fill:login',
      nonce: NONCE,
      expectedOrigin: location.origin,
      itemHost: location.hostname,
      username: 'ada@example.com',
      password: 'correct horse',
    });
    expect(result).toEqual({ status: 'filled', fields: 2 });
    expect(email.value).toBe('ada@example.com');
    expect(password.value).toBe('correct horse');
  });

  it('refuses another nonce, another origin, another host and fields that are gone', async () => {
    const { email, form } = loginPage();
    await load();
    await openMenu(email);
    const fill = {
      type: 'fill:login',
      nonce: NONCE,
      expectedOrigin: location.origin,
      itemHost: location.hostname,
      username: 'ada@example.com',
      password: 'pw',
    } as const;
    expect(command({ ...fill, nonce: 'm'.repeat(32) })).toEqual({ status: 'refused' });
    expect(command({ ...fill, expectedOrigin: 'https://evil.example' })).toEqual({ status: 'origin-mismatch' });
    expect(command({ ...fill, itemHost: 'evil.example' })).toEqual({ status: 'refused' });
    form.remove();
    expect(command(fill)).toEqual({ status: 'no-fields' });
    expect(email.value).toBe('');
  });

  it('fills a one-time code', async () => {
    document.body.innerHTML = '<form><input name="otp" autocomplete="one-time-code" /></form>';
    const otp = document.querySelector<HTMLInputElement>('[name=otp]')!;
    rect(otp, { left: 20, top: 40, width: 240, height: 32 });
    await load();
    await openMenu(otp);
    const result = command({
      type: 'fill:otp',
      nonce: NONCE,
      expectedOrigin: location.origin,
      itemHost: location.hostname,
      code: '123456',
    });
    expect(result).toEqual({ status: 'filled', fields: 1 });
    expect(otp.value).toBe('123456');
  });

  it('fills a generated password into new-password fields', async () => {
    document.body.innerHTML = `<form>
      <input type="password" name="new" autocomplete="new-password" />
      <input type="password" name="confirm" autocomplete="new-password" />
    </form>`;
    const fresh = document.querySelector<HTMLInputElement>('[name=new]')!;
    rect(fresh, { left: 20, top: 40, width: 240, height: 32 });
    await load();
    await openMenu(fresh);
    const fill = { type: 'fill:new-password', nonce: NONCE, expectedOrigin: location.origin, password: 'Generated-1' } as const;
    expect(command({ ...fill, expectedOrigin: 'https://evil.example' })).toEqual({ status: 'origin-mismatch' });
    expect(command(fill)).toEqual({ status: 'filled', fields: 2 });
    expect(document.querySelector<HTMLInputElement>('[name=confirm]')!.value).toBe('Generated-1');
  });

  it('removes the menu and the bar when the worker says so', async () => {
    answers['content:prompt-check'] = { nonce: 'p'.repeat(32) };
    const { email } = loginPage();
    await load();
    expect(promptHost()).not.toBeNull();
    await openMenu(email);
    expect(command({ type: 'menu:remove', nonce: 'other' })).toEqual({ status: 'ok' });
    expect(menuHost()).not.toBeNull();
    expect(command({ type: 'menu:remove', nonce: NONCE })).toEqual({ status: 'ok' });
    expect(menuHost()).toBeNull();
    expect(command({ type: 'prompt:remove', nonce: 'p'.repeat(32) })).toEqual({ status: 'ok' });
    expect(promptHost()).toBeNull();
  });

  it('listens to the worker only: not to content scripts, not to malformed messages', async () => {
    loginPage();
    await load();
    expect(command({ type: 'prompt:poke' }, { id: 'weldpass-id', tab: { id: 1 } as chrome.tabs.Tab })).toBeUndefined();
    expect(command({ type: 'prompt:poke' }, { id: 'another-extension' })).toBeUndefined();
    expect(command('prompt:poke')).toBeUndefined();
    expect(command({ type: 'prompt:poke' })).toEqual({ status: 'ok' });
  });
});

describe('the save bar', () => {
  it('shows the bar when a save is pending, and again after a poke', async () => {
    loginPage();
    await load();
    expect(types()).toContain('content:prompt-check');
    expect(promptHost()).toBeNull();

    answers['content:prompt-check'] = { nonce: 'p'.repeat(32) };
    command({ type: 'prompt:poke' });
    await settle();
    const host = promptHost();
    expect(host).not.toBeNull();
    await fire(window, 'resize', {});
    expect((host as HTMLElement).style.getPropertyValue('top')).toBe('12px');
  });
});

describe('capturing a submitted login', () => {
  it('hands a submitted form to the worker once', async () => {
    const { email, password, form } = loginPage();
    await load();
    email.value = 'ada@example.com';
    password.value = 'correct horse';
    await fire(document, 'submit', { composedPath: () => [form] });
    await fire(document, 'submit', { composedPath: () => [form] });
    const captures = sent.filter((message) => message.type === 'content:capture');
    expect(captures).toEqual([{ type: 'content:capture', username: 'ada@example.com', password: 'correct horse' }]);
  });

  it('captures on Enter in a password field', async () => {
    const { email, password } = loginPage();
    await load();
    email.value = 'ada@example.com';
    password.value = 'pw';
    await fire(document, 'keydown', { key: 'Enter', composedPath: () => [password] });
    expect(types()).toContain('content:capture');
  });

  it('captures at the click on a sign-in button with no form, and not at any other button', async () => {
    document.body.innerHTML = `<div>
      <input type="email" name="email" value="ada@example.com" />
      <input type="password" name="password" value="pw" />
      <div role="button" id="go">Log in</div>
      <button id="other">Help</button>
    </div>`;
    await load();
    const other = document.getElementById('other')!;
    await fire(document, 'click', { composedPath: () => [other, document.body] });
    expect(types()).not.toContain('content:capture');
    const go = document.getElementById('go')!;
    await fire(document, 'click', { composedPath: () => [document.createTextNode('Log in'), go, document.body] });
    expect(sent.find((message) => message.type === 'content:capture')).toMatchObject({ username: 'ada@example.com' });
  });

  it('leaves a submit button in a form to the submit event', async () => {
    const { email, password, form } = loginPage();
    await load();
    email.value = 'ada@example.com';
    password.value = 'pw';
    await fire(document, 'click', { composedPath: () => [form.querySelector('button'), form] });
    expect(types()).not.toContain('content:capture');
  });

  it('sends nothing for a form with nothing filled in', async () => {
    const { form } = loginPage();
    await load();
    await fire(document, 'submit', { composedPath: () => [form] });
    expect(types()).not.toContain('content:capture');
  });
});

describe('an orphaned copy', () => {
  it('steps aside when the extension was reloaded', async () => {
    const { email } = loginPage();
    await load();
    expect(commandListener).not.toBeNull();
    failSend = true;
    runtimeId = undefined;
    await focus(email);
    expect(commandListener).toBeNull();
    expect(icon()).toBeNull();
  });

  it('tears down the copy before it when injected again', async () => {
    loginPage();
    await load();
    const first = commandListener;
    await load();
    expect(commandListener).not.toBe(first);
    expect(commandListener).not.toBeNull();
  });
});
