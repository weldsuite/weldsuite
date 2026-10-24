import { describe, expect, it } from 'vitest';
import { testHost } from '../test-host';

describe('function limits and Excel edge cases', () => {
  it('stops COMBIN, COMBINA, PERMUT and BINOM.DIST quickly on huge inputs', () => {
    const run = testHost();
    const started = Date.now();
    expect(run('COMBIN(1e12,5e11)')).toMatchObject({ code: '#NUM!' });
    expect(run('COMBINA(1e12,5e11)')).toMatchObject({ code: '#NUM!' });
    expect(run('PERMUT(1e12,1e12)')).toMatchObject({ code: '#NUM!' });
    expect(typeof run('BINOM.DIST(5e11,1e12,0.5,FALSE)')).toBe('number');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(run('COMBIN(10,3)')).toBe(120);
    expect(run('PERMUT(10,3)')).toBe(720);
  });

  it('rejects WRAPROWS/WRAPCOLS lines longer than a sheet', () => {
    const run = testHost({ A1: 1, A2: 2 });
    expect(run('WRAPROWS(A1:A2,1e9)')).toMatchObject({ code: '#NUM!' });
    expect(run('WRAPCOLS(A1:A2,4e7)')).toMatchObject({ code: '#NUM!' });
    expect(run('WRAPROWS(A1:A2,3)')).toEqual({ kind: 'matrix', rows: 1, cols: 3, data: [[1, 2, { kind: 'error', code: '#N/A' }]] });
  });

  it('reads dates in criteria and matches numeric text on =', () => {
    const run = testHost({ F1: 45658, F2: 45700, B1: '5', B2: 5, B3: 6 });
    expect(run('COUNTIF(F1:F2,">1/1/2025")')).toBe(1);
    expect(run('COUNTIF(F1:F2,">=2025-01-01")')).toBe(2);
    expect(run('COUNTIF(B1:B3,"5")')).toBe(2);
    expect(run('COUNTIF(B1:B3,5)')).toBe(2);
    expect(run('COUNTIF(B1:B3,">4")')).toBe(2);
    expect(run('COUNTIF(B1:B3,"<>5")')).toBe(1);
  });

  it('turns numbers into text with 15 significant digits', () => {
    const run = testHost({ A1: 123456789012, A2: 1e15, A3: 0.1 + 0.2, A4: 1e-7 });
    expect(run('A1&""')).toBe('123456789012');
    expect(run('LEN(A1)')).toBe(12);
    expect(run('VALUE(A1&"")=A1')).toBe(true);
    expect(run('A2&""')).toBe('1E+15');
    expect(run('A3&""')).toBe('0.3');
    expect(run('A4&""')).toBe('0.0000001');
  });
});
