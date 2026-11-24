/**
 * Finding login, sign-up and one-time-code fields. Pure DOM: tested on jsdom.
 *
 * A field reached through an event is the event's composed path target, so a
 * field inside an open shadow root is found like any other; its form (or its
 * shadow root, without one) is the scope the other fields are looked up in.
 *
 * The heuristics are the popup page agent's (`src/page/page-agent.ts`): the
 * page's `autocomplete` tokens first, then field types, names and order.
 */

import type { FieldContext, FieldKind } from '../lib/protocol';

export type Scope = HTMLFormElement | Document | ShadowRoot;

export interface LoginFields extends FieldContext {
  /** Where the login goes: its form, or the document or shadow root without one. */
  scope: Scope;
  username: HTMLInputElement | null;
  /** The current-password field a saved login fills. */
  password: HTMLInputElement | null;
  /** Sign-up and change-password fields a generated password fills. */
  newPasswords: HTMLInputElement[];
  /** One field, or one box per digit. */
  otp: HTMLInputElement[];
}

const TEXTLIKE = new Set(['text', 'email', 'tel', '']);
const OTP_NAME = /one.?time|otp|totp|2fa|mfa|two.?factor|verification.?code|auth(entication)?.?code|security.?code|^code$|token/i;
const NEW_PASSWORD_HINT = /new|confirm|repeat|again|retype|verify|register|sign.?up|create|nieuw|herhaal|bevestig/i;
const NOT_USERNAME = /search|query|zoek|otp|captcha|coupon|promo|voucher/;
const USERNAME_HINT = /user|e-?mail|login|identifier|account|gebruiker/i;

