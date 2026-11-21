import { describe, expect, it } from 'vitest';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import { errorMessage, isKeyUnavailable } from './shared';

// What both backends answer when the server's WeldPass root key is missing or wrong.
const keyless = new ApiError('This vault could not be opened.', 500, {
  error: {
    code: 'CRYPTO_ERROR',
    message: 'This vault could not be opened. Its encryption key is unavailable — contact an administrator.',
  },
});

describe('WeldPass errors', () => {
  it('recognises a server that cannot use its root key', () => {
    expect(isKeyUnavailable(keyless)).toBe(true);
    expect(isKeyUnavailable(new ApiError('Not found', 404, { error: { code: 'NOT_FOUND', message: 'Not found' } }))).toBe(false);
    expect(isKeyUnavailable(new Error('offline'))).toBe(false);
    expect(isKeyUnavailable(null)).toBe(false);
  });

  it('says so for WeldPass as a whole, not for one vault', () => {
    expect(errorMessage(keyless, 'Could not create the project.')).toBe(en.weldpass.keyUnavailable);
  });

  it('keeps every other message, and the fallback without one', () => {
    expect(errorMessage(new Error('Name is taken'), 'fallback')).toBe('Name is taken');
    expect(errorMessage(undefined, 'fallback')).toBe('fallback');
  });
});
