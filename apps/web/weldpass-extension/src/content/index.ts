/**
 * The content script (ADR PASS-009): on `https://*` and `http://localhost`
 * pages, in every frame.
 *
 * What it does:
 * - shows the WeldPass icon in login, sign-up and one-time-code fields, and
 *   opens the inline menu (an extension page in an iframe) from it;
 * - fills what the worker sends after a pick in that menu, for this frame
 *   only, after checking the frame's origin and the fill policy itself;
 * - hands a submitted login to the worker for the save bar, and keeps
 *   nothing of it;
 * - shows the save bar (an extension page in an iframe) in the top frame.
 *
 * What it can't do: ask for a password. No message it may send reveals one.
 */

import { evaluateFill, pageContext } from '../lib/fill-policy';
import { t } from '../lib/i18n';
import type { ContentRequest, ContentResponses, Envelope, FrameCommand, FrameResult } from '../lib/protocol';
import { loginFields, scopeOf, submittedLogin, type LoginFields, type Scope } from './detect';
import { fillLogin, fillNewPasswords, fillOtp } from './fill';
import { FieldIcon, MenuFrame, PromptFrame } from './overlay';

declare global {
  // eslint-disable-next-line no-var
  var __weldpassTeardown: (() => void) | undefined;
}

// A reinstalled or updated extension injects again into open tabs; the old
// copy is orphaned and steps aside.
globalThis.__weldpassTeardown?.();

const extensionId = chrome.runtime.id;
const controller = new AbortController();
const listen = { capture: true, signal: controller.signal } as const;
const isTop = window.top === window;

let inline = false;
let helloAt = 0;
let menu: MenuFrame | null = null;
/** A field the person clicked before it had focus: open its menu once the icon is there. */
let clicked: HTMLInputElement | null = null;
let prompt: PromptFrame | null = null;
const lastCapture = new WeakMap<Scope, number>();

const icon = new FieldIcon(t('inlineOpen'), (keyboard) => void openMenu(keyboard));

function teardown(): void {
  controller.abort();
  icon.hide();
  menu?.remove();
  prompt?.remove();
  menu = null;
  prompt = null;
  chrome.runtime.onMessage.removeListener(onCommand);
}
globalThis.__weldpassTeardown = teardown;

async function send<K extends ContentRequest['type']>(
  message: Extract<ContentRequest, { type: K }>,
): Promise<ContentResponses[K] | null> {
  try {
    const envelope = (await chrome.runtime.sendMessage(message)) as Envelope<ContentResponses[K]> | undefined;
    return envelope?.ok ? envelope.value : null;
  } catch {
    // The extension was reloaded or removed: this copy is orphaned.
    if (!chrome.runtime?.id) teardown();
    return null;
  }
}

async function inlineAllowed(): Promise<boolean> {
  if (Date.now() - helloAt < 5000) return inline;
  helloAt = Date.now();
  inline = (await send({ type: 'content:hello' }))?.inline ?? false;
  return inline;
}

/** The input an event really happened on, inside open shadow roots too. */
function inputOf(event: Event): HTMLInputElement | null {
  const target = event.composedPath()[0];
  return target instanceof HTMLInputElement ? target : null;
}

function ours(event: Event): boolean {
  const path = event.composedPath();
  return path.includes(icon.host) || (menu !== null && path.includes(menu.host)) || (prompt !== null && path.includes(prompt.host));
}

function topOrigin(): string | null {
  if (isTop) return location.origin;
  const ancestors = location.ancestorOrigins;
  return ancestors && ancestors.length > 0 ? (ancestors[ancestors.length - 1] ?? null) : null;
}

// ── the icon and the menu ───────────────────────────────────────────────────

function onFocus(event: FocusEvent): void {
  if (ours(event)) return;
  void considerField(inputOf(event));
}

async function considerField(input: HTMLInputElement | null): Promise<void> {
  const fields = input ? loginFields(input) : null;
  if (!input || !fields) {
    icon.hide();
    closeMenu();
    return;
  }
  if (menu && menu.field !== input) closeMenu();
  if (!(await inlineAllowed())) return;
  // Focus may have moved on while the worker answered (`:focus` matches inside shadow roots too).
  if (!input.matches(':focus')) return;
  icon.show(input);
  if (clicked === input && input.value === '') void openMenu(false);
  clicked = null;
}

async function openMenu(keyboard: boolean): Promise<void> {
  const field = icon.field;
  if (!field || menu) return;
  const fields = loginFields(field);
  if (!fields) return;
  const opened = await send({
    type: 'content:menu-open',
    field: { kind: fields.kind, hasPassword: fields.hasPassword, hasUsername: fields.hasUsername },
    topOrigin: topOrigin(),
  });
  if (!opened || menu || icon.field !== field) return;
  menu = new MenuFrame(opened.nonce, fields.kind, field, keyboard, t('inlineMenuTitle'));
}

function closeMenu(): void {
  if (!menu) return;
  const { nonce } = menu;
  menu.remove();
  menu = null;
  void send({ type: 'content:menu-closed', nonce });
}

function onPointerDown(event: PointerEvent): void {
  if (!event.isTrusted || ours(event)) return;
  const input = inputOf(event);
  if (menu && input !== menu.field) closeMenu();
  // A click in an empty login field opens the menu, as a browser's own autofill does.
  if (input && input === icon.field && input.value === '' && !menu) void openMenu(false);
  else clicked = input;
}

function onKeyDown(event: KeyboardEvent): void {
  if (!event.isTrusted) return;
  if (event.key === 'Escape' && menu) {
    closeMenu();
    return;
  }
  const input = inputOf(event);
  if (event.key === 'ArrowDown' && event.altKey && input && input === icon.field) {
    event.preventDefault();
    void openMenu(true);
    return;
  }
  if (event.key === 'Enter' && input?.type === 'password' && input.value) captureFrom(scopeOf(input));
}

