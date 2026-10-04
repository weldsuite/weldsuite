/**
 * The one function this extension ever runs inside a web page.
 *
 * It is handed to `chrome.scripting.executeScript({ func })`, which serializes
 * it with `toString()` and evaluates that source in the page's isolated world.
 * So it must be SELF-CONTAINED: no imports at runtime, no references to
 * anything outside its own body, no helpers hoisted to module scope. Types are
 * fine (they are erased). `page-agent.test.ts` runs every case against a copy
 * rebuilt from `pageAgent.toString()`, which fails if that rule is broken.
 *
 * Arguments and the return value cross the extension/page boundary as JSON.
 */

export type PageCommand =
  /** Which login fields the page has. Touches nothing. */
  | { kind: 'probe'; expectedOrigin: string }
  /** `password: null` fills the username only (the first step of a two-step login). */
  | { kind: 'fill-login'; expectedOrigin: string; username: string; password: string | null }
  /** What is typed in the page's login form right now, for "Save login". */
  | { kind: 'read-login'; expectedOrigin: string }
  /** Put a generated password into the page's new-password field(s). */
  | { kind: 'fill-new-password'; expectedOrigin: string; password: string };

export type PageResult =
  /** The tab is no longer on the origin the popup validated. Nothing was touched. */
  | { status: 'origin-mismatch' }
  | { status: 'no-fields' }
  | { status: 'probed'; hasUsername: boolean; hasPassword: boolean }
  | { status: 'filled'; username: boolean; password: boolean; passwordFields: number }
  | { status: 'read'; username: string; password: string; hasPasswordField: boolean };

