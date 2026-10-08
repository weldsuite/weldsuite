import { describe, expect, it } from 'vitest';
import { decideSourcing, stateCodeOf, zip5Of } from './sourcing';
import { zoneCoversZip } from './zones';

const addr = (state: string, postalCode = '12345') => ({ line1: '1 St', city: 'X', state, postalCode, country: 'US' });

describe('decideSourcing', () => {
  it('interstate sales are destination sourced, even from an origin state', () => {
    const d = decideSourcing({ shipFrom: addr('TX'), shipTo: addr('WA') });
    expect(d).toMatchObject({ sourcing: 'destination', taxingState: 'WA', interstate: true });
    expect(d?.levelSource.state).toBe('destination');
  });

  it('an intrastate sale in an origin state is taxed at the seller', () => {
    for (const state of ['TX', 'AZ', 'IL', 'MS', 'MO', 'OH', 'TN', 'UT', 'VA']) {
      const d = decideSourcing({ shipFrom: addr(state), shipTo: addr(state) });
      expect(d?.sourcing, state).toBe('origin');
      expect(Object.values(d!.levelSource).every((s) => s === 'origin')).toBe(true);
    }
  });

  it('an intrastate sale in a destination state is taxed at the buyer', () => {
    for (const state of ['WA', 'NY', 'FL', 'NM', 'PA']) {
      expect(decideSourcing({ shipFrom: addr(state), shipTo: addr(state) })?.sourcing, state).toBe('destination');
    }
  });

  it('California: state, county and city at the seller, districts at the buyer', () => {
    const d = decideSourcing({ shipFrom: addr('CA'), shipTo: addr('CA') });
    expect(d?.sourcing).toBe('modified_origin');
    expect(d?.levelSource).toEqual({ state: 'origin', county: 'origin', city: 'origin', district: 'destination' });
  });

  it('use tax is always destination sourced', () => {
    expect(decideSourcing({ shipFrom: addr('TX'), shipTo: addr('TX'), direction: 'use' })?.sourcing).toBe('destination');
  });

  it('a ship-from without a state counts as interstate', () => {
    expect(decideSourcing({ shipFrom: {}, shipTo: addr('TX') })?.sourcing).toBe('destination');
  });

  it('returns null without a ship-to state', () => {
    expect(decideSourcing({ shipFrom: addr('TX'), shipTo: null })).toBeNull();
    expect(decideSourcing({ shipFrom: addr('TX'), shipTo: { city: 'Austin' } })).toBeNull();
  });
});

describe('address helpers', () => {
  it('reads a state code or a full name', () => {
    expect(stateCodeOf({ state: 'tx' })).toBe('TX');
    expect(stateCodeOf({ state: 'Texas' })).toBe('TX');
    expect(stateCodeOf({ state: ' new york ' })).toBe('NY');
    expect(stateCodeOf({ state: '' })).toBeUndefined();
    expect(stateCodeOf(null)).toBeUndefined();
  });

  it('cuts ZIP+4 back to five digits and rejects anything else', () => {
    expect(zip5Of({ postalCode: '98105-4321' })).toBe('98105');
    expect(zip5Of({ postalCode: '981054321' })).toBe('98105');
    expect(zip5Of({ postalCode: ' 02134 ' })).toBe('02134');
    expect(zip5Of({ postalCode: 'K1A 0B1' })).toBeUndefined();
    expect(zip5Of({})).toBeUndefined();
  });
});

describe('zoneCoversZip', () => {
  const zone = {
    id: 'z',
    agencyId: 'a',
    stateCode: 'WA',
    name: 'Z',
    jurisdictionIds: [],
    postalCodes: ['98001', '98002-1234', { from: '98100', to: '98199' }],
    isOrigin: false,
    priority: 1,
  };

  it('matches single ZIPs and inclusive ranges', () => {
    expect(zoneCoversZip(zone, '98001')).toBe(true);
    expect(zoneCoversZip(zone, '98002')).toBe(true);
    expect(zoneCoversZip(zone, '98100')).toBe(true);
    expect(zoneCoversZip(zone, '98199')).toBe(true);
    expect(zoneCoversZip(zone, '98150')).toBe(true);
    expect(zoneCoversZip(zone, '98200')).toBe(false);
    expect(zoneCoversZip(zone, '98003')).toBe(false);
    expect(zoneCoversZip(zone, undefined)).toBe(false);
  });
});
