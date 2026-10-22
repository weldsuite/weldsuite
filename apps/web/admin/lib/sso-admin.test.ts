import { describe, expect, it } from 'vitest';
import type { SsoAdminView } from '@weldsuite/app-api-client/schemas/sso';
import {
  canOfferSwitchOn,
  canRevokeSso,
  centsToMajorUnits,
  connectionInactiveReason,
  customPriceProblem,
  initialPriceCurrency,
  initialPriceMode,
  parseMajorUnitsToCents,
  ssoGrantRequest,
} from './sso-admin';

function view(overrides: Partial<SsoAdminView> = {}): SsoAdminView {
  return {
    entitlement: { entitled: false, source: null },
    planIncludesSso: false,
    billingMode: 'direct',
    listPrice: { unitAmountCents: 10_000, currency: 'eur' },
    priceOverride: null,
    subscription: null,
    domain: null,
    connection: null,
    ...overrides,
  };
}

const running = (status: 'active' | 'past_due' | 'unpaid' | 'canceled'): SsoAdminView['subscription'] => ({
  id: 'sub_123',
  status,
  currentPeriodEnd: '2026-11-22T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  unitAmountCents: 10_000,
  currency: 'eur',
});

const override = (unitAmountCents: number, currency: string | null = 'eur'): SsoAdminView['priceOverride'] => ({
  unitAmountCents,
  currency,
  setBy: 'staff@weldsuite.org',
  setAt: '2026-10-01T00:00:00.000Z',
  reason: 'Deal',
});

describe('parseMajorUnitsToCents', () => {
  it('reads whole amounts and up to two decimals, with a dot or a comma', () => {
    expect(parseMajorUnitsToCents('75')).toBe(7500);
    expect(parseMajorUnitsToCents(' 49.50 ')).toBe(4950);
    expect(parseMajorUnitsToCents('49.5')).toBe(4950);
    expect(parseMajorUnitsToCents('49,5')).toBe(4950);
    expect(parseMajorUnitsToCents('0.01')).toBe(1);
    expect(parseMajorUnitsToCents('0')).toBe(0);
  });

  it('does not drift on amounts floats cannot hold exactly', () => {
    expect(parseMajorUnitsToCents('0.29')).toBe(29);
    expect(parseMajorUnitsToCents('1.15')).toBe(115);
    expect(parseMajorUnitsToCents('100000.99')).toBe(10_000_099);
  });

  it('refuses anything else', () => {
    for (const input of ['', ' ', '-5', '1.234', '1e3', '€75', '75 EUR', '1,000.00', '.50', '12.', 'abc']) {
      expect(parseMajorUnitsToCents(input), input).toBeNull();
    }
  });

  it('round-trips with centsToMajorUnits', () => {
    for (const cents of [1, 99, 100, 4950, 7500, 10_000, 1_234_567]) {
      expect(parseMajorUnitsToCents(centsToMajorUnits(cents))).toBe(cents);
    }
    expect(centsToMajorUnits(7500)).toBe('75');
    expect(centsToMajorUnits(4950)).toBe('49.50');
    expect(centsToMajorUnits(5)).toBe('0.05');
  });
});

describe('customPriceProblem', () => {
  it('needs a positive amount up to the maximum', () => {
    expect(customPriceProblem(null)).toBe('format');
    expect(customPriceProblem(0)).toBe('zero');
    expect(customPriceProblem(10_000_001)).toBe('too_high');
    expect(customPriceProblem(10_000_000)).toBeNull();
    expect(customPriceProblem(1)).toBeNull();
  });
});

describe('initial dialog state', () => {
  it('opens on what is saved', () => {
    expect(initialPriceMode(view())).toBe('list');
    expect(initialPriceMode(view({ priceOverride: override(0, null) }))).toBe('free');
    expect(initialPriceMode(view({ priceOverride: override(7500) }))).toBe('custom');
    expect(initialPriceMode(view({ billingMode: 'partner' }))).toBe('free');
  });

  it("starts the currency at the saved price's, else the list price's", () => {
    expect(initialPriceCurrency(view())).toBe('eur');
    expect(initialPriceCurrency(view({ listPrice: { unitAmountCents: 10_000, currency: 'usd' } }))).toBe('usd');
    expect(initialPriceCurrency(view({ priceOverride: override(7500, 'usd') }))).toBe('usd');
    expect(initialPriceCurrency(view({ listPrice: { unitAmountCents: 10_000, currency: 'gbp' } }))).toBe('eur');
  });
});

