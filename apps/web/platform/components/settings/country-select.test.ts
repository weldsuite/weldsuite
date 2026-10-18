import { describe, expect, it } from 'vitest';
import { COUNTRIES } from '@/lib/constants/countries';
import { localizedCountries } from './country-select';

describe('localizedCountries', () => {
  it('offers the full country list (not a handful)', () => {
    const countries = localizedCountries('en');
    expect(countries).toHaveLength(COUNTRIES.length);
    expect(countries.length).toBeGreaterThan(150);
  });

  it('names countries in the UI language and sorts by that name', () => {
    const en = localizedCountries('en');
    const nl = localizedCountries('nl');
    expect(en.find((c) => c.code === 'NL')?.name).toBe('Netherlands');
    expect(nl.find((c) => c.code === 'NL')?.name).toBe('Nederland');
    expect(nl.find((c) => c.code === 'DE')?.name).toBe('Duitsland');

    const names = nl.map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'nl')));
  });
});
