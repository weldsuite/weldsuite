import { describe, it, expect } from 'vitest';
import { deriveDisplayName, PersonVersionConflictError } from './people';

describe('deriveDisplayName (people)', () => {
  it('combines firstName + lastName when both present', () => {
    expect(
      deriveDisplayName({ firstName: 'Jane', lastName: 'Doe', fullName: null, email: null }),
    ).toBe('Jane Doe');
  });

  it('falls back to fullName when first/last are empty', () => {
    expect(
      deriveDisplayName({ firstName: '', lastName: null, fullName: 'Jane Doe', email: null }),
    ).toBe('Jane Doe');
  });

  it('falls back to email when no name fields are set', () => {
    expect(
      deriveDisplayName({ firstName: null, lastName: null, fullName: null, email: 'jane@x.test' }),
    ).toBe('jane@x.test');
  });

  it('returns "Unnamed" when nothing usable is present', () => {
    expect(
      deriveDisplayName({ firstName: null, lastName: null, fullName: null, email: null }),
    ).toBe('Unnamed');
  });

  it('trims whitespace so " " is treated as empty', () => {
    expect(
      deriveDisplayName({
        firstName: '  ',
        lastName: '  ',
        fullName: '  ',
        email: '  ',
      }),
    ).toBe('Unnamed');
  });

  it('uses only firstName when lastName is missing', () => {
    expect(
      deriveDisplayName({ firstName: 'Jane', lastName: null, fullName: null, email: null }),
    ).toBe('Jane');
  });
});

describe('PersonVersionConflictError', () => {
  it('carries the isConflict flag for route 409 mapping', () => {
    const err = new PersonVersionConflictError();
    expect(err.isConflict).toBe(true);
    expect(err.name).toBe('PersonVersionConflictError');
  });
});
