import { describe, expect, it } from 'vitest';
import {
  activationBlock,
  connectionInputFrom,
  domainIssue,
  formatSsoDate,
  idpFormValues,
  idpIssues,
  idpMethodOf,
  isPaused,
  ssoAddonState,
  ssoStatus,
  type IdpFormValues,
  type SsoIdp,
} from './sso-view';
import { makeBilling, makeConfig, makeConnection, makeDomain } from './test-support';

const EMPTY_IDP: SsoIdp = { metadataUrl: null, hasMetadata: false, entityId: null, ssoUrl: null, hasCertificate: false };

const values = (overrides: Partial<IdpFormValues> = {}): IdpFormValues => ({
  ...idpFormValues('saml_okta', EMPTY_IDP),
  ...overrides,
});

describe('ssoStatus', () => {
  it('is not set up without a connection, or while the identity provider has no details', () => {
    expect(ssoStatus(makeConfig())).toBe('not_set_up');
    expect(ssoStatus(makeConfig({ connection: makeConnection({ idpConfigured: false }) }))).toBe('not_set_up');
  });

  it('is off for a working connection that is not switched on, and active once Clerk uses it', () => {
    expect(ssoStatus(makeConfig({ connection: makeConnection({ idpConfigured: true }) }))).toBe('off');
    expect(
      ssoStatus(makeConfig({ connection: makeConnection({ idpConfigured: true, enabled: true, active: true }) })),
    ).toBe('active');
  });

  it('is off, and paused, when the switch is on but the entitlement lapsed', () => {
    const config = makeConfig({ connection: makeConnection({ idpConfigured: true, enabled: true, active: false }) });
    expect(ssoStatus(config)).toBe('off');
    expect(isPaused(config)).toBe(true);
    expect(isPaused(makeConfig({ connection: makeConnection({ enabled: true, active: true }) }))).toBe(false);
    expect(isPaused(makeConfig())).toBe(false);
  });
});

describe('ssoAddonState', () => {
  it('is included when the plan has SSO', () => {
    expect(ssoAddonState(makeBilling({ purchasable: false, unavailableReason: 'INCLUDED_IN_PLAN' }))).toEqual({ kind: 'included' });
  });

  it('is a free grant when staff set the price to zero', () => {
    expect(ssoAddonState(makeBilling({ purchasable: false, unavailableReason: 'FREE_GRANT' }))).toEqual({ kind: 'free-grant' });
  });

  it('reads the running subscription, and flags a past due payment or a cancellation', () => {
    const state = ssoAddonState(
      makeBilling({
        purchasable: false,
        subscription: { status: 'past_due', currentPeriodEnd: '2026-11-14T00:00:00.000Z', cancelAtPeriodEnd: true },
      }),
    );
    expect(state).toEqual({
      kind: 'subscribed',
      pastDue: true,
      unpaid: false,
      currentPeriodEnd: '2026-11-14T00:00:00.000Z',
      cancelAtPeriodEnd: true,
      includedInPlan: false,
    });
  });

  it('flags an unpaid add-on, which switched SSO off until the invoice is paid', () => {
    const state = ssoAddonState(
      makeBilling({
        purchasable: false,
        subscription: { status: 'unpaid', currentPeriodEnd: null, cancelAtPeriodEnd: false },
      }),
    );
    expect(state).toMatchObject({ kind: 'subscribed', unpaid: true, pastDue: false });
  });

  it('notes a subscription the plan has made redundant', () => {
    const state = ssoAddonState(
      makeBilling({
        purchasable: false,
        unavailableReason: 'INCLUDED_IN_PLAN',
        subscription: { status: 'active', currentPeriodEnd: null, cancelAtPeriodEnd: false },
      }),
    );
    expect(state).toMatchObject({ kind: 'subscribed', includedInPlan: true });
  });

  it('is purchasable with or without a card on file', () => {
    expect(ssoAddonState(makeBilling({ hasPaymentMethod: true }))).toEqual({ kind: 'purchasable', hasPaymentMethod: true });
    expect(ssoAddonState(makeBilling({ hasPaymentMethod: false }))).toEqual({ kind: 'purchasable', hasPaymentMethod: false });
  });

  it('explains why it cannot be bought', () => {
    expect(ssoAddonState(makeBilling({ purchasable: false, unavailableReason: 'FREE_PLAN' }))).toEqual({ kind: 'free-plan' });
    expect(ssoAddonState(makeBilling({ purchasable: false, unavailableReason: 'PARTNER_MANAGED' }))).toEqual({ kind: 'partner' });
    expect(ssoAddonState(makeBilling({ purchasable: false }))).toEqual({ kind: 'unavailable' });
  });

  it('treats a cancelled subscription as no subscription', () => {
    const state = ssoAddonState(
      makeBilling({ subscription: { status: 'canceled', currentPeriodEnd: null, cancelAtPeriodEnd: false } }),
    );
    expect(state.kind).toBe('purchasable');
  });
});

