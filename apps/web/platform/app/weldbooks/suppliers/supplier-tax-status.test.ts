import { describe, expect, it } from 'vitest';
import { supplierNeedsTinAttention, supplierTinStatus } from './supplier-tax-status';

describe('supplierTinStatus', () => {
  it('says nothing about a vendor that is not reported and has no TIN', () => {
    expect(supplierTinStatus({ is1099Vendor: false, hasTin: false })).toBe('none');
    expect(supplierTinStatus({})).toBe('none');
  });

  it('flags a 1099 vendor with no TIN as missing', () => {
    expect(supplierTinStatus({ is1099Vendor: true, hasTin: false })).toBe('missing');
    expect(supplierTinStatus({ is1099Vendor: true, tinLast4: null })).toBe('missing');
  });

  it('reads the IRS match result', () => {
    expect(supplierTinStatus({ is1099Vendor: true, hasTin: true })).toBe('on_file');
    expect(supplierTinStatus({ hasTin: true, tinMatchStatus: 'match' })).toBe('matched');
    expect(supplierTinStatus({ hasTin: true, tinMatchStatus: 'mismatch' })).toBe('mismatch');
    expect(supplierTinStatus({ hasTin: true, tinMatchStatus: 'not_issued' })).toBe('mismatch');
    expect(supplierTinStatus({ hasTin: true, tinMatchStatus: 'invalid' })).toBe('mismatch');
    expect(supplierTinStatus({ hasTin: true, tinMatchStatus: 'pending' })).toBe('pending');
  });

  it('shows a stored TIN on a vendor that is not (yet) reported', () => {
    expect(supplierTinStatus({ is1099Vendor: false, hasTin: true })).toBe('on_file');
  });

  it('needs attention for a missing TIN or a failed match only', () => {
    expect(supplierNeedsTinAttention('missing')).toBe(true);
    expect(supplierNeedsTinAttention('mismatch')).toBe(true);
    expect(supplierNeedsTinAttention('matched')).toBe(false);
    expect(supplierNeedsTinAttention('on_file')).toBe(false);
  });
});
