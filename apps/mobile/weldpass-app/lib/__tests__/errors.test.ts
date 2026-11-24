import { ApiError, NetworkError } from '@weldsuite/api-client/client';

import { passErrorKind, passErrorMessage } from '@/lib/errors';
import { en } from '@/lib/i18n/locales/en';
import { nl } from '@/lib/i18n/locales/nl';

describe('WeldPass errors in words', () => {
  it("tells a viewer's 403 apart", () => {
    const forbidden = new ApiError('Forbidden', 403, { error: { code: 'FORBIDDEN', message: 'Forbidden' } });
    expect(passErrorKind(forbidden)).toBe('forbidden');
    expect(passErrorMessage(en, forbidden)).toBe(en.errors.forbidden);
  });

  it("explains a server without a usable root key (500 CRYPTO_ERROR)", () => {
    const crypto = new ApiError('Could not decrypt', 500, { error: { code: 'CRYPTO_ERROR', message: 'x' } });
    expect(passErrorKind(crypto)).toBe('crypto');
    expect(passErrorMessage(nl, crypto)).toBe(nl.errors.crypto);
  });

  it('knows offline, gone and anything else', () => {
    expect(passErrorKind(new NetworkError())).toBe('offline');
    expect(passErrorKind(new ApiError('Not found', 404))).toBe('notFound');
    expect(passErrorKind(new ApiError('Oops', 500, 'not json'))).toBe('generic');
    expect(passErrorKind(new Error('boom'))).toBe('generic');
  });
});

describe('the translations', () => {
  /** Every key path of a catalog, so en and nl can be compared. */
  function paths(value: unknown, prefix = ''): string[] {
    if (typeof value !== 'object' || value === null) return [prefix];
    return Object.entries(value).flatMap(([key, child]) => paths(child, prefix ? `${prefix}.${key}` : key));
  }

  it('have the same keys in English and Dutch, none of them empty', () => {
    expect(paths(nl).sort()).toEqual(paths(en).sort());
    const empty = (catalog: unknown) =>
      paths(catalog).filter((path) => {
        const leaf = path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], catalog);
        return leaf === '';
      });
    expect(empty(en)).toEqual([]);
    expect(empty(nl)).toEqual([]);
  });
});