describe('activationBlock', () => {
  const ready = () =>
    makeConfig({
      domain: makeDomain({ verified: true }),
      connection: makeConnection({ idpConfigured: true }),
    });

  it('lets a complete setup be switched on', () => {
    expect(activationBlock(ready())).toBeNull();
  });

  it('names the first thing that is missing', () => {
    expect(activationBlock({ ...ready(), entitlement: { entitled: false, source: null } })).toBe('not_entitled');
    expect(activationBlock({ ...ready(), domain: makeDomain({ verified: false }) })).toBe('domain_unverified');
    expect(activationBlock({ ...ready(), domain: null })).toBe('domain_unverified');
    expect(activationBlock({ ...ready(), connection: null })).toBe('no_connection');
    expect(activationBlock({ ...ready(), connection: makeConnection({ idpConfigured: false }) })).toBe('idp_incomplete');
  });
});

describe('domainIssue', () => {
  it('accepts a company domain in any of the ways people type it', () => {
    expect(domainIssue('acme.com')).toBeNull();
    expect(domainIssue(' https://www.Acme.com/ ')).toBeNull();
    expect(domainIssue('jane@acme.com')).toBeNull();
  });

  it('refuses an empty, malformed or public mailbox domain', () => {
    expect(domainIssue('  ')).toBe('required');
    expect(domainIssue('acme')).toBe('invalid');
    expect(domainIssue('192.168.0.1')).toBe('invalid');
    expect(domainIssue('gmail.com')).toBe('public');
  });
});

