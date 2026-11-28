import { describe, expect, it } from 'vitest';
import { actionLabel, centsToMajorUnits, parseMajorUnitsToCents } from './billing-format';
import { adminCopy } from './i18n';

describe('actionLabel', () => {
  it('labels the Mollie card’s seat price change in the activity log', () => {
    expect(actionLabel(adminCopy(), 'workspace.billing.seat_price')).toBe('Seat price changed');
  });

  it('labels the SSO actions Global recorded', () => {
    expect(actionLabel(adminCopy(), 'sso.revoke')).toBe('SSO revoked');
  });

  it('leaves an action it doesn’t know as it is', () => {
    expect(actionLabel(adminCopy(), 'workspace.billing.unknown')).toBe('workspace.billing.unknown');
  });
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
