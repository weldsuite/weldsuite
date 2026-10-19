import { describe, expect, it } from 'vitest';
import {
  isValidPhone,
  normalizePhone,
  resolveProfileTimezone,
  validateProfile,
  validateProfileName,
} from './profile-validation';

describe('validateProfileName', () => {
  it('rejects empty and whitespace-only names', () => {
    expect(validateProfileName('')).toBe('nameRequired');
    expect(validateProfileName('   ')).toBe('nameRequired');
  });
  it('accepts a normal name and rejects an oversized one', () => {
    expect(validateProfileName(' Gert ')).toBeNull();
    expect(validateProfileName('a'.repeat(201))).toBe('nameTooLong');
  });
});

describe('isValidPhone', () => {
  it('allows empty', () => {
    expect(isValidPhone('')).toBe(true);
    expect(isValidPhone('   ')).toBe(true);
  });
  it.each(['+31 6 12345678', '+1 (555) 123-4567', '020-1234567', '06 12 34 56 78'])(
    'accepts %s',
    (v) => expect(isValidPhone(v)).toBe(true),
  );
  it.each(['not-a-phone!!', 'abc', '12', '+31 6 1234 abc', '1+2345678', '1'.repeat(16)])(
    'rejects %s',
    (v) => expect(isValidPhone(v)).toBe(false),
  );
  it('normalises whitespace', () => {
    expect(normalizePhone('  +31   6 1234  ')).toBe('+31 6 1234');
  });
});

describe('validateProfile', () => {
  it('reports both fields', () => {
    expect(validateProfile({ name: '', phone: 'x!' })).toEqual({
      name: 'nameRequired',
      phone: 'phoneInvalid',
    });
  });
});

describe('resolveProfileTimezone', () => {
  it('prefills the browser zone when unset or the UTC default', () => {
    expect(resolveProfileTimezone(undefined, 'Europe/Amsterdam')).toEqual({
      timezone: 'Europe/Amsterdam',
      prefilled: true,
    });
    expect(resolveProfileTimezone(null, 'Europe/Amsterdam').prefilled).toBe(true);
    expect(resolveProfileTimezone('UTC', 'Europe/Amsterdam')).toEqual({
      timezone: 'Europe/Amsterdam',
      prefilled: true,
    });
  });
  it('keeps an explicitly saved zone', () => {
    expect(resolveProfileTimezone('America/New_York', 'Europe/Amsterdam')).toEqual({
      timezone: 'America/New_York',
      prefilled: false,
    });
  });
  it('stays UTC when the browser is UTC', () => {
    expect(resolveProfileTimezone('UTC', 'UTC')).toEqual({ timezone: 'UTC', prefilled: false });
  });
});