describe('identity provider form', () => {
  it('starts on the method the connection was set up with', () => {
    expect(idpMethodOf(EMPTY_IDP)).toBe('url');
    expect(idpMethodOf({ ...EMPTY_IDP, metadataUrl: 'https://idp.example.com/m' })).toBe('url');
    expect(idpMethodOf({ ...EMPTY_IDP, hasMetadata: true })).toBe('xml');
    expect(idpMethodOf({ ...EMPTY_IDP, entityId: 'urn:idp', ssoUrl: 'https://idp.example.com/sso', hasCertificate: true })).toBe('manual');
  });

  it('prefills what the API returns and leaves the secrets empty', () => {
    const form = idpFormValues('saml_microsoft', {
      metadataUrl: 'https://idp.example.com/m',
      hasMetadata: true,
      entityId: 'urn:idp',
      ssoUrl: 'https://idp.example.com/sso',
      hasCertificate: true,
    });
    expect(form).toMatchObject({
      provider: 'saml_microsoft',
      method: 'url',
      metadataUrl: 'https://idp.example.com/m',
      entityId: 'urn:idp',
      ssoUrl: 'https://idp.example.com/sso',
      metadataXml: '',
      certificate: '',
    });
  });

  it('requires an https metadata URL for the URL method', () => {
    expect(idpIssues(values({ method: 'url' }), EMPTY_IDP)).toEqual([{ field: 'metadataUrl', code: 'required' }]);
    expect(idpIssues(values({ method: 'url', metadataUrl: 'http://idp.example.com/m' }), EMPTY_IDP)).toEqual([
      { field: 'metadataUrl', code: 'httpsUrl' },
    ]);
    expect(idpIssues(values({ method: 'url', metadataUrl: 'idp.example.com' }), EMPTY_IDP)).toEqual([
      { field: 'metadataUrl', code: 'httpsUrl' },
    ]);
    expect(idpIssues(values({ method: 'url', metadataUrl: 'https://idp.example.com/m' }), EMPTY_IDP)).toEqual([]);
  });

  it('requires XML, unless metadata is already stored', () => {
    expect(idpIssues(values({ method: 'xml' }), EMPTY_IDP)).toEqual([{ field: 'metadataXml', code: 'required' }]);
    expect(idpIssues(values({ method: 'xml', metadataXml: 'not xml' }), EMPTY_IDP)).toEqual([{ field: 'metadataXml', code: 'notXml' }]);
    expect(idpIssues(values({ method: 'xml', metadataXml: '<EntityDescriptor/>' }), EMPTY_IDP)).toEqual([]);
    expect(idpIssues(values({ method: 'xml' }), { ...EMPTY_IDP, hasMetadata: true })).toEqual([]);
  });

  it('requires entity id, https sign-on URL and certificate for the manual method, unless a certificate is stored', () => {
    expect(idpIssues(values({ method: 'manual' }), EMPTY_IDP)).toEqual([
      { field: 'entityId', code: 'required' },
      { field: 'ssoUrl', code: 'required' },
      { field: 'certificate', code: 'required' },
    ]);
    expect(
      idpIssues(values({ method: 'manual', entityId: 'urn:idp', ssoUrl: 'https://idp.example.com/sso' }), {
        ...EMPTY_IDP,
        hasCertificate: true,
      }),
    ).toEqual([]);
  });

  it('ignores the fields of the methods that are not chosen', () => {
    expect(idpIssues(values({ method: 'url', metadataUrl: 'https://idp.example.com/m', entityId: '', certificate: '' }), EMPTY_IDP)).toEqual([]);
  });

  it('sends only the chosen method, and clears a stored value of another method', () => {
    expect(connectionInputFrom(values({ method: 'url', metadataUrl: ' https://idp.example.com/m ' }), EMPTY_IDP)).toEqual({
      provider: 'saml_okta',
      idpMetadataUrl: 'https://idp.example.com/m',
    });
    expect(
      connectionInputFrom(values({ method: 'url', metadataUrl: 'https://idp.example.com/m' }), { ...EMPTY_IDP, hasMetadata: true }),
    ).toEqual({ provider: 'saml_okta', idpMetadataUrl: 'https://idp.example.com/m', idpMetadata: null });

    expect(
      connectionInputFrom(values({ method: 'xml', metadataXml: ' <EntityDescriptor/> ' }), { ...EMPTY_IDP, metadataUrl: 'https://idp.example.com/m' }),
    ).toEqual({ provider: 'saml_okta', idpMetadata: '<EntityDescriptor/>', idpMetadataUrl: null });

    expect(
      connectionInputFrom(
        values({ method: 'manual', entityId: ' urn:idp ', ssoUrl: 'https://idp.example.com/sso', certificate: ' CERT ' }),
        { ...EMPTY_IDP, metadataUrl: 'https://idp.example.com/m', hasMetadata: true },
      ),
    ).toEqual({
      provider: 'saml_okta',
      idpEntityId: 'urn:idp',
      idpSsoUrl: 'https://idp.example.com/sso',
      idpCertificate: 'CERT',
      idpMetadataUrl: null,
      idpMetadata: null,
    });
  });

  it('keeps a stored XML or certificate when its field is left empty', () => {
    expect(connectionInputFrom(values({ method: 'xml', metadataXml: '' }), { ...EMPTY_IDP, hasMetadata: true })).toEqual({
      provider: 'saml_okta',
    });
    expect(
      connectionInputFrom(values({ method: 'manual', entityId: 'urn:idp', ssoUrl: 'https://idp.example.com/sso' }), {
        ...EMPTY_IDP,
        hasCertificate: true,
      }),
    ).toEqual({ provider: 'saml_okta', idpEntityId: 'urn:idp', idpSsoUrl: 'https://idp.example.com/sso' });
  });
});

describe('formatSsoDate', () => {
  it('formats in the UI language and tolerates a missing or unreadable date', () => {
    expect(formatSsoDate('2026-11-14T12:00:00.000Z', 'en')).toBe('November 14, 2026');
    expect(formatSsoDate('2026-11-14T12:00:00.000Z', 'nl')).toBe('14 november 2026');
    expect(formatSsoDate(null, 'en')).toBe('');
    expect(formatSsoDate('not a date', 'en')).toBe('');
  });
});
