import { describe, expect, it } from 'vitest';
import { updateProfileSchema } from './settings-profile-schema';

describe('updateProfileSchema', () => {
  it('rejects an empty or whitespace-only name', () => {
    expect(updateProfileSchema.safeParse({ name: '' }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('trims the name and lets it be omitted', () => {
    expect(updateProfileSchema.parse({ name: '  Gert  ' }).name).toBe('Gert');
    expect(updateProfileSchema.parse({ bio: 'hi' }).name).toBeUndefined();
  });

  it('rejects an oversized name', () => {
    expect(updateProfileSchema.safeParse({ name: 'a'.repeat(201) }).success).toBe(false);
  });

  it('rejects junk phone numbers', () => {
    expect(updateProfileSchema.safeParse({ phone: 'not-a-phone!!' }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ phone: '12' }).success).toBe(false);
  });

  it('accepts and normalises real phone numbers, and allows empty', () => {
    expect(updateProfileSchema.parse({ phone: ' +31   6 12345678 ' }).phone).toBe('+31 6 12345678');
    expect(updateProfileSchema.parse({ phone: '+1 (555) 123-4567' }).phone).toBe('+1 (555) 123-4567');
    expect(updateProfileSchema.parse({ phone: '' }).phone).toBe('');
  });
});
