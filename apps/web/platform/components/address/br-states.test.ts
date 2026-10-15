import { describe, expect, it } from 'vitest';
import { BR_STATES as DOMAIN_STATES } from '../../../../../packages/domains/books/src/jurisdictions/br/states';
import { BR_STATES, findBrState, toBrUf } from './br-states';

describe('br-states mirror of the books domain', () => {
  it('lists the same states with the same IBGE codes', () => {
    expect(BR_STATES).toEqual(DOMAIN_STATES.map(({ uf, name, ibge }) => ({ uf, name, ibge })));
  });

  it('has 27 units', () => {
    expect(BR_STATES).toHaveLength(27);
  });

  it('finds a state by UF or name, ignoring accents and case', () => {
    expect(findBrState('SP')?.name).toBe('São Paulo');
    expect(findBrState(' sao paulo ')?.uf).toBe('SP');
    expect(findBrState('Ceara')?.uf).toBe('CE');
    expect(findBrState('BR-RJ')?.uf).toBe('RJ');
    expect(findBrState('Atlantis')).toBeUndefined();
  });

  it('turns a typed state into the UF the picker stores', () => {
    expect(toBrUf('Minas Gerais')).toBe('MG');
    expect(toBrUf('Somewhere')).toBe('Somewhere');
    expect(toBrUf(undefined)).toBe('');
  });
});
