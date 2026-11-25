/**
 * Putting values into a page's fields the way typing would. Frameworks that
 * control their inputs (React, Vue) ignore a plain `input.value = x`: the
 * prototype's setter bypasses their bookkeeping, and the events make them
 * read the new value.
 */

import type { LoginFields } from './detect';

export function setValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  input.focus();
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** A saved login. `password: null` fills the username only (step one of a two-step login). */
export function fillLogin(fields: LoginFields, username: string, password: string | null): number {
  let filled = 0;
  if (fields.username && username) {
    setValue(fields.username, username);
    filled += 1;
  }
  // Password last, so it is the field left focused.
  if (fields.password && password !== null) {
    setValue(fields.password, password);
    filled += 1;
  }
  return filled;
}

/** A one-time code into one field, or one digit per box. */
export function fillOtp(fields: LoginFields, code: string): number {
  const boxes = fields.otp;
  if (boxes.length === 0) return 0;
  if (boxes.length > 1 && boxes.length >= code.length) {
    [...code].forEach((digit, index) => setValue(boxes[index]!, digit));
    return code.length;
  }
  setValue(boxes[0]!, code);
  return 1;
}

/** A generated password into every new-password field (the password and its confirmation). */
export function fillNewPasswords(fields: LoginFields, password: string): number {
  for (const input of fields.newPasswords) setValue(input, password);
  return fields.newPasswords.length;
}
