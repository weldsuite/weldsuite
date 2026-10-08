/**
 * Form values and request building of the vendor tax sections of the contact
 * form (1099 reporting, W-9, TIN, ACH bank details, customer tax use).
 *
 * The TIN and the ACH account number are write-only. The form never holds a
 * stored value: it shows a masked one, and `tin` / `achAccountNumber` only
 * carry what the user typed this time. A blank value means "keep what is
 * stored", `removeTin` / `removeAchAccount` send an explicit `null`.
 */
import { z } from 'zod';
import { routingNumberProblem } from '@/app/weldbooks/banking/components/routing-number';
import type {
  LlcTaxClassification,
  VendorTaxPayload,
  VendorTaxView,
  VendorW9,
  W9FederalClassification,
} from '@/lib/api/domains/weldbooks-1099';
import { FORM_1099_ACCOUNT_BOXES, FORM_1099_OMIT, type Form1099Type } from '@/lib/weldbooks/form-1099';
import { isVendorTinType, normalizeTin, tinProblem, type VendorTinType } from '@/lib/weldbooks/vendor-tin';

export const W9_CLASSIFICATIONS = [
  'individual',
  'c_corporation',
  's_corporation',
  'partnership',
  'trust_estate',
  'llc',
  'other',
] as const satisfies readonly W9FederalClassification[];

export const LLC_CLASSIFICATIONS = ['C', 'S', 'P'] as const satisfies readonly LlcTaxClassification[];

export interface VendorTaxFormValues {
  is1099Vendor: boolean;
  default1099Form: '' | Form1099Type;
  /** A box code, `omit`, or '' for none. */
  default1099Box: string;
  tinType: '' | VendorTinType;
  /** What the user typed for the TIN this time; blank keeps the stored one. */
  tin: string;
  removeTin: boolean;
  w9LegalName: string;
  w9BusinessName: string;
  w9Classification: '' | W9FederalClassification;
  w9LlcClassification: '' | LlcTaxClassification;
  w9ExemptPayeeCode: string;
  w9FatcaCode: string;
  /** `YYYY-MM-DD`. */
  w9ReceivedAt: string;
  /** The accounting document holding the scan. */
  w9DocumentId: string;
  w9IsAttorney: boolean;
  backupWithholding: boolean;
  eDeliveryConsent: boolean;
  taxUse: '' | 'business' | 'personal';
  achRoutingNumber: string;
  /** What the user typed for the account number this time; blank keeps the stored one. */
  achAccountNumber: string;
  removeAchAccount: boolean;
  achAccountType: '' | 'checking' | 'savings';
}

export const EMPTY_VENDOR_TAX_VALUES: VendorTaxFormValues = {
  is1099Vendor: false,
  default1099Form: '',
  default1099Box: '',
  tinType: '',
  tin: '',
  removeTin: false,
  w9LegalName: '',
  w9BusinessName: '',
  w9Classification: '',
  w9LlcClassification: '',
  w9ExemptPayeeCode: '',
  w9FatcaCode: '',
  w9ReceivedAt: '',
  w9DocumentId: '',
  w9IsAttorney: false,
  backupWithholding: false,
  eDeliveryConsent: false,
  taxUse: '',
  achRoutingNumber: '',
  achAccountNumber: '',
  removeAchAccount: false,
  achAccountType: '',
};

export function initialVendorTaxValues(contact: VendorTaxView | undefined): VendorTaxFormValues {
  if (!contact) return { ...EMPTY_VENDOR_TAX_VALUES };
  const w9 = contact.w9 ?? {};
  return {
    is1099Vendor: Boolean(contact.is1099Vendor),
    default1099Form: contact.default1099Form === 'nec' || contact.default1099Form === 'misc' ? contact.default1099Form : '',
    default1099Box: contact.default1099Box ?? '',
    tinType: isVendorTinType(contact.tinType) ? contact.tinType : '',
    tin: '',
    removeTin: false,
    w9LegalName: w9.legalName ?? '',
    w9BusinessName: w9.businessName ?? '',
    w9Classification: w9.federalTaxClassification ?? '',
    w9LlcClassification: w9.llcTaxClassification ?? '',
    w9ExemptPayeeCode: w9.exemptPayeeCode ?? '',
    w9FatcaCode: w9.fatcaCode ?? '',
    w9ReceivedAt: w9.receivedAt?.slice(0, 10) ?? '',
    w9DocumentId: w9.documentId ?? '',
    w9IsAttorney: Boolean(w9.isAttorney),
    backupWithholding: Boolean(contact.backupWithholding),
    eDeliveryConsent: Boolean(contact.form1099EDeliveryConsentAt),
    taxUse: contact.taxUse === 'business' || contact.taxUse === 'personal' ? contact.taxUse : '',
    achRoutingNumber: contact.achRoutingNumber ?? '',
    achAccountNumber: '',
    removeAchAccount: false,
    achAccountType: contact.achAccountType ?? '',
  };
}

