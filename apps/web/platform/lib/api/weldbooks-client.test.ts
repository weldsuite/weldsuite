import { describe, expect, it } from 'vitest';
import { formatErrorMessage } from './weldbooks-client';

describe('formatErrorMessage', () => {
  it('reads the API error envelope', () => {
    expect(formatErrorMessage({ error: { code: 'BAD_REQUEST', message: 'Account code already exists' } }, 400)).toBe(
      'Account code already exists',
    );
    expect(formatErrorMessage({ error: 'Not found' }, 404)).toBe('Not found');
  });

  it('says which field a refused body got wrong', () => {
    const body = {
      success: false,
      error: {
        name: 'ZodError',
        issues: [
          { code: 'invalid_type', expected: 'string', message: 'Expected string, received number', path: ['openingBalance'] },
          { code: 'too_small', message: 'Array must contain at least 2 element(s)', path: ['lines'] },
        ],
      },
    };
    expect(formatErrorMessage(body, 400)).toBe(
      'openingBalance: Expected string, received number. lines: Array must contain at least 2 element(s)',
    );
  });

  it('falls back to the status', () => {
    expect(formatErrorMessage({ error: { issues: [] } }, 400)).toBe('Request failed with status 400');
    expect(formatErrorMessage(null, 500)).toBe('Request failed with status 500');
  });
});
