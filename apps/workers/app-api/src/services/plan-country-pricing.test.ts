import { describe, expect, it } from 'vitest';
import {
  normalizeCountryCode,
  parsePlanCountryPricing,
  resolveCountryPlanPrices,
} from '@weldsuite/app-api-client/schemas/plan-country-pricing';
import { planDisplayPrice, requestCountry } from './plan-country-pricing';

const config = parsePlanCountryPricing({
  countries: {
    NL: {
      currency: 'EUR',
      plans: {
        business: { monthly: 39, annual: 33 },
        scale: { monthly: 59, annual: null },
      },
    },
    // Malformed entries are dropped, not fatal.
    US: { currency: 'usd', plans: {} },
    be: { currency: 'EUR', plans: { business: { monthly: 39, annual: null } } },
    DE: { currency: 'EUR', plans: { business: { monthly: 39, annual: 49 } } },
  },
});

describe('plan prices per country', () => {
  it('keeps valid entries and drops malformed ones', () => {
    expect(Object.keys(config.countries)).toEqual(['NL']);
    expect(parsePlanCountryPricing(null)).toEqual({ countries: {} });
    expect(parsePlanCountryPricing({ countries: 'x' })).toEqual({ countries: {} });
  });

  it('resolves a listed country to its prices; plans it leaves out stay on request', () => {
    const nl = resolveCountryPlanPrices(config, 'nl');
    expect(nl.country).toBe('NL');
    expect(nl.currency).toBe('EUR');
    expect(nl.plans.business).toEqual({ monthly: 39, annual: 33 });
    expect(nl.plans.scale).toEqual({ monthly: 59, annual: null });
    expect(nl.plans.enterprise).toBeNull();
  });

  it('resolves an unlisted or unknown country to everything on request', () => {
    for (const country of ['FR', null, undefined, 'XX', 'T1', 'Netherlands']) {
      const r = resolveCountryPlanPrices(config, country);
      expect(r.currency).toBeNull();
      expect(r.plans).toEqual({ business: null, scale: null, enterprise: null });
    }
  });

  it('normalises country hints', () => {
    expect(normalizeCountryCode(' be ')).toBe('BE');
    expect(normalizeCountryCode('XX')).toBeNull();
    expect(normalizeCountryCode('NLD')).toBeNull();
  });

  it('maps a plan row to free, priced or on request', () => {
    const nl = resolveCountryPlanPrices(config, 'NL');
    expect(planDisplayPrice('free', nl)).toEqual({ kind: 'free' });
    expect(planDisplayPrice('business', nl)).toEqual({
      kind: 'priced',
      price: { monthly: 39, annual: 33 },
      currency: 'EUR',
    });
    expect(planDisplayPrice('enterprise', nl)).toEqual({ kind: 'on_request' });
    // A legacy slug never leaks its database price.
    expect(planDisplayPrice('starter', nl)).toEqual({ kind: 'on_request' });
    expect(planDisplayPrice('business', resolveCountryPlanPrices(config, 'FR'))).toEqual({ kind: 'on_request' });
  });

  it('reads the request country from request.cf, then CF-IPCountry', () => {
    const withCf = Object.assign(new Request('https://x.test'), { cf: { country: 'NL' } });
    expect(requestCountry(withCf)).toBe('NL');
    expect(requestCountry(new Request('https://x.test', { headers: { 'cf-ipcountry': 'be' } }))).toBe('BE');
    expect(requestCountry(new Request('https://x.test', { headers: { 'cf-ipcountry': 'XX' } }))).toBeNull();
    expect(requestCountry(new Request('https://x.test'))).toBeNull();
  });
});
