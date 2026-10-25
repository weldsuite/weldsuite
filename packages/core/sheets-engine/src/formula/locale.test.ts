import { describe, expect, it } from 'vitest';
import { delocalizeFormula, localizeFormula } from './locale';

const NL = { decimal: ',' } as const;

describe('formula locale', () => {
  it('converts separators and decimals for decimal-comma locales', () => {
    expect(localizeFormula('ROUND(A1*1.5,2)', NL)).toBe('ROUND(A1*1,5;2)');
    expect(localizeFormula('SUM({1,2;3.5,4})', NL)).toBe(String.raw`SUM({1\2;3,5\4})`);
    expect(localizeFormula('STDEV.P(A1:A9)&"a,b.c"', NL)).toBe('STDEV.P(A1:A9)&"a,b.c"');
    expect(localizeFormula("'Q1, 2.0'!A1+1", NL)).toBe("'Q1, 2.0'!A1+1");
  });

  it('round-trips', () => {
    for (const f of ['IF(A1>0.5,"yes, really",{1,2;3,4})', 'XLOOKUP(B2,Sheet1!A:A,C:C,"none",0,1)', "SUM('a;b'!A1,2.25)"]) {
      expect(delocalizeFormula(localizeFormula(f, NL), NL)).toBe(f);
    }
  });

  it('leaves the canonical locale alone', () => {
    expect(localizeFormula('SUM(1.5,2)', { decimal: '.' })).toBe('SUM(1.5,2)');
  });
});
