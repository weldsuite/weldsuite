import { describe, it, expect } from 'vitest';
import { plural } from './plural';

describe('plural (i18n)', () => {
  it('returns the "one" form for count=1 in English', () => {
    expect(
      plural(1, { one: '{count} item', other: '{count} items' }, 'en'),
    ).toBe('1 item');
  });

  it('returns the "other" form for count=5 in English', () => {
    expect(
      plural(5, { one: '{count} item', other: '{count} items' }, 'en'),
    ).toBe('5 items');
  });

  it('returns "other" for zero in English (English has no zero category)', () => {
    expect(
      plural(0, { one: '{count} item', other: '{count} items' }, 'en'),
    ).toBe('0 items');
  });

  it('substitutes {count} multiple times', () => {
    expect(
      plural(
        3,
        { other: '{count} of {count} loaded' },
        'en',
      ),
    ).toBe('3 of 3 loaded');
  });

  it('falls back to "other" when the locale-specific form is missing', () => {
    // Only "other" provided; English would normally pick "one" for 1.
    expect(plural(1, { other: '{count} items' }, 'en')).toBe('1 items');
  });

  it('renders Dutch pluralization (one for 1, other for everything else)', () => {
    expect(plural(1, { one: '{count} item', other: '{count} items' }, 'nl')).toBe('1 item');
    expect(plural(2, { one: '{count} item', other: '{count} items' }, 'nl')).toBe('2 items');
  });
});