/** The boxes a vendor can default to for a form: the form's allocatable boxes plus "leave out of 1099 reporting". */
export function defaultBoxOptions(form: '' | Form1099Type): Array<{ code: string; number: string; label: string; form: Form1099Type | null }> {
  const boxes = FORM_1099_ACCOUNT_BOXES.filter((box) => !form || box.form === form).map((box) => ({
    code: box.code,
    number: box.number,
    label: box.label,
    form: box.form as Form1099Type | null,
  }));
  return [...boxes, { code: FORM_1099_OMIT, number: '', label: '', form: null }];
}

/** A stored box default still valid for the chosen form. */
export function boxMatchesForm(box: string, form: '' | Form1099Type): boolean {
  if (!box) return true;
  if (box === FORM_1099_OMIT || !form) return true;
  return box.startsWith(`${form}_`);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type VendorTaxProblem =
  | 'tinTypeRequired'
  | 'tinFormat'
  | 'tinPrefix'
  | 'tinArea'
  | 'tinGroup'
  | 'tinSerial'
  | 'llcRequired'
  | 'routingFormat'
  | 'routingChecksum'
  | 'accountNumber';

export interface VendorTaxValidation {
  field: keyof VendorTaxFormValues;
  problem: VendorTaxProblem;
}

const TIN_PROBLEM_KEYS = {
  format: 'tinFormat',
  prefix: 'tinPrefix',
  area: 'tinArea',
  group: 'tinGroup',
  serial: 'tinSerial',
} as const;

/** Problems the server would reject, found before the request goes out. Only what was typed is checked. */
export function validateVendorTax(values: VendorTaxFormValues): VendorTaxValidation[] {
  const problems: VendorTaxValidation[] = [];

  if (values.tin.trim()) {
    if (!values.tinType) {
      problems.push({ field: 'tinType', problem: 'tinTypeRequired' });
    } else {
      const found = tinProblem(values.tinType, values.tin);
      if (found) problems.push({ field: 'tin', problem: TIN_PROBLEM_KEYS[found] });
    }
  }

  if (values.w9Classification === 'llc' && !values.w9LlcClassification) {
    problems.push({ field: 'w9LlcClassification', problem: 'llcRequired' });
  }

  const routing = values.achRoutingNumber.replaceAll(/[\s-]/g, '');
  const routingFound = routingNumberProblem(routing);
  if (routingFound) problems.push({ field: 'achRoutingNumber', problem: routingFound === 'format' ? 'routingFormat' : 'routingChecksum' });

  const account = values.achAccountNumber.trim();
  if (account && !/^\d{4,17}$/.test(account.replaceAll(/[\s-]/g, ''))) {
    problems.push({ field: 'achAccountNumber', problem: 'accountNumber' });
  }
  return problems;
}

/** Zod schema of the vendor tax values; problems found by `validateVendorTax` become field errors with the given messages. */
export function createVendorTaxSchema(messages: Record<VendorTaxProblem, string>) {
  return z
    .object({
      is1099Vendor: z.boolean(),
      default1099Form: z.enum(['', 'nec', 'misc']),
      default1099Box: z.string(),
      tinType: z.enum(['', 'ein', 'ssn', 'itin']),
      tin: z.string(),
      removeTin: z.boolean(),
      w9LegalName: z.string().max(100),
      w9BusinessName: z.string().max(100),
      w9Classification: z.enum(['', ...W9_CLASSIFICATIONS] as const),
      w9LlcClassification: z.enum(['', ...LLC_CLASSIFICATIONS] as const),
      w9ExemptPayeeCode: z.string().max(2),
      w9FatcaCode: z.string().max(2),
      w9ReceivedAt: z.string(),
      w9DocumentId: z.string(),
      w9IsAttorney: z.boolean(),
      backupWithholding: z.boolean(),
      eDeliveryConsent: z.boolean(),
      taxUse: z.enum(['', 'business', 'personal']),
      achRoutingNumber: z.string(),
      achAccountNumber: z.string(),
      removeAchAccount: z.boolean(),
      achAccountType: z.enum(['', 'checking', 'savings']),
    })
    .superRefine((values, ctx) => {
      for (const found of validateVendorTax(values as VendorTaxFormValues)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [found.field], message: messages[found.problem] });
      }
    });
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface VendorTaxScope {
  /** The entity is a US entity with 1099 reporting and the contact is a vendor. */
  tax: boolean;
  /** The entity is a US entity: ACH details apply. */
  bank: boolean;
  /** The entity collects US sales tax and the contact is a customer. */
  taxUse: boolean;
}

