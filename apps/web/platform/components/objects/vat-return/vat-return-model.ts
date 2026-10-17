import { statusTone, type ChipTone } from '@/components/accounting/weldbooks-row-cells';

/**
 * The boxes of the aangifte omzetbelasting, in filing order, with the key of
 * their turnover (omzet) and, where the box has one, their BTW amount. Labels
 * come from `accounting.vat.rubriekLabels`. The totals of rubriek 5 follow.
 */
export const VAT_BOXES: ReadonlyArray<{ key: string; turnover: string; vat?: string }> = [
  { key: 'r1a', turnover: 'r1a', vat: 'r1aBtw' },
  { key: 'r1b', turnover: 'r1b', vat: 'r1bBtw' },
  { key: 'r1c', turnover: 'r1c', vat: 'r1cBtw' },
  { key: 'r1d', turnover: 'r1d', vat: 'r1dBtw' },
  { key: 'r1e', turnover: 'r1e' },
  { key: 'r2a', turnover: 'r2a', vat: 'r2aBtw' },
  { key: 'r3a', turnover: 'r3a' },
  { key: 'r3b', turnover: 'r3b' },
  { key: 'r3c', turnover: 'r3c' },
  { key: 'r4a', turnover: 'r4a', vat: 'r4aBtw' },
  { key: 'r4b', turnover: 'r4b', vat: 'r4bBtw' },
];

export const VAT_TOTAL_KEYS = ['r5a', 'r5b', 'r5c', 'r5d', 'r5e', 'r5f', 'r5g'] as const;

/** A stored VAT return or ICP declaration: the shared status tones, plus the calculated / reviewed stages. */
export function vatStatusTone(status: string): ChipTone {
  if (status === 'calculated' || status === 'reviewed') return 'blue';
  return statusTone(status);
}

/** A return that was not filed yet can be filed and deleted; a rejected one can be deleted and calculated again. */
export function canFileVatReturn(status: string): boolean {
  return status === 'calculated' || status === 'reviewed';
}

export function canDeleteVatReturn(status: string): boolean {
  return status === 'calculated' || status === 'reviewed' || status === 'draft' || status === 'rejected';
}

/** A filed return can be followed up at the tax authority and corrected (suppletie). */
export function isFiledVatReturn(status: string): boolean {
  return status === 'filed' || status === 'accepted';
}
