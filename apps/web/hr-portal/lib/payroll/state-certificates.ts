/**
 * The state withholding certificates the portal renders, from the state
 * modules in `@weldsuite/payroll-domain` (form name, filing statuses,
 * allowances, the form's own lines) and their labels
 * (`STATE_CERTIFICATE_LABELS`, keyed `<ST>.<key>` and `<ST>.<key>.<option>`).
 *
 * A certificate's field list is the whole form. Filing status, allowances,
 * extra withholding and exempt are answers of the election itself, which the
 * form shows with its own controls; `fields` here holds only the other lines,
 * which the API stores in the election's `values`. A state without a module
 * certificate gets the generic form (filing status, allowances, extra
 * withholding, exempt).
 */

import { isCertificateTopLevelKey, stateModule, type StateCertificateFieldDef } from '@weldsuite/payroll-domain/us/states';
import { STATE_CERTIFICATE_LABELS } from '@weldsuite/payroll-domain/us/states/certificate-labels';
import type { Locale } from '@/lib/i18n';
import { humanizeKey } from '@/lib/payroll/format';

export type { StateCertificateFieldDef };

export interface StateCertificateDef {
  formName: string;
  /** `filingStatus` options, if the form has one. */
  filingStatuses?: string[];
  usesAllowances: boolean;
  /** Whether the form has an extra-withholding line and an exempt claim. */
  asksExtraWithholding: boolean;
  asksExempt: boolean;
  /** The form's other lines, stored in the election's `values`. */
  fields: StateCertificateFieldDef[];
}

/** The state's certificate, or null when the state has none (the portal then shows the generic form). */
export function getStateCertificate(state: string): StateCertificateDef | null {
  const certificate = stateModule(state)?.certificate;
  if (!certificate) return null;
  const keys = new Set(certificate.fields.map((field) => field.key));
  return {
    formName: certificate.formName,
    ...(certificate.filingStatuses ? { filingStatuses: certificate.filingStatuses } : {}),
    usesAllowances: certificate.usesAllowances,
    asksExtraWithholding: keys.has('extraWithholding'),
    asksExempt: keys.has('exempt'),
    fields: certificate.fields.filter((field) => !isCertificateTopLevelKey(field.key)),
  };
}

/** Label of one certificate field in the viewer's language; the humanised key when nobody translated it. */
export function stateCertificateFieldLabel(state: string, key: string, locale: Locale): string {
  return STATE_CERTIFICATE_LABELS[`${state.toUpperCase()}.${key}`]?.[locale] ?? humanizeKey(key);
}

/** Label of a select option (a filing status, or an option of another field); the humanised option otherwise. */
export function stateCertificateOptionLabel(state: string, key: string, option: string, locale: Locale): string {
  return STATE_CERTIFICATE_LABELS[`${state.toUpperCase()}.${key}.${option}`]?.[locale] ?? humanizeKey(option);
}
