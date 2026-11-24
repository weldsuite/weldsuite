import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { PARCEL_STATUSES } from '@weldsuite/app-api-client/schemas/shipping';
import { PARCEL_STATUS_TONES, parcelStatusLabel, parcelStatusTone } from './parcel-status';

describe('parcelStatusTone', () => {
  it('has a tone for every parcel status', () => {
    expect(Object.keys(PARCEL_STATUS_TONES).sort()).toEqual([...PARCEL_STATUSES].sort());
  });

  it.each([
    ['delivered', 'success'],
    ['exception', 'danger'],
    ['in_transit', 'warning'],
    ['cancelled', 'neutral'],
  ])('maps %s to %s', (status, tone) => {
    expect(parcelStatusTone(status)).toBe(tone);
  });

  it('is neutral for a status this build does not know', () => {
    expect(parcelStatusTone('teleported')).toBe('neutral');
  });
});

describe('parcelStatusLabel', () => {
  it('uses the translated label', () => {
    expect(parcelStatusLabel(en.weldstash.shipping.statuses, 'delivered')).toBe(en.weldstash.shipping.statuses.delivered);
  });

  it('falls back to the raw code with spaces for an unknown status', () => {
    expect(parcelStatusLabel(en.weldstash.shipping.statuses, 'out_for_delivery')).toBe('out for delivery');
  });
});
