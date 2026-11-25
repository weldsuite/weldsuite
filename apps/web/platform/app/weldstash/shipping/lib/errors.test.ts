import { describe, expect, it } from 'vitest';
import { ApiError } from '@weldsuite/api-client';
import { shippingErrorInfo } from './errors';

const translated = { CARRIER_UNAUTHORIZED: 'Credentials refused.' };

describe('shippingErrorInfo', () => {
  it('translates a known code and keeps the carrier messages', () => {
    const error = new ApiError('raw', 400, {
      error: { code: 'CARRIER_UNAUTHORIZED', message: 'raw', details: { messages: ['Invalid API key', 7, ''] } },
    });
    expect(shippingErrorInfo(error, translated, 'fallback')).toEqual({
      code: 'CARRIER_UNAUTHORIZED',
      status: 400,
      message: 'Credentials refused.',
      messages: ['Invalid API key'],
    });
  });

  it('falls back to the server message for an unknown code', () => {
    const error = new ApiError('Something odd', 500, { error: { code: 'WEIRD', message: 'Something odd' } });
    expect(shippingErrorInfo(error, translated, 'fallback').message).toBe('Something odd');
  });

  it('uses the fallback for something that is not an API error', () => {
    expect(shippingErrorInfo('boom', translated, 'fallback')).toEqual({ code: null, status: null, message: 'fallback', messages: [] });
  });
});
