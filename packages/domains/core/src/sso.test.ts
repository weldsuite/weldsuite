/**
 * The pure SSO rules: who is entitled, what Clerk's `active` should be, how a
 * typed domain is read, how the DNS proof is matched, and the list price per
 * currency. The DB and Clerk paths are covered by the app-api route tests and
 * billing-worker's sso-billing integration tests.
 */

import { describe, expect, it } from 'vitest';
import type { WorkspaceSso } from '@weldsuite/db/schema/master';
import {
  isIdpConfigured,
  isPublicEmailDomain,
  normalizeSsoDomain,
  resolveSsoEntitlement,
  ssoAddonListPrice,
  ssoDnsRecordMatches,
  ssoDnsRecordName,
  ssoDnsRecordValue,
} from '@weldsuite/app-api-client/schemas/sso';
import { SSO_PROVIDERS } from '@weldsuite/db/schema/master';
import { SSO_PROVIDER_IDS } from '@weldsuite/app-api-client/schemas/sso';
import { desiredClerkActive, type SsoContext } from './sso';

const base = { planIncludesSso: false, workspaceActive: true, priceOverrideCents: null, subscriptionStatus: 'none' };

describe('resolveSsoEntitlement', () => {
  it('comes from the plan first', () => {
    expect(resolveSsoEntitlement({ ...base, planIncludesSso: true })).toEqual({ entitled: true, source: 'plan' });
  });

  it('a price of 0 is a free grant; another price is not entitlement by itself', () => {
    expect(resolveSsoEntitlement({ ...base, priceOverrideCents: 0 })).toEqual({ entitled: true, source: 'free' });
    expect(resolveSsoEntitlement({ ...base, priceOverrideCents: 5000 })).toEqual({ entitled: false, source: null });
  });

  it('a paid add-on counts while active or being retried, not once it ended', () => {
    expect(resolveSsoEntitlement({ ...base, subscriptionStatus: 'active' }).source).toBe('subscription');
    expect(resolveSsoEntitlement({ ...base, subscriptionStatus: 'past_due' }).entitled).toBe(true);
    expect(resolveSsoEntitlement({ ...base, subscriptionStatus: 'unpaid' }).entitled).toBe(false);
    expect(resolveSsoEntitlement({ ...base, subscriptionStatus: 'canceled' }).entitled).toBe(false);
    expect(resolveSsoEntitlement({ ...base, subscriptionStatus: 'none' }).entitled).toBe(false);
  });

  it('nothing counts for a suspended or deleted workspace', () => {
    expect(resolveSsoEntitlement({ ...base, planIncludesSso: true, workspaceActive: false })).toEqual({
      entitled: false,
      source: null,
    });
  });
});

describe('desiredClerkActive', () => {
  const row = (overrides: Partial<WorkspaceSso>): WorkspaceSso =>
    ({
      clerkConnectionId: 'samlc_1',
      enabled: true,
      domainVerifiedAt: new Date(),
      priceOverrideCents: null,
      subscriptionStatus: 'active',
      ...overrides,
    }) as WorkspaceSso;
  const ctx = (overrides: Partial<WorkspaceSso>, workspace: Partial<SsoContext['workspace']> = {}): SsoContext => ({
    workspace: {
      id: 'ws_1',
      clerkOrgId: 'org_1',
      name: 'Acme',
      planId: null,
      billingMode: 'direct',
      isActive: true,
      deletedAt: null,
      ...workspace,
    },
    row: row(overrides),
    planIncludesSso: false,
  });

  it('is on when switched on, entitled and on a verified domain', () => {
    expect(desiredClerkActive(ctx({}))).toBe(true);
  });

  it('is off when any of them is missing', () => {
    expect(desiredClerkActive(ctx({ enabled: false }))).toBe(false);
    expect(desiredClerkActive(ctx({ subscriptionStatus: 'canceled' }))).toBe(false);
    expect(desiredClerkActive(ctx({ domainVerifiedAt: null }))).toBe(false);
    expect(desiredClerkActive(ctx({ clerkConnectionId: null }))).toBe(false);
    expect(desiredClerkActive(ctx({}, { deletedAt: new Date() }))).toBe(false);
  });
});

describe('normalizeSsoDomain', () => {
  it.each([
    ['acme.com', 'acme.com'],
    ['  ACME.com ', 'acme.com'],
    ['https://www.acme.com/login?x=1', 'acme.com'],
    ['jane.doe@Acme.co.uk', 'acme.co.uk'],
    ['@acme.nl', 'acme.nl'],
    ['acme.com.', 'acme.com'],
    ['mail.acme-group.io:443', 'mail.acme-group.io'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeSsoDomain(input)).toBe(expected);
  });

  it.each(['', 'localhost', 'acme', '10.0.0.1', '-acme.com', 'acme-.com', 'ac me.com', 'bücher.example', `${'a'.repeat(64)}.com`])(
    'refuses %j',
    (input) => {
      expect(normalizeSsoDomain(input)).toBeNull();
    },
  );
});

describe('the DNS proof', () => {
  it('names the record under the domain and matches its value, quoted or not', () => {
    expect(ssoDnsRecordName('acme.com')).toBe('_weldsuite-sso.acme.com');
    const value = ssoDnsRecordValue('abc123');
    expect(ssoDnsRecordMatches(['v=spf1 -all', value], 'abc123')).toBe(true);
    expect(ssoDnsRecordMatches([`"${value}"`], 'abc123')).toBe(true);
    expect(ssoDnsRecordMatches([` ${value} `], 'abc123')).toBe(true);
  });

  it('does not match another token or a prefix of the value', () => {
    expect(ssoDnsRecordMatches([ssoDnsRecordValue('other')], 'abc123')).toBe(false);
    expect(ssoDnsRecordMatches([ssoDnsRecordValue('abc123') + 'x'], 'abc123')).toBe(false);
    expect(ssoDnsRecordMatches([], 'abc123')).toBe(false);
  });
});

describe('isIdpConfigured', () => {
  const none = { metadataUrl: null, hasMetadata: false, entityId: null, ssoUrl: null, hasCertificate: false };

  it('is enough with a metadata URL or XML', () => {
    expect(isIdpConfigured({ ...none, metadataUrl: 'https://idp.example/metadata' })).toBe(true);
    expect(isIdpConfigured({ ...none, hasMetadata: true })).toBe(true);
  });

  it('otherwise needs the entity id, the SSO URL and the certificate', () => {
    expect(isIdpConfigured(none)).toBe(false);
    expect(isIdpConfigured({ ...none, entityId: 'e', ssoUrl: 'https://idp.example/sso' })).toBe(false);
    expect(isIdpConfigured({ ...none, entityId: 'e', ssoUrl: 'https://idp.example/sso', hasCertificate: true })).toBe(true);
  });
});

describe('prices and lists', () => {
  it('lists €100, and $100 for customers billed in dollars', () => {
    expect(ssoAddonListPrice(null)).toEqual({ unitAmountCents: 10_000, currency: 'eur' });
    expect(ssoAddonListPrice('EUR')).toEqual({ unitAmountCents: 10_000, currency: 'eur' });
    expect(ssoAddonListPrice('usd')).toEqual({ unitAmountCents: 10_000, currency: 'usd' });
  });

  it('knows public mailbox domains', () => {
    expect(isPublicEmailDomain('gmail.com')).toBe(true);
    expect(isPublicEmailDomain('acme.com')).toBe(false);
  });

  it('keeps the client provider list equal to the DB one', () => {
    expect([...SSO_PROVIDER_IDS]).toEqual([...SSO_PROVIDERS]);
  });
});
