/**
 * The state withholding certificates the portal can render.
 *
 * Each US state module in `@weldsuite/payroll-domain` declares its certificate
 * (`stateModule(code).certificate`: form name, filing statuses, allowances,
 * extra fields) and the field labels live in `STATE_CERTIFICATE_LABELS`
 * (`packages/domains/payroll/src/us/states/{types,certificate-labels}.ts`).
 *
 * This app does not depend on `@weldsuite/payroll-domain` yet, so those
 * definitions are not reachable here. The interfaces below are local copies of
 * the domain's `StateCertificateFieldDef` and `StateModule['certificate']`, and
 * the tables below are empty for now. The portal then shows the generic
 * certificate (filing status, allowances, extra withholding, exempt), which is
 * the set of fields the API accepts for every state.
 *
 * To switch to the real definitions, add `"@weldsuite/payroll-domain":
 * "workspace:*"` to this app's dependencies and its `transpilePackages`, then
 * make `getStateCertificate` return `stateModule(state)?.certificate ?? null`
 * (from '@weldsuite/payroll-domain/us/states') and read the labels from
 * `STATE_CERTIFICATE_LABELS` (from '.../us/states/certificate-labels')
 * instead of the empty local tables below.
 */

import type { Locale } from '@/lib/i18n';
import { humanizeKey } from '@/lib/payroll/format';

export interface StateCertificateFieldDef {
  key: string;
  type: 'select' | 'number' | 'money' | 'boolean';
  /** For `select`. */
  options?: string[];
  required?: boolean;
  /** Translation key for the label, under `weldhr.payroll.stateCertificates.<state>.<key>`. */
  labelKey: string;
}

export interface StateCertificateDef {
  formName: string;
  /** `filingStatus` options, if the form has one. */
  filingStatuses?: string[];
  usesAllowances: boolean;
  fields: StateCertificateFieldDef[];
}

/**
 * Certificates by two-letter state code. Empty until this app can read the
 * domain package's state modules (see the header): every state then renders
 * the generic certificate.
 */
const CERTIFICATES: Record<string, StateCertificateDef> = {};

/** Same shape and keys (`<ST>.<key>`) as the domain's `STATE_CERTIFICATE_LABELS`. */
const FIELD_LABELS: Record<string, { en: string; nl: string }> = {};

/** The state's certificate, or null when the portal has no definition for it (it falls back to the generic form). */
export function getStateCertificate(state: string): StateCertificateDef | null {
  return CERTIFICATES[state.toUpperCase()] ?? null;
}

/** Label of one certificate field in the viewer's language; the humanised key when nobody translated it. */
export function stateCertificateFieldLabel(state: string, key: string, locale: Locale): string {
  return FIELD_LABELS[`${state.toUpperCase()}.${key}`]?.[locale] ?? humanizeKey(key);
}
