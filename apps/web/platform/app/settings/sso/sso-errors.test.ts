import { describe, expect, it } from 'vitest';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { SSO_ERRORS } from '@weldsuite/app-api-client/schemas/sso';
import { isPaymentMethodRequired, ssoErrorMessage } from './sso-errors';

const copy = en.settings.sso.errors;

/** What the transport throws for `{ error: { code, message } }` with `status`. */
function failure(status: number, code: string, message = 'English server message') {
  return new ApiError(message, status, { error: { code, message } });
}

describe('ssoErrorMessage', () => {
  it('translates every code the SSO routes answer with', () => {
    const cases: Array<[number, string, string]> = [
      [402, SSO_ERRORS.NOT_ENTITLED, copy.notEntitled],
      [400, SSO_ERRORS.DOMAIN_INVALID, copy.domainInvalid],
      [400, SSO_ERRORS.DOMAIN_PUBLIC, copy.domainPublic],
      [409, SSO_ERRORS.DOMAIN_IN_USE, copy.domainInUse],
      [409, SSO_ERRORS.DOMAIN_MISSING, copy.domainMissing],
      [409, SSO_ERRORS.DOMAIN_LOCKED, copy.domainLocked],
      [502, SSO_ERRORS.DNS_LOOKUP_FAILED, copy.dnsLookupFailed],
      [409, SSO_ERRORS.CHANGED_MEANWHILE, copy.changedMeanwhile],
      [409, SSO_ERRORS.CONNECTION_MISSING, copy.connectionMissing],
      [409, SSO_ERRORS.IDP_INCOMPLETE, copy.idpIncomplete],
      [503, SSO_ERRORS.PROVIDER_UNAVAILABLE, copy.providerUnavailable],
      [409, SSO_ERRORS.ADDON_UNAVAILABLE, copy.addonUnavailable],
      [409, SSO_ERRORS.ALREADY_SUBSCRIBED, copy.alreadySubscribed],
      [409, SSO_ERRORS.NOT_SUBSCRIBED, copy.notSubscribed],
      [402, SSO_ERRORS.PAYMENT_METHOD_REQUIRED, copy.paymentMethodRequired],
      [403, SSO_ERRORS.BILLING_ADMIN_REQUIRED, copy.billingAdminRequired],
      [402, 'PAYMENT_FAILED', copy.paymentFailed],
      [409, 'BILLING_BUSY', copy.billingBusy],
      [502, 'BILLING_UNAVAILABLE', copy.billingUnavailable],
      [502, 'BILLING_PROVIDER_ERROR', copy.billingUnavailable],
      [503, 'BILLING_NOT_CONFIGURED', copy.billingUnavailable],
    ];
    for (const [status, code, expected] of cases) {
      expect(ssoErrorMessage(failure(status, code), copy), code).toBe(expected);
    }
  });

  it('tells a TXT record that is not there yet from a step that needs a verified domain', () => {
    expect(ssoErrorMessage(failure(422, SSO_ERRORS.DOMAIN_NOT_VERIFIED), copy)).toBe(copy.domainRecordNotFound);
    expect(ssoErrorMessage(failure(409, SSO_ERRORS.DOMAIN_NOT_VERIFIED), copy)).toBe(copy.domainNotVerified);
  });

  it("shows the identity provider's own reason when it refuses the details", () => {
    expect(ssoErrorMessage(failure(422, SSO_ERRORS.IDP_REJECTED, 'idp_metadata_url is not a valid URL'), copy)).toBe(
      'Your identity provider details were not accepted: idp_metadata_url is not a valid URL',
    );
    expect(ssoErrorMessage(failure(422, SSO_ERRORS.IDP_REJECTED, '  '), copy)).toBe(copy.idpRejectedGeneric);
  });

  it('falls back to a permission message for a bare 403, and a generic one for anything else', () => {
    expect(ssoErrorMessage(new ApiError('Forbidden', 403, { error: 'Forbidden' }), copy)).toBe(copy.forbidden);
    expect(ssoErrorMessage(failure(500, 'SOMETHING_NEW'), copy)).toBe(copy.generic);
    expect(ssoErrorMessage(new Error('offline'), copy)).toBe(copy.generic);
    expect(ssoErrorMessage(null, copy)).toBe(copy.generic);
  });

  it('answers in the active locale', () => {
    expect(ssoErrorMessage(failure(402, SSO_ERRORS.NOT_ENTITLED), nl.settings.sso.errors)).toBe(nl.settings.sso.errors.notEntitled);
  });
});

describe('isPaymentMethodRequired', () => {
  it('spots the failure that needs a card', () => {
    expect(isPaymentMethodRequired(failure(402, SSO_ERRORS.PAYMENT_METHOD_REQUIRED))).toBe(true);
    expect(isPaymentMethodRequired(failure(402, 'PAYMENT_FAILED'))).toBe(false);
    expect(isPaymentMethodRequired(new Error('x'))).toBe(false);
  });
});
