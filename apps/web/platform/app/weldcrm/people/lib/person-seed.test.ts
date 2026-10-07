import { describe, expect, it } from 'vitest';
import { personSeedFromQuery } from './person-seed';

describe('personSeedFromQuery', () => {
  it('splits a typed name into first and last name', () => {
    expect(personSeedFromQuery('  Jane Marie Doe ')).toEqual({
      firstName: 'Jane',
      lastName: 'Marie Doe',
      email: '',
    });
  });

  it('fills the email and guesses a name from the local part', () => {
    expect(personSeedFromQuery('jane.doe@acme.com')).toEqual({
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane.doe@acme.com',
    });
  });

  it('keeps both the display name and the address from "Name <email>"', () => {
    expect(personSeedFromQuery('Ada Lovelace <ada@analytical.dev>')).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@analytical.dev',
    });
  });

  it('returns empty fields for a blank query', () => {
    expect(personSeedFromQuery('   ')).toEqual({
      firstName: '',
      lastName: '',
      email: '',
    });
  });
});