function w9Payload(values: VendorTaxFormValues, initial: VendorTaxView | undefined): VendorW9 | undefined {
  const hadW9 = Boolean(initial?.w9 && Object.keys(initial.w9).length > 0);
  const typed = [
    values.w9LegalName,
    values.w9BusinessName,
    values.w9ExemptPayeeCode,
    values.w9FatcaCode,
    values.w9ReceivedAt,
    values.w9DocumentId,
    values.w9Classification,
  ].some((value) => value.trim()) || values.w9IsAttorney;
  if (!hadW9 && !typed) return undefined;

  const w9: VendorW9 = {
    // Blank text clears the stored value on the server.
    legalName: values.w9LegalName.trim(),
    businessName: values.w9BusinessName.trim(),
    exemptPayeeCode: values.w9ExemptPayeeCode.trim().toUpperCase(),
    fatcaCode: values.w9FatcaCode.trim().toUpperCase(),
    documentId: values.w9DocumentId,
    isAttorney: values.w9IsAttorney,
  };
  if (values.w9Classification) w9.federalTaxClassification = values.w9Classification;
  if (values.w9Classification === 'llc' && values.w9LlcClassification) w9.llcTaxClassification = values.w9LlcClassification;
  if (values.w9ReceivedAt) w9.receivedAt = values.w9ReceivedAt;
  // A scan attached here is an uploaded form; a form the vendor filled in online keeps its source.
  if (values.w9DocumentId && values.w9DocumentId !== initial?.w9?.documentId) w9.source = 'upload';
  return w9;
}

/**
 * The tax part of a contact create or update. `tin` and `achAccountNumber`
 * appear only when typed (or removed): leaving them out keeps the stored ones.
 */
export function buildVendorTaxPayload(
  values: VendorTaxFormValues,
  initial: VendorTaxView | undefined,
  scope: VendorTaxScope,
): VendorTaxPayload {
  const payload: VendorTaxPayload = {};

  if (scope.taxUse) payload.taxUse = values.taxUse || null;

  if (scope.tax) {
    payload.is1099Vendor = values.is1099Vendor;
    payload.default1099Form = values.default1099Form || null;
    payload.default1099Box = values.default1099Box || null;
    payload.backupWithholding = values.backupWithholding;

    const typedTin = values.tin.trim();
    if (values.removeTin) {
      payload.tin = null;
    } else if (typedTin && values.tinType) {
      payload.tinType = values.tinType;
      payload.tin = normalizeTin(values.tinType, typedTin);
    }

    const w9 = w9Payload(values, initial);
    if (w9) payload.w9 = w9;

    const hadConsent = Boolean(initial?.form1099EDeliveryConsentAt);
    if (values.eDeliveryConsent && !hadConsent) payload.form1099EDeliveryConsentAt = true;
    else if (!values.eDeliveryConsent && hadConsent) payload.form1099EDeliveryConsentAt = false;
  }

  if (scope.bank) {
    const routing = values.achRoutingNumber.replaceAll(/[\s-]/g, '');
    if (routing !== (initial?.achRoutingNumber ?? '')) payload.achRoutingNumber = routing || null;
    if (values.achAccountType !== (initial?.achAccountType ?? '')) payload.achAccountType = values.achAccountType || null;
    const account = values.achAccountNumber.replaceAll(/[\s-]/g, '');
    if (values.removeAchAccount) payload.achAccountNumber = null;
    else if (account) payload.achAccountNumber = account;
  }

  return payload;
}
