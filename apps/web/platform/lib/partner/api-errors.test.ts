import { describe, expect, it } from 'vitest';
import { ApiError } from '@weldsuite/api-client';
import {
  apiErrorCode,
  isNotLicensedError,
  isPartnerManagedError,
  isReadOnlyError,
  territoryErrorDetails,
} from './api-errors';
import { safeHttpUrl } from './safe-url';

const partner = {
  id: 'ptr_1',
  name: 'Acme Partner',
  logoUrl: null,
  websiteUrl: 'https://partner.example',
  supportEmail: 'help@partner.example',
  supportUrl: null,
};

describe('api error codes', () => {
  it('reads the code from the standard error envelope', () => {
    const err = new ApiError('nope', 403, { error: { code: 'APP_NOT_LICENSED', message: 'nope', details: { app: 'welddesk' } } });
    expect(apiErrorCode(err)).toBe('APP_NOT_LICENSED');
    expect(isNotLicensedError(err)).toBe(true);
    expect(isReadOnlyError(err)).toBe(false);
  });

  it('reads a top-level code too (billing guards)', () => {
    const err = new ApiError('managed', 403, { code: 'PARTNER_MANAGED' });
    expect(isPartnerManagedError(err)).toBe(true);
  });

  it('recognises a read-only workspace', () => {
    const err = new ApiError('paused', 403, { error: { code: 'WORKSPACE_READ_ONLY', message: 'paused' } });
    expect(isReadOnlyError(err)).toBe(true);
  });

  it('ignores anything that is not an API failure', () => {
    expect(apiErrorCode(new Error('boom'))).toBeNull();
    expect(apiErrorCode(null)).toBeNull();
    expect(apiErrorCode(new ApiError('x', 500, 'plain text'))).toBeNull();
  });
});

describe('territoryErrorDetails', () => {
  it('returns the partner behind a 409 PARTNER_TERRITORY', () => {
    const err = new ApiError('served by a partner', 409, {
      error: { code: 'PARTNER_TERRITORY', message: 'served by a partner', details: { country: 'BR', partner } },
    });
    expect(territoryErrorDetails(err)).toEqual({ country: 'BR', partner });
  });

  it('is null for other errors and for a malformed body', () => {
    expect(territoryErrorDetails(new ApiError('x', 409, { error: { code: 'CONFLICT' } }))).toBeNull();
    expect(territoryErrorDetails(new ApiError('x', 409, { error: { code: 'PARTNER_TERRITORY' } }))).toBeNull();
  });
});

describe('safeHttpUrl', () => {
  it('keeps http(s) addresses', () => {
    expect(safeHttpUrl('https://partner.example/help')).toBe('https://partner.example/help');
    expect(safeHttpUrl('http://partner.example/')).toBe('http://partner.example/');
  });

  it('drops anything that could run script or is not a URL', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
  });
});
