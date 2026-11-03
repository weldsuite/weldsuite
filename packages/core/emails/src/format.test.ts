import { describe, expect, it } from 'vitest';
import { periodLabel } from './format';

describe('periodLabel', () => {
  it('writes an ISO week as "Week 45, 2026" in both languages', () => {
    expect(periodLabel('en', '2026-W45')).toBe('Week 45, 2026');
    expect(periodLabel('nl', '2026-W45')).toBe('Week 45, 2026');
    expect(periodLabel('en', '2026-W05')).toBe('Week 5, 2026');
    expect(periodLabel('en', '2026-W53')).toBe('Week 53, 2026');
  });

  it('writes a month in the language of the reader', () => {
    expect(periodLabel('en', '2026-11')).toBe('November 2026');
    expect(periodLabel('nl', '2026-11')).toBe('november 2026');
    expect(periodLabel('en', '2026-01')).toBe('January 2026');
    expect(periodLabel('nl', '2026-03')).toBe('maart 2026');
    expect(periodLabel('nl', '2026-12')).toBe('december 2026');
  });

  it('returns anything else as it is', () => {
    for (const other of ['2026-W00', '2026-W54', '2026-13', '2026-00', '2026', 'Q4', '', ' 2026-W45']) {
      expect(periodLabel('en', other)).toBe(other);
    }
  });
});
