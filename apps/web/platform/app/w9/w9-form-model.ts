/**
 * Form values, validation and the request body of the public W-9 page (the
 * IRS Form W-9, Rev. March 2024, filled in online by a vendor).
 *
 * The server validates everything again; these rules keep a typo from costing
 * the vendor a round trip. The TIN is never echoed: only its checks run here.
 */
import { z } from 'zod';
import type {
  LlcTaxClassification,
  PublicW9Submission,
  TinType,
  W9FederalClassification,
} from '@/lib/api/domains/weldbooks-1099';
import { US_STATES } from '@/components/address/us-states';
import { normalizeTin, tinProblem, type VendorTinType } from '@/lib/weldbooks/vendor-tin';

/** Line 3a of the W-9, in the order the form lists them. */
export const W9_PAGE_CLASSIFICATIONS = [
  'individual',
  'c_corporation',
  's_corporation',
  'partnership',
  'trust_estate',
  'llc',
  'other',
] as const satisfies readonly W9FederalClassification[];

export const W9_PAGE_LLC_CLASSIFICATIONS = ['C', 'S', 'P'] as const satisfies readonly LlcTaxClassification[];

export const W9_TIN_TYPES = ['ssn', 'ein', 'itin'] as const satisfies readonly TinType[];

export interface W9FormValues {
  legalName: string;
  businessName: string;
  classification: '' | W9FederalClassification;
  llcClassification: '' | LlcTaxClassification;
  exemptPayeeCode: string;
  fatcaCode: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  tinType: '' | VendorTinType;
  tin: string;
  /** The vendor has been told by the IRS that they are subject to backup withholding: item 2 of the certification can't be signed. */
  subjectToBackupWithholding: boolean;
  signedName: string;
  certify: boolean;
}

export const EMPTY_W9_VALUES: W9FormValues = {
  legalName: '',
  businessName: '',
  classification: '',
  llcClassification: '',
  exemptPayeeCode: '',
  fatcaCode: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  postalCode: '',
  tinType: '',
  tin: '',
  subjectToBackupWithholding: false,
  signedName: '',
  certify: false,
};

/** Messages for each rule, supplied translated by the page. */
export interface W9Messages {
  required: string;
  classificationRequired: string;
  llcRequired: string;
  stateRequired: string;
  zip: string;
  tinTypeRequired: string;
  tinRequired: string;
  tinFormat: string;
  tinPrefix: string;
  tinArea: string;
  tinGroup: string;
  tinSerial: string;
  certifyRequired: string;
  backupWithholding: string;
  signatureShort: string;
}

const STATE_CODES: readonly string[] = US_STATES.map((state) => state.code);
const ZIP = /^\d{5}(-\d{4})?$/;

export function createW9Schema(m: W9Messages) {
  const required = z.string().trim().min(1, m.required);
  return z
    .object({
      legalName: required.max(100),
      businessName: z.string().trim().max(100),
      classification: z.enum(['', ...W9_PAGE_CLASSIFICATIONS] as const).refine((value) => value !== '', m.classificationRequired),
      llcClassification: z.enum(['', ...W9_PAGE_LLC_CLASSIFICATIONS] as const),
      exemptPayeeCode: z.string().trim().max(2),
      fatcaCode: z.string().trim().max(2),
      line1: required.max(100),
      line2: z.string().trim().max(100),
      city: required.max(60),
      state: z.string().refine((value) => STATE_CODES.includes(value), m.stateRequired),
      postalCode: z.string().trim().regex(ZIP, m.zip),
      tinType: z.enum(['', ...W9_TIN_TYPES] as const).refine((value) => value !== '', m.tinTypeRequired),
      tin: z.string().trim().min(1, m.tinRequired),
      subjectToBackupWithholding: z.boolean().refine((value) => !value, m.backupWithholding),
      signedName: z.string().trim().min(2, m.signatureShort).max(100),
      certify: z.boolean().refine((value) => value, m.certifyRequired),
    })
    .superRefine((values, ctx) => {
      if (values.classification === 'llc' && !values.llcClassification) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['llcClassification'], message: m.llcRequired });
      }
      if (values.tinType && values.tin.trim()) {
        const problem = tinProblem(values.tinType, values.tin);
        if (problem) {
          const key = { format: 'tinFormat', prefix: 'tinPrefix', area: 'tinArea', group: 'tinGroup', serial: 'tinSerial' } as const;
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tin'], message: m[key[problem]] });
        }
      }
    });
}

/** The request body: blank optional fields left out, the TIN with the dashes of its type. */
export function buildW9Submission(values: W9FormValues): PublicW9Submission {
  const classification = values.classification as W9FederalClassification;
  const tinType = values.tinType as TinType;
  const optional = (value: string) => value.trim() || undefined;
  return {
    legalName: values.legalName.trim(),
    businessName: optional(values.businessName),
    federalTaxClassification: classification,
    llcTaxClassification: classification === 'llc' && values.llcClassification ? values.llcClassification : undefined,
    exemptPayeeCode: optional(values.exemptPayeeCode)?.toUpperCase(),
    fatcaCode: optional(values.fatcaCode)?.toUpperCase(),
    address: {
      line1: values.line1.trim(),
      line2: optional(values.line2),
      city: values.city.trim(),
      state: values.state,
      postalCode: values.postalCode.trim(),
    },
    tinType,
    tin: normalizeTin(tinType, values.tin.trim()),
    signedName: values.signedName.trim(),
    certify: true,
  };
}

/** Maps a server field path (`address.postalCode`) to the form's field name. */
export function serverFieldToFormField(path: string): keyof W9FormValues | null {
  const map: Record<string, keyof W9FormValues> = {
    legalName: 'legalName',
    businessName: 'businessName',
    federalTaxClassification: 'classification',
    llcTaxClassification: 'llcClassification',
    exemptPayeeCode: 'exemptPayeeCode',
    fatcaCode: 'fatcaCode',
    'address.line1': 'line1',
    'address.line2': 'line2',
    'address.city': 'city',
    'address.state': 'state',
    'address.postalCode': 'postalCode',
    tinType: 'tinType',
    tin: 'tin',
    signedName: 'signedName',
    certify: 'certify',
  };
  return map[path] ?? null;
}
