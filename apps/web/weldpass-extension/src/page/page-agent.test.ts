// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pageAgent, type PageCommand, type PageResult } from './page-agent';

/**
 * `chrome.scripting.executeScript({ func })` ships the function as source text
 * and evaluates it in the page. This rebuilds it the same way, so a reference
 * to anything outside its own body (an import, a module-level helper) fails
 * here with a ReferenceError instead of in someone's browser.
 */
const serialized = new Function(`return (${pageAgent.toString()});`)() as typeof pageAgent;

const origin = () => window.location.origin;

/** `Omit` that keeps the union apart, so each command keeps its own fields. */
type WithoutOrigin<T> = T extends unknown ? Omit<T, 'expectedOrigin'> : never;

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`no input #${id}`);
  return element;
}

describe.each([
  ['as written', pageAgent],
  ['rebuilt from its source text', serialized],
])('pageAgent (%s)', (_name, agent) => {
  const run = (command: WithoutOrigin<PageCommand>, expectedOrigin = origin()) =>
    agent({ ...command, expectedOrigin } as PageCommand);
  const fill = (username: string, password: string | null): PageResult =>
    run({ kind: 'fill-login', username, password });

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('origin check', () => {
    it('touches nothing when the page is not the origin the popup validated', () => {
      document.body.innerHTML = `<form><input id="u" type="text"><input id="p" type="password"></form>`;

      expect(run({ kind: 'fill-login', username: 'ada', password: 's3cret' }, 'https://evil.example')).toEqual({
        status: 'origin-mismatch',
      });
      expect(input('u').value).toBe('');
      expect(input('p').value).toBe('');
    });

    it('does not read from a different origin either', () => {
      document.body.innerHTML = `<form><input id="u" value="ada"><input type="password" value="pw"></form>`;
      expect(run({ kind: 'read-login' }, 'https://evil.example')).toEqual({ status: 'origin-mismatch' });
    });
  });

  describe('fill-login', () => {
    it('fills the username and password of a plain login form', () => {
      document.body.innerHTML = `
        <form><input id="u" type="text" name="login"><input id="p" type="password"></form>`;

      expect(fill('ada', 's3cret')).toEqual({
        status: 'filled',
        username: true,
        password: true,
        passwordFields: 1,
      });
      expect(input('u').value).toBe('ada');
      expect(input('p').value).toBe('s3cret');
    });

    it('dispatches bubbling input and change events', () => {
      document.body.innerHTML = `<form id="f"><input id="u" type="email"><input id="p" type="password"></form>`;
      const seen: string[] = [];
      for (const type of ['input', 'change']) {
        document.getElementById('f')?.addEventListener(type, (event) => {
          seen.push(`${type}:${(event.target as HTMLInputElement).id}`);
        });
      }

      fill('ada@example.com', 's3cret');
      expect(seen).toEqual(['input:u', 'change:u', 'input:p', 'change:p']);
    });

    it('goes through the native value setter, past a framework-style instance override', () => {
      document.body.innerHTML = `<form><input id="u" type="text"><input id="p" type="password"></form>`;
      const password = input('p');
      // React shadows `value` on the element to track what it last rendered.
      const intercepted = vi.fn();
      Object.defineProperty(password, 'value', { configurable: true, set: intercepted, get: () => 'stale' });

      fill('ada', 's3cret');

      expect(intercepted).not.toHaveBeenCalled();
      const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      expect(native?.get?.call(password)).toBe('s3cret');
    });

    it('picks the nearest text field before the password', () => {
      document.body.innerHTML = `
        <form>
          <input id="company" type="text" name="company">
          <input id="email" type="email" name="mail">
          <input id="p" type="password">
          <input id="after" type="text" name="captcha-answer">
        </form>`;

      fill('ada@example.com', 's3cret');
      expect(input('email').value).toBe('ada@example.com');
      expect(input('company').value).toBe('');
      expect(input('after').value).toBe('');
    });

    it('prefers a field the page marked as the username over a nearer one', () => {
      document.body.innerHTML = `
        <form>
          <input id="u" type="text" autocomplete="username">
          <input id="tenant" type="text" name="tenant">
          <input id="p" type="password">
        </form>`;

      fill('ada', 's3cret');
      expect(input('u').value).toBe('ada');
      expect(input('tenant').value).toBe('');
    });

    it('stays inside the form of the password field', () => {
      document.body.innerHTML = `
        <form><input id="newsletter" type="email" name="newsletter"></form>
        <form><input id="p" type="password"></form>`;

      expect(fill('ada', 's3cret')).toMatchObject({ status: 'filled', username: false, password: true });
      expect(input('newsletter').value).toBe('');
      expect(input('p').value).toBe('s3cret');
    });

    it('uses the nearest preceding field in the document when there is no form', () => {
      document.body.innerHTML = `
        <div><input id="u" type="text"></div>
        <div><input id="p" type="password"></div>`;

      expect(fill('ada', 's3cret')).toMatchObject({ username: true, password: true });
      expect(input('u').value).toBe('ada');
    });

    it('skips hidden, disabled and read-only fields', () => {
      document.body.innerHTML = `
        <form>
          <input id="hidden-type" type="hidden" name="username">
          <input id="invisible" type="text" style="display:none">
          <div style="display:none"><input id="in-hidden-parent" type="text"></div>
          <input id="cloaked" type="text" style="visibility:hidden">
          <input id="disabled" type="text" disabled>
          <input id="readonly" type="text" readonly>
          <input id="u" type="text">
          <input id="decoy" type="password" style="display:none">
          <input id="p" type="password">
        </form>`;

      fill('ada', 's3cret');
      expect(input('u').value).toBe('ada');
      expect(input('p').value).toBe('s3cret');
      for (const id of ['invisible', 'in-hidden-parent', 'cloaked', 'disabled', 'readonly', 'decoy']) {
        expect(input(id).value).toBe('');
      }
    });

    it('never treats a search box as the username', () => {
      document.body.innerHTML = `
        <input id="q" type="text" name="q" placeholder="Search">
        <div role="search"><input id="site-search" type="text"></div>
        <input id="p" type="password">`;

      expect(fill('ada', 's3cret')).toMatchObject({ username: false, password: true });
      expect(input('q').value).toBe('');
      expect(input('site-search').value).toBe('');
    });

    it('fills only the username on the first step of a two-step login', () => {
      document.body.innerHTML = `<form><input id="u" type="email" name="identifier"><button>Next</button></form>`;

      expect(fill('ada@example.com', 's3cret')).toEqual({
        status: 'filled',
        username: true,
        password: false,
        passwordFields: 0,
      });
      expect(input('u').value).toBe('ada@example.com');
    });

    it('fills only the password on the second step', () => {
      document.body.innerHTML = `
        <form><input type="hidden" name="identifier" value="ada@example.com"><input id="p" type="password"></form>`;

      expect(fill('ada@example.com', 's3cret')).toMatchObject({ username: false, password: true });
      expect(input('p').value).toBe('s3cret');
    });

    it('leaves the password field alone when asked for the username only', () => {
      document.body.innerHTML = `<form><input id="u" type="text"><input id="p" type="password"></form>`;

      expect(fill('ada', null)).toMatchObject({ username: true, password: false });
      expect(input('p').value).toBe('');
    });

    it('does not put a saved password into a sign-up form', () => {
      document.body.innerHTML = `
        <form>
          <input id="p1" type="password" autocomplete="new-password">
          <input id="p2" type="password" autocomplete="new-password">
        </form>`;

      expect(fill('', 's3cret')).toEqual({ status: 'no-fields' });
      expect(input('p1').value).toBe('');
    });

    it('prefers the current-password field of a change-password form', () => {
      document.body.innerHTML = `
        <form>
          <input id="other" type="password">
          <input id="current" type="password" autocomplete="current-password">
          <input id="new" type="password" autocomplete="new-password">
        </form>`;

      fill('', 's3cret');
      expect(input('current').value).toBe('s3cret');
      expect(input('other').value).toBe('');
      expect(input('new').value).toBe('');
    });

    it('reports a page without a login form', () => {
      document.body.innerHTML = `<p>Hello</p><textarea></textarea>`;
      expect(fill('ada', 's3cret')).toEqual({ status: 'no-fields' });
    });
  });

  describe('probe', () => {
    it('reports the fields without touching them', () => {
      document.body.innerHTML = `<form><input id="u" type="text"><input id="p" type="password"></form>`;
      expect(run({ kind: 'probe' })).toEqual({ status: 'probed', hasUsername: true, hasPassword: true });
      expect(input('u').value).toBe('');
    });

    it('sees a username-only step', () => {
      document.body.innerHTML = `<form><input type="email" name="email"></form>`;
      expect(run({ kind: 'probe' })).toEqual({ status: 'probed', hasUsername: true, hasPassword: false });
    });

    it('sees nothing on a page with no login form', () => {
      document.body.innerHTML = `<input type="text" name="q">`;
      expect(run({ kind: 'probe' })).toEqual({ status: 'probed', hasUsername: false, hasPassword: false });
    });
  });

  describe('read-login', () => {
    it('returns what is typed in the form', () => {
      document.body.innerHTML = `
        <form><input type="text" value="ada"><input type="password" value="s3cret"></form>`;

      expect(run({ kind: 'read-login' })).toEqual({
        status: 'read',
        username: 'ada',
        password: 's3cret',
        hasPasswordField: true,
      });
    });

    it('reads the password field that has a value', () => {
      document.body.innerHTML = `
        <form>
          <input type="email" value="ada@example.com">
          <input type="password" value="new-pw" autocomplete="new-password">
          <input type="password" value="">
        </form>`;

      expect(run({ kind: 'read-login' })).toMatchObject({ username: 'ada@example.com', password: 'new-pw' });
    });

    it('returns page text as plain strings and caps their length', () => {
      document.body.innerHTML = `<form><input id="u" type="text"><input id="p" type="password"></form>`;
      input('u').value = '<img src=x onerror=alert(1)>';
      input('p').value = 'x'.repeat(5000);

      const result = run({ kind: 'read-login' });
      expect(result).toMatchObject({ status: 'read', username: '<img src=x onerror=alert(1)>' });
      expect(result.status === 'read' && result.password.length).toBe(4096);
    });

    it('returns empty strings when the page has no login form', () => {
      document.body.innerHTML = `<p>Hello</p>`;
      expect(run({ kind: 'read-login' })).toEqual({
        status: 'read',
        username: '',
        password: '',
        hasPasswordField: false,
      });
    });
  });

  describe('fill-new-password', () => {
    const fillNew = () => run({ kind: 'fill-new-password', password: 'Gen3rated!' });

    it('fills every field marked new-password and nothing else', () => {
      document.body.innerHTML = `
        <form>
          <input id="current" type="password" autocomplete="current-password">
          <input id="new" type="password" autocomplete="new-password">
          <input id="confirm" type="password" autocomplete="new-password">
        </form>`;

      expect(fillNew()).toMatchObject({ status: 'filled', passwordFields: 2 });
      expect(input('current').value).toBe('');
      expect(input('new').value).toBe('Gen3rated!');
      expect(input('confirm').value).toBe('Gen3rated!');
    });

    it('fills password and confirmation on an unmarked sign-up form', () => {
      document.body.innerHTML = `
        <form><input id="a" type="password"><input id="b" type="password"></form>`;

      expect(fillNew()).toMatchObject({ passwordFields: 2 });
      expect(input('a').value).toBe('Gen3rated!');
      expect(input('b').value).toBe('Gen3rated!');
    });

    it('leaves the first of three unmarked fields (the current password) alone', () => {
      document.body.innerHTML = `
        <form>
          <input id="a" type="password"><input id="b" type="password"><input id="c" type="password">
        </form>`;

      expect(fillNew()).toMatchObject({ passwordFields: 2 });
      expect(input('a').value).toBe('');
      expect(input('c').value).toBe('Gen3rated!');
    });

    it('never overwrites a field marked current-password', () => {
      document.body.innerHTML = `<form><input id="current" type="password" autocomplete="current-password"></form>`;
      expect(fillNew()).toEqual({ status: 'no-fields' });
      expect(input('current').value).toBe('');
    });

    it('reports a page without password fields', () => {
      document.body.innerHTML = `<form><input type="text"></form>`;
      expect(fillNew()).toEqual({ status: 'no-fields' });
    });
  });
});
