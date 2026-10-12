/**
 * Reading and explaining WeldReach API failures.
 *
 * reach-api answers `{ error: { code, message, details? } }`. Three codes get
 * a screen of their own or a dedicated message:
 *  - `APP_ACCESS_REQUIRED` (403): the workspace has no approved access (still
 *    pending, rejected, suspended or revoked); `details.status` says which;
 *  - `PAYMENT_METHOD_REQUIRED` (402): creating a mailbox needs a card on file;
 *  - `DOMAIN_HAS_MAILBOXES` (409): a domain cannot be disconnected yet.
 */

import { isApiError } from '@weldsuite/api-client';
import type { AppAccessStatus } from '@weldsuite/app-api-client/schemas/reach';
import { apiErrorCode, apiErrorDetails } from '@/lib/partner/api-errors';

type Translate = (path: string, params?: Record<string, unknown>) => string;

const ACCESS_STATUSES: readonly string[] = ['requested', 'approved', 'rejected', 'suspended', 'revoked'];

/** The module worker refused the request because the workspace is not approved. */
export function isAppAccessRequiredError(err: unknown): boolean {
  return apiErrorCode(err) === 'APP_ACCESS_REQUIRED';
}

/** The status behind a 403 APP_ACCESS_REQUIRED (`none` when the workspace never asked). */
export function appAccessRequiredStatus(err: unknown): AppAccessStatus | 'none' | null {
  if (!isAppAccessRequiredError(err)) return null;
  const status = apiErrorDetails<{ status?: unknown }>(err)?.status;
  if (status === 'none') return 'none';
  return typeof status === 'string' && ACCESS_STATUSES.includes(status) ? (status as AppAccessStatus) : 'none';
}

export function isPaymentMethodRequiredError(err: unknown): boolean {
  return apiErrorCode(err) === 'PAYMENT_METHOD_REQUIRED' || (isApiError(err) && err.status === 402);
}

export function isDomainHasMailboxesError(err: unknown): boolean {
  return apiErrorCode(err) === 'DOMAIN_HAS_MAILBOXES';
}

/** A message for a toast or inline banner. Unknown codes fall back to the server's own message. */
export function reachErrorMessage(err: unknown, t: Translate): string {
  if (isPaymentMethodRequiredError(err)) return t('reach.errors.paymentMethodRequired');
  if (isDomainHasMailboxesError(err)) return t('reach.errors.domainHasMailboxes');
  if (isApiError(err)) {
    if (err.status === 403 && !isAppAccessRequiredError(err)) return t('reach.errors.forbidden');
    if (err.message && err.message !== 'Request failed') return err.message;
  }
  return t('reach.errors.generic');
}
