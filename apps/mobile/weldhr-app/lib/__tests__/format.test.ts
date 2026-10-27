import { firstName, formatDateRange, formatDays, formatDuration, formatHoursMinutes, formatLongDay, formatMoney, formatSpan, formatTimer, parseAmount } from '../format';

const NOW = new Date(2026, 9, 24);

describe('parseAmount', () => {
  it('reads Dutch and English decimal separators', () => {
    expect(parseAmount('12,50')).toBe(12.5);
    expect(parseAmount('12.5')).toBe(12.5);
    expect(parseAmount('1.234,56')).toBe(1234.56);
    expect(parseAmount('1,234.56')).toBe(1234.56);
    expect(parseAmount('€ 7')).toBe(7);
  });

  it('rounds to cents and refuses nothing, zero and negatives', () => {
    expect(parseAmount('3.456')).toBe(3.46);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('-4')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });
});

describe('formatDateRange', () => {
  it('collapses a single day and a shared month', () => {
    expect(formatDateRange('2026-11-03', '2026-11-07', 'en-GB', NOW)).toBe('3 – 7 Nov');
    expect(formatDateRange('2026-10-30', '2026-11-02', 'en-GB', NOW)).toBe('30 Oct – 2 Nov');
    expect(formatDateRange('2026-11-03', '2026-11-03', 'en-GB', NOW)).toBe(
      new Date(2026, 10, 3).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }),
    );
  });

  it('shows years when the range leaves this year', () => {
    expect(formatDateRange('2026-12-30', '2027-01-02', 'en-GB', NOW)).toBe('30 Dec 2026 – 2 Jan 2027');
  });
});

describe('numbers', () => {
  it('formats money in the locale', () => {
    expect(formatMoney(12.5, 'EUR', 'en-GB')).toBe('€12.50');
    expect(formatMoney('1250.00', 'EUR', 'nl-NL')).toMatch(/1\.250,00/);
  });

  it('formats leave days and worked hours', () => {
    expect(formatDays(2, 'en-GB')).toBe('2');
    expect(formatDays(1.5, 'nl-NL')).toBe('1,5');
    expect(formatDuration(465)).toBe('7:45');
    expect(formatDuration(null)).toBe('');
  });

  it('takes the first word of a name', () => {
    expect(firstName('  Sam de Vries ')).toBe('Sam');
    expect(firstName(undefined)).toBe('');
  });
});

describe('hours and clocks', () => {
  it('writes minutes as hours and minutes', () => {
    expect(formatHoursMinutes(420, '{h}h {m}m')).toBe('7h 0m');
    expect(formatHoursMinutes(65, '{h}u {m}m')).toBe('1u 5m');
    expect(formatHoursMinutes(null, '{h}h {m}m')).toBe('0h 0m');
  });

  it('runs a clock in hours, minutes and seconds', () => {
    expect(formatTimer(8_000)).toBe('00:00:08');
    expect(formatTimer(3_728_000)).toBe('01:02:08');
    expect(formatTimer(-5)).toBe('00:00:00');
  });

  it('spells out a day and a span', () => {
    expect(formatLongDay('2026-10-25', 'en-GB', NOW)).toBe('Sunday 25 October');
    expect(formatSpan('2026-10-19', '2026-10-25', 'en-GB')).toBe('19 Oct – 25 Oct');
    expect(formatSpan('2026-10-19', '2026-10-19', 'en-GB')).toBe('19 Oct');
  });
});
