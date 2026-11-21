import { describe, expect, it } from 'vitest';
import { ApiError } from '@weldsuite/api-client';
import { fieldErrorsOf } from './field-errors';

const body = (code: string, fields?: unknown) => ({ error: { code, message: 'x', details: { fields } } });

describe('fieldErrorsOf', () => {
  it('reads the fields of a validation failure', () => {
    const err = new ApiError('x', 422, body('VALIDATION_FAILED', { b1: { code: 'required' } }));
    expect(fieldErrorsOf(err)).toEqual({ b1: { code: 'required' } });
  });

  it('is null for other failures', () => {
    expect(fieldErrorsOf(new ApiError('x', 500, body('INTERNAL')))).toBeNull();
    expect(fieldErrorsOf(new ApiError('x', 422, body('OTHER', {})))).toBeNull();
    expect(fieldErrorsOf(new Error('network'))).toBeNull();
  });
});