describe('ssoGrantRequest', () => {
  const form = { cents: 7500, currency: 'eur' as const, switchOn: true };

  it('sends null for the list price, 0 for free and cents for a custom price', () => {
    expect(ssoGrantRequest(view(), { ...form, mode: 'list' })).toEqual({ priceCents: null, currency: null, switchOn: true });
    expect(ssoGrantRequest(view(), { ...form, mode: 'free' })).toEqual({ priceCents: 0, currency: null, switchOn: false });
    expect(ssoGrantRequest(view(), { ...form, mode: 'custom' })).toEqual({ priceCents: 7500, currency: 'eur', switchOn: true });
  });

  it('refuses an invalid custom price', () => {
    expect(ssoGrantRequest(view(), { ...form, mode: 'custom', cents: null })).toBeNull();
    expect(ssoGrantRequest(view(), { ...form, mode: 'custom', cents: 0 })).toBeNull();
  });

  it('only switches SSO on when nothing else covers it and no add-on is running', () => {
    const cases: SsoAdminView[] = [
      view({ planIncludesSso: true }),
      view({ billingMode: 'partner' }),
      view({ subscription: running('active') }),
      view({ subscription: running('past_due') }),
      view({ subscription: running('unpaid') }),
    ];
    for (const v of cases) {
      expect(canOfferSwitchOn(v, 'list')).toBe(false);
      expect(ssoGrantRequest(v, { ...form, mode: 'custom' })?.switchOn).toBe(false);
    }
    // A cancelled add-on can be started again.
    expect(canOfferSwitchOn(view({ subscription: running('canceled') }), 'custom')).toBe(true);
    expect(canOfferSwitchOn(view(), 'free')).toBe(false);
  });
});

describe('canRevokeSso', () => {
  it('needs a saved price or a running add-on', () => {
    expect(canRevokeSso(view())).toBe(false);
    expect(canRevokeSso(view({ subscription: running('canceled') }))).toBe(false);
    expect(canRevokeSso(view({ planIncludesSso: true, entitlement: { entitled: true, source: 'plan' } }))).toBe(false);
    expect(canRevokeSso(view({ priceOverride: override(0, null) }))).toBe(true);
    expect(canRevokeSso(view({ subscription: running('past_due') }))).toBe(true);
    // Unpaid still exists in Stripe: staff can end it.
    expect(canRevokeSso(view({ subscription: running('unpaid') }))).toBe(true);
  });
});

describe('connectionInactiveReason', () => {
  const connection = (enabled: boolean, active: boolean): SsoAdminView['connection'] => ({
    provider: 'saml_okta',
    enabled,
    active,
    updatedBy: null,
    updatedAt: null,
  });
  const entitled = { entitled: true, source: 'subscription' as const };
  const verified = { name: 'acme.com', verified: true };

  it('says nothing for a connection that is off, active or missing', () => {
    expect(connectionInactiveReason(view())).toBeNull();
    expect(connectionInactiveReason(view({ connection: connection(false, false) }))).toBeNull();
    expect(connectionInactiveReason(view({ connection: connection(true, true), domain: verified, entitlement: entitled }))).toBeNull();
  });

  it('names what keeps a switched-on connection inactive', () => {
    expect(connectionInactiveReason(view({ connection: connection(true, false), entitlement: entitled }))).toBe('domain');
    expect(
      connectionInactiveReason(view({ connection: connection(true, false), domain: { name: 'acme.com', verified: false } })),
    ).toBe('domain');
    expect(connectionInactiveReason(view({ connection: connection(true, false), domain: verified }))).toBe('entitlement');
    expect(
      connectionInactiveReason(view({ connection: connection(true, false), domain: verified, entitlement: entitled })),
    ).toBe('pending');
  });
});
