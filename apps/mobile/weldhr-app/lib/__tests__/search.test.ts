import { matchesSearch, normalizeSearch } from '../search';

describe('normalizeSearch', () => {
  it('ignores case, accents and surrounding space', () => {
    expect(normalizeSearch('  Café Überweg ')).toBe('cafe uberweg');
  });
});

describe('matchesSearch', () => {
  const lunch = ['Lunch met klant', 'Maaltijden', 'Goedgekeurd', '€ 18,50', 'wo 14 okt'];

  it('matches everything while the query is empty', () => {
    expect(matchesSearch('', lunch)).toBe(true);
    expect(matchesSearch('   ', lunch)).toBe(true);
  });

  it('finds a word in any field', () => {
    expect(matchesSearch('klant', lunch)).toBe(true);
    expect(matchesSearch('maaltijd', lunch)).toBe(true);
    expect(matchesSearch('18,50', lunch)).toBe(true);
  });

  it('needs every word, each in some field', () => {
    expect(matchesSearch('lunch okt', lunch)).toBe(true);
    expect(matchesSearch('lunch sep', lunch)).toBe(false);
  });

  it('skips empty fields', () => {
    expect(matchesSearch('note', ['Headset', null, undefined, ''])).toBe(false);
  });
});
