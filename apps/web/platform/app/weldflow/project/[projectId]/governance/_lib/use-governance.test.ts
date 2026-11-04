import { describe, expect, it } from 'vitest';
import { fromDateInput, toDateInput } from './use-governance';

describe('date inputs', () => {
  it('turns an ISO timestamp into the value of a date input and back, in UTC', () => {
    expect(toDateInput('2026-11-06T00:00:00.000Z')).toBe('2026-11-06');
    expect(toDateInput(null)).toBe('');
    expect(fromDateInput('2026-11-06')).toBe('2026-11-06T00:00:00.000Z');
    expect(fromDateInput('')).toBeNull();
    expect(fromDateInput(toDateInput('2027-01-15T00:00:00.000Z'))).toBe('2027-01-15T00:00:00.000Z');
  });
});