export function pageAgent(command: PageCommand): PageResult {
  // Last line of defence against a navigation between the popup's host check
  // and this injection: refuse to act on any origin but the validated one.
  if (window.location.origin !== command.expectedOrigin) {
    return { status: 'origin-mismatch' };
  }

  // jsdom (tests) has no layout; a real page always does.
  const hasLayout = document.documentElement.clientWidth > 0;

  function isVisible(el: HTMLElement): boolean {
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return false;
    } else {
      const visibility = getComputedStyle(el).visibility;
      if (visibility === 'hidden' || visibility === 'collapse') return false;
      for (let node: HTMLElement | null = el; node; node = node.parentElement) {
        if (node.hidden || getComputedStyle(node).display === 'none') return false;
      }
    }
    if (hasLayout) {
      // Honeypots and pre-rendered steps are often 0×0 or 1×1.
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
    }
    return true;
  }

  function usableInputs(scope: ParentNode): HTMLInputElement[] {
    return Array.from(scope.querySelectorAll('input')).filter(
      (input) => !input.disabled && !input.readOnly && isVisible(input),
    );
  }

  function autocompleteTokens(input: HTMLInputElement): string[] {
    return (input.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  }

  function isPassword(input: HTMLInputElement): boolean {
    return input.type === 'password';
  }

  function hasUsernameHint(input: HTMLInputElement): boolean {
    const tokens = autocompleteTokens(input);
    return tokens.includes('username') || tokens.includes('email');
  }

  /** A text-like field that could hold a username: not a search box, not an OTP box. */
  function isUsernameCandidate(input: HTMLInputElement): boolean {
    if (!['text', 'email', 'tel'].includes(input.type)) return false;
    if (hasUsernameHint(input)) return true;

    if (autocompleteTokens(input).includes('one-time-code')) return false;
    if (input.getAttribute('role') === 'searchbox' || input.closest('[role="search"]')) return false;

    const label = `${input.name} ${input.id} ${input.placeholder}`.toLowerCase();
    return input.name !== 'q' && !/search|query|zoek|otp|captcha|coupon|promo/.test(label);
  }

  function looksLikeUsername(input: HTMLInputElement): boolean {
    return (
      input.type === 'email' ||
      /user|e-?mail|login|identifier|account|gebruiker/i.test(`${input.name} ${input.id}`)
    );
  }

  function precedes(a: Element, b: Element): boolean {
    return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }

  /**
   * The password field a saved login belongs in. New-password fields are for
   * sign-up and change-password forms and are never a target for a saved one.
   */
  function findLoginPassword(): HTMLInputElement | null {
    const pool = usableInputs(document)
      .filter(isPassword)
      .filter((input) => !autocompleteTokens(input).includes('new-password'));
    return (
      pool.find((input) => input === document.activeElement) ??
      pool.find((input) => autocompleteTokens(input).includes('current-password')) ??
      pool[0] ??
      null
    );
  }

  /**
   * The username that goes with a password field: the nearest text field before
   * it in the same form, preferring one the page marked as a username. A
   * password inside a form with no such field is the second step of a two-step
   * login, and gets no username rather than a guess from elsewhere on the page.
   */
  function findUsernameFor(password: HTMLInputElement): HTMLInputElement | null {
    const candidates = usableInputs(password.form ?? document).filter(isUsernameCandidate);
    const before = candidates.filter((candidate) => precedes(candidate, password));
    const hintedBefore = before.filter(hasUsernameHint);
    return (
      hintedBefore[hintedBefore.length - 1] ??
      before[before.length - 1] ??
      candidates.find(hasUsernameHint) ??
      null
    );
  }

  /** The username field of a page that shows no password yet (step one of two). */
  function findLoneUsername(): HTMLInputElement | null {
    const candidates = usableInputs(document).filter(isUsernameCandidate);
    const focused = candidates.find((input) => input === document.activeElement);
    if (focused && (hasUsernameHint(focused) || looksLikeUsername(focused))) return focused;

    const inForms = candidates.filter((input) => input.form);
    return (
      candidates.find(hasUsernameHint) ??
      candidates.find(looksLikeUsername) ??
      (inForms.length === 1 ? inForms[0] : null)
    );
  }

  /**
   * Set a value the way typing would. Frameworks that control their inputs
   * (React, Vue) ignore a plain `input.value = x`: the prototype's setter
   * bypasses their bookkeeping, and the events make them read the new value.
   */
  function setValue(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    input.focus();
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  if (command.kind === 'probe') {
    const password = findLoginPassword();
    const username = password ? findUsernameFor(password) : findLoneUsername();
    return { status: 'probed', hasUsername: username !== null, hasPassword: password !== null };
  }

  if (command.kind === 'fill-login') {
    const password = findLoginPassword();
    const username = password ? findUsernameFor(password) : findLoneUsername();

    const fillUsername = username !== null && command.username !== '';
    const fillPassword = password !== null && command.password !== null;
    if (!fillUsername && !fillPassword) return { status: 'no-fields' };

    if (fillUsername) setValue(username, command.username);
    // Password last, so it is the field left focused.
    if (fillPassword) setValue(password, command.password ?? '');
    return {
      status: 'filled',
      username: fillUsername,
      password: fillPassword,
      passwordFields: fillPassword ? 1 : 0,
    };
  }

  if (command.kind === 'read-login') {
    const passwords = usableInputs(document).filter(isPassword);
    const password = passwords.find((input) => input.value !== '') ?? passwords[0] ?? null;
    const username = password ? findUsernameFor(password) : findLoneUsername();
    return {
      status: 'read',
      username: (username?.value ?? '').slice(0, 255),
      password: (password?.value ?? '').slice(0, 4096),
      hasPasswordField: password !== null,
    };
  }

  // fill-new-password
  const passwords = usableInputs(document).filter(isPassword);
  const marked = passwords.filter((input) => autocompleteTokens(input).includes('new-password'));
  const notCurrent = passwords.filter(
    (input) => !autocompleteTokens(input).includes('current-password'),
  );
  let targets: HTMLInputElement[];
  if (marked.length > 0) targets = marked;
  else if (notCurrent.length < passwords.length) targets = notCurrent;
  // current + new + confirm, unmarked: leave the first one alone.
  else if (passwords.length >= 3) targets = passwords.slice(1);
  else targets = passwords;

  if (targets.length === 0) return { status: 'no-fields' };
  for (const target of targets) setValue(target, command.password);
  return { status: 'filled', username: false, password: true, passwordFields: targets.length };
}
