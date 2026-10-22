/**
 * Form validation for the create and edit screens. Each check returns an
 * error key (or null), never a sentence, so the screen can show it in the
 * user's language.
 */

import { interpolate } from './i18n/interpolate';
import type { Translations } from './i18n/locales/en';

export type FieldError = 'required' | 'invalidEmail' | 'invalidDate' | 'invalidNumber';

const WHITESPACE = /\s/;

export function isBlank(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0;
}

/**
 * "local@domain.tld": one "@", no whitespace, a non-empty local part, and a
 * domain with a dot that has something before it and at least two characters
 * after it. Checked with plain string scans so a long input can't make it slow.
 */
export function isValidEmail(value: string): boolean {
  const email = value.trim();
  if (WHITESPACE.test(email)) return false;
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local) return false;
  const dot = domain.indexOf('.', 1);
  return dot !== -1 && domain.length - dot - 1 >= 2;
}

/** A required text field. */
export function checkRequired(value: string | null | undefined): FieldError | null {
  return isBlank(value) ? 'required' : null;
}

/** A required email: present and well formed. */
export function checkRequiredEmail(value: string | null | undefined): FieldError | null {
  if (isBlank(value)) return 'required';
  return isValidEmail(value ?? '') ? null : 'invalidEmail';
}

/** An optional email: only checked when filled in. */
export function checkOptionalEmail(value: string | null | undefined): FieldError | null {
  if (isBlank(value)) return null;
  return isValidEmail(value ?? '') ? null : 'invalidEmail';
}

/** An optional non-negative amount such as a deal value. */
export function checkOptionalAmount(value: string | null | undefined): FieldError | null {
  if (isBlank(value)) return null;
  const parsed = Number(value?.trim().replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? null : 'invalidNumber';
}

/** The amount typed in a text field as a number (comma or point as decimal separator). */
export function parseAmountInput(value: string | null | undefined): number | undefined {
  if (isBlank(value)) return undefined;
  const parsed = Number(value?.trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `undefined` for an empty string, so optional fields are left out of a payload. */
export function optionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The message for a failed check, in the user's language. `field` is the field's label. */
export function describeError(
  t: Pick<Translations, 'validation'>,
  error: FieldError,
  field: string,
): string {
  if (error === 'required') return interpolate(t.validation.required, { field });
  return t.validation[error];
}

// ---------------------------------------------------------------------------
// Whole-form checks. Each returns the failing fields only, so `{}` means valid.
// ---------------------------------------------------------------------------

export type FormErrors<K extends string> = Partial<Record<K, FieldError>>;

function collect<K extends string>(checks: Record<K, FieldError | null>): FormErrors<K> {
  const errors: FormErrors<K> = {};
  for (const key of Object.keys(checks) as K[]) {
    const error = checks[key];
    if (error) errors[key] = error;
  }
  return errors;
}

/** A person needs a first or a last name (flagged on the first name field). */
export function validatePerson(values: {
  firstName: string;
  lastName: string;
  email: string;
}): FormErrors<'firstName' | 'email'> {
  return collect({
    firstName: isBlank(values.firstName) && isBlank(values.lastName) ? 'required' : null,
    email: checkOptionalEmail(values.email),
  });
}

export function validateCompany(values: { name: string; email: string }): FormErrors<'name' | 'email'> {
  return collect({ name: checkRequired(values.name), email: checkOptionalEmail(values.email) });
}

export function validateLead(values: { email: string }): FormErrors<'email'> {
  return collect({ email: checkRequiredEmail(values.email) });
}

/** `dueDate` is the text of the date field: empty is fine, anything else must be a real day. */
export function validateTask(
  values: { title: string; dueDate: string },
  parseDueDate: (input: string) => { error?: 'invalidDate' },
): FormErrors<'title' | 'dueDate'> {
  return collect({
    title: checkRequired(values.title),
    dueDate: parseDueDate(values.dueDate).error ?? null,
  });
}

export function validateDeal(
  values: { name: string; value: string; closeDate: string },
  parseCloseDate: (input: string) => { error?: 'invalidDate' },
): FormErrors<'name' | 'value' | 'closeDate'> {
  return collect({
    name: checkRequired(values.name),
    value: checkOptionalAmount(values.value),
    closeDate: parseCloseDate(values.closeDate).error ?? null,
  });
}

export function validateActivity(values: { subject: string }): FormErrors<'subject'> {
  return collect({ subject: checkRequired(values.subject) });
}
