/**
 * Turns a failed single sign-on request into a translated message.
 *
 * The routes answer `{ error: { code, message } }`; the code is stable, the
 * message is English. Only Clerk's own reason for refusing the identity
 * provider details (`SSO_IDP_REJECTED`) is shown as the server wrote it.
 */

import { isApiError } from '@weldsuite/api-client';
import { SSO_ERRORS } from '@weldsuite/app-api-client/schemas/sso';
import { apiErrorCode } from '@/lib/partner/api-errors';
import type { TranslationsType } from '@/lib/i18n/types';

export type SsoErrorCopy = TranslationsType['settings']['sso']['errors'];

export function ssoErrorMessage(err: unknown, copy: SsoErrorCopy): string {
  switch (apiErrorCode(err)) {
    case SSO_ERRORS.NOT_ENTITLED:
      return copy.notEntitled;
    case SSO_ERRORS.DOMAIN_INVALID:
      return copy.domainInvalid;
    case SSO_ERRORS.DOMAIN_PUBLIC:
      return copy.domainPublic;
    case SSO_ERRORS.DOMAIN_IN_USE:
      return copy.domainInUse;
    case SSO_ERRORS.DOMAIN_MISSING:
      return copy.domainMissing;
    case SSO_ERRORS.DOMAIN_NOT_VERIFIED:
      // The verify call answers 422 when the TXT record is not there yet; the
      // same code with 409 means a step needed a verified domain first.
      return isApiError(err) && err.status === 422 ? copy.domainRecordNotFound : copy.domainNotVerified;
    case SSO_ERRORS.DOMAIN_LOCKED:
      return copy.domainLocked;
    case SSO_ERRORS.DNS_LOOKUP_FAILED:
      return copy.dnsLookupFailed;
    case SSO_ERRORS.CONNECTION_MISSING:
      return copy.connectionMissing;
    case SSO_ERRORS.IDP_INCOMPLETE:
      return copy.idpIncomplete;
    case SSO_ERRORS.IDP_REJECTED: {
      const detail = isApiError(err) ? err.message.trim() : '';
      return detail ? copy.idpRejected.replace('{message}', detail) : copy.idpRejectedGeneric;
    }
    case SSO_ERRORS.PROVIDER_UNAVAILABLE:
      return copy.providerUnavailable;
    case SSO_ERRORS.ADDON_UNAVAILABLE:
      return copy.addonUnavailable;
    case SSO_ERRORS.ALREADY_SUBSCRIBED:
      return copy.alreadySubscribed;
    case SSO_ERRORS.NOT_SUBSCRIBED:
      return copy.notSubscribed;
    case SSO_ERRORS.PAYMENT_METHOD_REQUIRED:
      return copy.paymentMethodRequired;
    case SSO_ERRORS.BILLING_ADMIN_REQUIRED:
      return copy.billingAdminRequired;
    case 'PAYMENT_FAILED':
      return copy.paymentFailed;
    case 'BILLING_BUSY':
      return copy.billingBusy;
    case 'BILLING_UNAVAILABLE':
    case 'BILLING_PROVIDER_ERROR':
    case 'BILLING_NOT_CONFIGURED':
      return copy.billingUnavailable;
  }
  if (isApiError(err) && err.status === 403) return copy.forbidden;
  return copy.generic;
}

/** The failure needs a card: the page offers a way to add one. */
export function isPaymentMethodRequired(err: unknown): boolean {
  return apiErrorCode(err) === SSO_ERRORS.PAYMENT_METHOD_REQUIRED;
}