function tokens(input: HTMLInputElement): string[] {
  return (input.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

function label(input: HTMLInputElement): string {
  return `${input.name} ${input.id} ${input.placeholder} ${input.getAttribute('aria-label') ?? ''}`;
}

/** Shown, enabled and big enough to be a real field (honeypots are often 0×0 or 1×1). */
export function isUsable(input: HTMLInputElement): boolean {
  if (input.disabled || input.readOnly || input.type === 'hidden') return false;
  if (typeof input.checkVisibility === 'function') {
    if (!input.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return false;
  } else {
    for (let node: HTMLElement | null = input; node; node = node.parentElement) {
      if (node.hidden) return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
  }
  // jsdom (tests) has no layout; a real page always does.
  if (input.ownerDocument.documentElement.clientWidth > 0) {
    const rect = input.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
  }
  return true;
}

export function inputsIn(scope: Scope): HTMLInputElement[] {
  return Array.from(scope.querySelectorAll('input')).filter(isUsable);
}

export function scopeOf(input: HTMLInputElement): Scope {
  if (input.form) return input.form;
  const root = input.getRootNode();
  return root instanceof ShadowRoot ? root : input.ownerDocument;
}

function isPassword(input: HTMLInputElement): boolean {
  return input.type === 'password';
}

function isOtp(input: HTMLInputElement): boolean {
  if (tokens(input).includes('one-time-code')) return true;
  if (!['text', 'tel', 'number', ''].includes(input.type)) return false;
  if (!OTP_NAME.test(label(input))) return false;
  const max = input.maxLength;
  return input.inputMode === 'numeric' || max === 1 || (max >= 4 && max <= 10) || /otp|totp|2fa|one.?time/i.test(label(input));
}

function hasUsernameHint(input: HTMLInputElement): boolean {
  const list = tokens(input);
  return list.includes('username') || list.includes('email') || list.includes('webauthn');
}

/** A text-like field that could hold a username: not a search box, not an OTP box. */
function isUsernameCandidate(input: HTMLInputElement): boolean {
  if (!TEXTLIKE.has(input.type)) return false;
  if (hasUsernameHint(input)) return true;
  if (isOtp(input)) return false;
  if (input.getAttribute('role') === 'searchbox' || input.closest('[role="search"]')) return false;
  return input.name !== 'q' && !NOT_USERNAME.test(label(input).toLowerCase());
}

function looksLikeUsername(input: HTMLInputElement): boolean {
  return input.type === 'email' || hasUsernameHint(input) || USERNAME_HINT.test(`${input.name} ${input.id}`);
}

function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/**
 * Which password fields are for a new password. Marked ones when the page
 * marks any; otherwise a form with two unmarked password fields is a sign-up
 * (password and confirmation) and one with three is a change of password
 * (current, new, confirmation), unless its labels say otherwise.
 */
function splitPasswords(passwords: HTMLInputElement[]): { current: HTMLInputElement[]; fresh: HTMLInputElement[] } {
  const marked = passwords.filter((input) => tokens(input).includes('new-password'));
  const current = passwords.filter((input) => tokens(input).includes('current-password'));
  if (marked.length > 0 || current.length > 0) {
    return {
      fresh: marked,
      current: passwords.filter((input) => !marked.includes(input)),
    };
  }
  if (passwords.length >= 3) return { current: passwords.slice(0, 1), fresh: passwords.slice(1) };
  if (passwords.length === 2) {
    const [first, second] = passwords as [HTMLInputElement, HTMLInputElement];
    if (NEW_PASSWORD_HINT.test(label(second)) || NEW_PASSWORD_HINT.test(label(first))) {
      return { current: [], fresh: passwords };
    }
  }
  return { current: passwords, fresh: [] };
}

/** The username that goes with a password: the nearest candidate before it, preferring a marked one. */
function usernameFor(password: HTMLInputElement, inputs: HTMLInputElement[]): HTMLInputElement | null {
  const candidates = inputs.filter(isUsernameCandidate);
  const before = candidates.filter((candidate) => precedes(candidate, password));
  const hinted = before.filter(hasUsernameHint);
  return hinted[hinted.length - 1] ?? before[before.length - 1] ?? candidates.find(hasUsernameHint) ?? null;
}

/** The username field of a step that shows no password yet (step one of two). */
function loneUsername(inputs: HTMLInputElement[], focused: HTMLInputElement | null): HTMLInputElement | null {
  const candidates = inputs.filter(isUsernameCandidate);
  if (focused && candidates.includes(focused) && looksLikeUsername(focused)) return focused;
  return candidates.find(hasUsernameHint) ?? candidates.find(looksLikeUsername) ?? null;
}

/** Everything a fill needs around one field, or null when the field is none of ours. */
export function loginFields(field: HTMLInputElement): LoginFields | null {
  const scope = scopeOf(field);
  if (!isUsable(field)) return null;
  const inputs = inputsIn(scope);

  const passwords = inputs.filter(isPassword);
  const { current, fresh } = splitPasswords(passwords);
  const otp = inputs.filter(isOtp);

  let kind: FieldKind | null = null;
  if (otp.includes(field)) kind = 'one-time-code';
  else if (fresh.includes(field)) kind = 'new-password';
  else if (current.includes(field)) kind = 'login';
  else if (isUsernameCandidate(field)) {
    // A username in a sign-up form is the person's to choose: no menu.
    if (current.length > 0) kind = 'login';
    else if (fresh.length === 0 && looksLikeUsername(field)) kind = 'login';
  }
  if (!kind) return null;

  const focusedPassword = current.includes(field) ? field : null;
  const password =
    focusedPassword ?? current.find((input) => tokens(input).includes('current-password')) ?? current[0] ?? null;
  const username = password ? usernameFor(password, inputs) : loneUsername(inputs, field);

  return {
    kind,
    scope,
    username,
    password,
    newPasswords: fresh,
    otp: otp.length > 1 ? otp.filter((input) => input.maxLength === 1) : otp,
    hasPassword: password !== null,
    hasUsername: username !== null,
  };
}

/**
 * What a submitted form holds, for the save prompt: the new password when the
 * form sets one, else the current one, and the username before it.
 */
export function submittedLogin(scope: Scope): { username: string; password: string } | null {
  const inputs = inputsIn(scope);
  const passwords = inputs.filter(isPassword).filter((input) => input.value !== '');
  const { current, fresh } = splitPasswords(inputs.filter(isPassword));
  const filledFresh = fresh.filter((input) => input.value !== '');
  const password = filledFresh[0] ?? current.find((input) => input.value !== '') ?? passwords[0] ?? null;
  const username = password ? usernameFor(password, inputs) : loneUsername(inputs, null);
  if (!password && !username?.value) return null;
  return {
    username: (username?.value ?? '').trim().slice(0, 255),
    password: (password?.value ?? '').slice(0, 4096),
  };
}
