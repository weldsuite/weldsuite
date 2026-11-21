import { describe, expect, it } from 'vitest';
import {
  LEGAL_ENTITY_REGISTRATION_TYPES,
  normalizeRegistrationNumber,
  registrationNumberError,
  registrationTypeSchema,
} from './legal-entities';

describe('the OSS registration type', () => {
  it('is a registration type, next to the VAT number', () => {
    expect(LEGAL_ENTITY_REGISTRATION_TYPES).toContain('oss');
    expect(registrationTypeSchema.safeParse('oss').success).toBe(true);
    expect(registrationTypeSchema.safeParse('osss').success).toBe(false);
  });

  it('has no fixed number format: a union-scheme number is a VAT number, a non-union one starts with EU', () => {
    expect(registrationNumberError('oss', 'EU372012345')).toBeNull();
    expect(registrationNumberError('oss', 'NL123456789B01')).toBeNull();
    expect(registrationNumberError('oss', '')).toBe('Enter a number');
    expect(normalizeRegistrationNumber('oss', ' eu 372012345 ')).toBe('EU372012345');
  });
});
