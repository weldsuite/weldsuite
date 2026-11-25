/**
 * How a server function ends. Called from page script (`X-TSR-ServerFn`),
 * it answers with an `ActionResult` or a redirect the router follows. Posted
 * by a plain form (no script), it always redirects with 303, so the browser
 * lands on a page with a GET: back with `?error=CODE`, or on to `next`.
 */

import { isRedirect, redirect } from '@tanstack/react-router';
import { getRequest } from '@tanstack/react-start/server';
import { isStorefrontError } from '@weldsuite/commerce-sdk';
import { errorMessage, isShopLocale, t, type ShopLocale, type ShopStrings } from '@weldsuite/storefront-theme';
import type { ActionResult, ProblemRow } from '../../actions';
import { safePath, withQuery } from '../../paths';

/** Whether page script made the call (the router's fetch sends this header). */
export function fromScript(): boolean {
  return getRequest().headers.get('x-tsr-serverfn') === 'true';
}

/** Go to `href` (a path of the shop, or a payment page). */
export function go(href: string): never {
  throw redirect({ href, statusCode: 303 });
}

/** Success: the result for page script, or a redirect to `next` for a plain form post. */
export function succeeded(next: string, result: Extract<ActionResult, { ok: true }> = { ok: true }): ActionResult {
  if (!fromScript()) go(next);
  return result;
}

/** Failure: the result for page script, or back to `back` with the code for a plain form post. */
export function failed(
  back: string,
  code: string,
  message: string,
  extra: { fieldErrors?: Record<string, string>; problems?: ProblemRow[]; idempotencyKey?: string } = {},
): ActionResult {
  if (!fromScript()) go(withQuery(back, { error: code }));
  return { ok: false, code, message, ...extra };
}

/** A failure for an error the API (or the network) raised. Unknown errors are logged without personal data. */
export function failedWith(back: string, strings: ShopStrings, error: unknown, extra: { fieldErrors?: Record<string, string>; idempotencyKey?: string } = {}): ActionResult {
  // A redirect (`go`, or `succeeded` without script) is how a server function ends, not a failure.
  if (isRedirect(error)) throw error;
  if (isStorefrontError(error)) return failed(back, error.code, errorMessage(strings, error.code), extra);
  console.error('[storefront] action failed:', error instanceof Error ? error.message : 'unknown error');
  return failed(back, 'UNKNOWN', strings.errors.generic, extra);
}

/** The site's language as a shop language (English for anything else). */
export function localeOf(value: string): ShopLocale {
  return isShopLocale(value) ? value : 'en';
}

/** The strings of the shop a request is for. */
export function stringsFor(locale: string): ShopStrings {
  return t(locale);
}

/** A form's text field, trimmed. */
export function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** A whole number between min and max, or null. */
export function wholeNumber(form: FormData, name: string, min: number, max: number): number | null {
  const raw = field(form, name);
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

/** The page a form came from (its `back` field), for the no-script redirect. */
export function backPath(form: FormData, fallback: string): string {
  return safePath(field(form, 'back'), fallback);
}

/** Only form posts reach these server functions. */
export function formData(input: unknown): FormData {
  if (!(input instanceof FormData)) throw new Error('Expected form data');
  return input;
}
