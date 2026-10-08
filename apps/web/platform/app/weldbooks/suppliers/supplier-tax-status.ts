import type { VendorTaxView } from '@/lib/api/domains/weldbooks-1099';

/** What the supplier list says about a vendor's TIN. */
export type SupplierTinStatus =
  /** Not a 1099 vendor and no TIN stored: nothing to say. */
  | 'none'
  /** A 1099 vendor with no TIN on file: a W-9 is needed. */
  | 'missing'
  /** A TIN is stored and the IRS has not been asked, or has not answered. */
  | 'on_file'
  /** The IRS TIN matching service confirmed the name and TIN. */
  | 'matched'
  /** The IRS could not match the name and TIN. */
  | 'mismatch'
  /** A TIN matching file went out and no result is in yet. */
  | 'pending';

const MATCH_PROBLEMS: readonly string[] = ['mismatch', 'not_issued', 'invalid'];

export function supplierTinStatus(
  vendor: Pick<VendorTaxView, 'is1099Vendor' | 'hasTin' | 'tinLast4' | 'tinMatchStatus'>,
): SupplierTinStatus {
  const hasTin = Boolean(vendor.hasTin ?? vendor.tinLast4);
  if (!hasTin) return vendor.is1099Vendor ? 'missing' : 'none';
  const match = vendor.tinMatchStatus ?? '';
  if (MATCH_PROBLEMS.includes(match)) return 'mismatch';
  if (match === 'match') return 'matched';
  if (match === 'pending') return 'pending';
  return 'on_file';
}

/** True when the vendor needs attention before 1099s can be filed. */
export function supplierNeedsTinAttention(status: SupplierTinStatus): boolean {
  return status === 'missing' || status === 'mismatch';
}
