/**
 * Payslip line labels for both countries, in English and Dutch. The PDF
 * renderer and the platform UI translate `PayslipLine.labelKey` with this;
 * a line's own `label` (a user-named component) wins over it.
 */

import { NL_PAYSLIP_LABELS } from './nl/labels';
import { US_PAYSLIP_LABELS } from './us/labels';
import { STATE_PAYSLIP_LABELS } from './us/states/labels';

export const PAYSLIP_LABELS: Record<string, { en: string; nl: string }> = {
  ...STATE_PAYSLIP_LABELS,
  ...US_PAYSLIP_LABELS,
  ...NL_PAYSLIP_LABELS,
};

export function payslipLineLabel(line: { labelKey: string; label?: string | null }, lang: 'en' | 'nl'): string {
  if (line.label) return line.label;
  return PAYSLIP_LABELS[line.labelKey]?.[lang] ?? line.labelKey;
}
