/**
 * Fixtures of the single sign-on tests: a configuration and an add-on as the
 * API returns them. Not a test file itself.
 */

import type { SsoBillingView, SsoConfigView } from '@weldsuite/app-api-client/schemas/sso';

type Connection = NonNullable<SsoConfigView['connection']>;

export function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    provider: 'saml_okta',
    enabled: false,
    active: false,
    idp: { metadataUrl: null, hasMetadata: false, entityId: null, ssoUrl: null, hasCertificate: false },
    idpConfigured: false,
    sp: {
      acsUrl: 'https://clerk.weldsuite.org/v1/saml/acs/samlc_1',
      entityId: 'https://clerk.weldsuite.org/saml/samlc_1',
      metadataUrl: 'https://clerk.weldsuite.org/v1/saml/metadata/samlc_1',
    },
    userCount: 0,
    updatedAt: '2026-10-20T09:00:00.000Z',
    ...overrides,
  };
}

export function makeConfig(overrides: Partial<SsoConfigView> = {}): SsoConfigView {
  return {
    entitlement: { entitled: true, source: 'subscription' },
    domain: null,
    connection: null,
    canManage: true,
    ...overrides,
  };
}

export function makeDomain(overrides: Partial<NonNullable<SsoConfigView['domain']>> = {}): NonNullable<SsoConfigView['domain']> {
  return {
    name: 'acme.com',
    verified: false,
    verifiedAt: null,
    dnsRecord: {
      type: 'TXT',
      name: '_weldsuite-sso.acme.com',
      value: 'weldsuite-sso-verification=0123456789abcdef0123456789abcdef',
    },
    ...overrides,
  };
}

export function makeBilling(overrides: Partial<SsoBillingView> = {}): SsoBillingView {
  return {
    entitlement: { entitled: false, source: null },
    price: { unitAmountCents: 10_000, currency: 'eur', custom: false },
    purchasable: true,
    unavailableReason: null,
    subscription: null,
    hasPaymentMethod: true,
    ...overrides,
  };
}