function onInput(event: Event): void {
  // Typing means the person is filling it in themselves.
  if (event.isTrusted && menu && inputOf(event) === menu.field) closeMenu();
}

let frame = 0;
function reposition(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    icon.reposition();
    if (menu && !menu.reposition()) closeMenu();
    prompt?.reposition();
  });
}

// ── capturing a submitted login (2C) ────────────────────────────────────────

function captureFrom(scope: Scope): void {
  const last = lastCapture.get(scope) ?? 0;
  if (Date.now() - last < 1500) return;
  const login = submittedLogin(scope);
  if (!login) return;
  lastCapture.set(scope, Date.now());
  // Handed over and dropped: this frame keeps no copy.
  void send({ type: 'content:capture', username: login.username, password: login.password });
}

function onSubmit(event: Event): void {
  const form = event.composedPath()[0];
  if (form instanceof HTMLFormElement) captureFrom(form);
}

const SUBMIT_TEXT = /log ?in|sign ?in|sign ?up|register|continue|next|submit|save|aanmelden|inloggen|registreren|doorgaan|volgende|opslaan/i;

/** Sign-ins that never submit a form (a button and a fetch) are caught at the click. */
function onClick(event: MouseEvent): void {
  if (!event.isTrusted || ours(event)) return;
  for (const node of event.composedPath()) {
    if (!(node instanceof HTMLElement)) continue;
    const isButton =
      node instanceof HTMLButtonElement ||
      (node instanceof HTMLInputElement && (node.type === 'submit' || node.type === 'button')) ||
      node.getAttribute('role') === 'button';
    if (!isButton) continue;
    const form = (node as HTMLButtonElement).form ?? null;
    const typeSubmit = (node as HTMLButtonElement).type === 'submit';
    const text = `${node.textContent ?? ''} ${(node as HTMLInputElement).value ?? ''} ${node.getAttribute('aria-label') ?? ''}`;
    if (form && typeSubmit) return; // The submit event follows.
    if (!typeSubmit && !SUBMIT_TEXT.test(text)) return;
    const root = node.getRootNode();
    captureFrom(form ?? (root instanceof ShadowRoot ? root : document));
    return;
  }
}

// ── the save bar ────────────────────────────────────────────────────────────

async function checkPrompt(): Promise<void> {
  if (!isTop || prompt) return;
  const pending = await send({ type: 'content:prompt-check' });
  if (!pending || prompt) return;
  prompt = new PromptFrame(pending.nonce, t('promptTitle'));
}

// ── commands from the worker ────────────────────────────────────────────────

function sameOrigin(expected: string): boolean {
  return location.origin !== 'null' && location.origin === expected;
}

function fieldsForMenu(): LoginFields | null {
  return menu?.field.isConnected ? loginFields(menu.field) : null;
}

function handle(command: FrameCommand): FrameResult {
  switch (command.type) {
    case 'fill:login':
    case 'fill:otp': {
      if (!menu || command.nonce !== menu.nonce) return { status: 'refused' };
      if (!sameOrigin(command.expectedOrigin)) return { status: 'origin-mismatch' };
      // The fill policy again, in the frame, on the frame's own URL.
      if (!evaluateFill({ host: command.itemHost }, location.href).ok) return { status: 'refused' };
      const fields = fieldsForMenu();
      if (!fields) return { status: 'no-fields' };
      const filled =
        command.type === 'fill:login'
          ? fillLogin(fields, command.username, command.password)
          : fillOtp(fields, command.code);
      return filled > 0 ? { status: 'filled', fields: filled } : { status: 'no-fields' };
    }
    case 'fill:new-password': {
      if (!menu || command.nonce !== menu.nonce) return { status: 'refused' };
      if (!sameOrigin(command.expectedOrigin)) return { status: 'origin-mismatch' };
      if (!pageContext(location.href).ok) return { status: 'refused' };
      const fields = fieldsForMenu();
      const filled = fields ? fillNewPasswords(fields, command.password) : 0;
      return filled > 0 ? { status: 'filled', fields: filled } : { status: 'no-fields' };
    }
    case 'menu:remove':
      if (menu?.nonce === command.nonce) {
        menu.remove();
        menu = null;
      }
      return { status: 'ok' };
    case 'prompt:remove':
      if (prompt?.nonce === command.nonce) {
        prompt.remove();
        prompt = null;
      }
      return { status: 'ok' };
    case 'prompt:poke':
      void checkPrompt();
      return { status: 'ok' };
  }
}

function onCommand(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (result: FrameResult) => void,
): boolean {
  // Only the worker: it has no tab. Another frame's content script has one.
  if (sender.id !== extensionId || sender.tab) return false;
  if (typeof message !== 'object' || message === null || typeof (message as { type?: unknown }).type !== 'string') {
    return false;
  }
  sendResponse(handle(message as FrameCommand));
  return false;
}

chrome.runtime.onMessage.addListener(onCommand);
document.addEventListener('focusin', onFocus, listen);
document.addEventListener('pointerdown', onPointerDown, listen);
document.addEventListener('keydown', onKeyDown, listen);
document.addEventListener('input', onInput, listen);
document.addEventListener('submit', onSubmit, listen);
document.addEventListener('click', onClick, listen);
window.addEventListener('scroll', reposition, { capture: true, passive: true, signal: controller.signal });
window.addEventListener('resize', reposition, { passive: true, signal: controller.signal });

if (isTop) void checkPrompt();
// A field that already has focus when the script arrives (autofocus).
if (document.activeElement instanceof HTMLInputElement) void considerField(document.activeElement);
