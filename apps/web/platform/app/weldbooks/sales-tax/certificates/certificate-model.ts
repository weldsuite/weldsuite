/**
 * Exemption certificates without the React: the form values, the validation
 * schema, the conversions to what the API takes and the expiry wording.
 *
 * A blanket certificate covers every purchase; a single-purchase certificate
 * only exempts the invoice it names. A certificate without an expiry date is
 * valid per the state's own rule (Florida's annual resale certificate ends on
 * 31 December, a Washington reseller permit after 48 months, an SST blanket
 * certificate once purchases are more than 12 months apart).
 */
import { z } from 'zod';
import {
  CERTIFICATE_FORMS,
  CERTIFICATE_REASONS,
  type CertificateForm,
  type CertificateReason,
  type CertificateStatus,
  type CreateCertificateInput,
  type ExemptionCertificate,
  type UpdateCertificateInput,
} from '@/lib/api/domains/weldbooks-sales-tax-setup';
import {
  certificateRuleApplies,
  certificateRulesOf,
  getSalesTaxState,
  type StateCertificateRule,
} from '@/lib/weldbooks/us-sales-tax-states';
import type { ValidationTexts } from '../setup/setup-texts';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What a certificate can be set to by hand: `expired` is worked out from the dates. */
export const FORM_STATUSES = ['valid', 'pending', 'revoked'] as const;
export type CertificateFormStatus = (typeof FORM_STATUSES)[number];

export interface CertificateFormValues {
  partyId: string;
  states: string[];
  reason: CertificateReason;
  form: CertificateForm;
  certificateNumber: string;
  issuedOn: string;
  expiresOn: string;
  blanket: boolean;
  invoiceId: string;
  /** The scan, as an accounting document id. */
  documentId: string;
  status: CertificateFormStatus;
  receivedOn: string;
  notes: string;
}

export function emptyCertificateForm(partyId = '', receivedOn = ''): CertificateFormValues {
  return {
    partyId,
    states: [],
    reason: 'resale',
    form: 'state_form',
    certificateNumber: '',
    issuedOn: '',
    expiresOn: '',
    blanket: true,
    invoiceId: '',
    documentId: '',
    status: 'valid',
    receivedOn,
    notes: '',
  };
}

export function certificateToForm(certificate: ExemptionCertificate): CertificateFormValues {
  // A certificate that has lapsed is still "valid" as far as the person who edits it is concerned: the dates decide.
  const status: CertificateFormStatus =
    certificate.storedStatus === 'pending' || certificate.storedStatus === 'revoked' ? certificate.storedStatus : 'valid';
  return {
    partyId: certificate.partyId,
    states: certificate.states,
    reason: certificate.reason,
    form: certificate.form,
    certificateNumber: certificate.certificateNumber ?? '',
    issuedOn: certificate.issuedOn ?? '',
    expiresOn: certificate.expiresOn ?? '',
    blanket: certificate.blanket,
    invoiceId: certificate.invoiceId ?? '',
    documentId: certificate.documentId ?? '',
    status,
    receivedOn: certificate.receivedOn ?? '',
    notes: certificate.notes ?? '',
  };
}

export function makeCertificateSchema(texts: ValidationTexts) {
  return z
    .object({
      partyId: z.string().min(1, texts.customer),
      states: z.array(z.string()).min(1, texts.statesRequired),
      reason: z.enum(CERTIFICATE_REASONS),
      form: z.enum(CERTIFICATE_FORMS),
      certificateNumber: z.string().max(100, texts.tooLong),
      issuedOn: z.string().refine((v) => v === '' || ISO_DATE.test(v), texts.date),
      expiresOn: z.string().refine((v) => v === '' || ISO_DATE.test(v), texts.date),
      blanket: z.boolean(),
      invoiceId: z.string(),
      documentId: z.string(),
      status: z.enum(FORM_STATUSES),
      receivedOn: z.string().refine((v) => v === '' || ISO_DATE.test(v), texts.date),
      notes: z.string().max(5000, texts.tooLong),
    })
    .superRefine((values, ctx) => {
      if (values.issuedOn && values.expiresOn && values.expiresOn < values.issuedOn) {
        ctx.addIssue({ code: 'custom', path: ['expiresOn'], message: texts.endBeforeStart });
      }
      // A single-purchase certificate only exempts the invoice it names.
      if (!values.blanket && !values.invoiceId) {
        ctx.addIssue({ code: 'custom', path: ['invoiceId'], message: texts.invoice });
      }
    });
}

/** The create payload: blanks are left out so the server's defaults apply (received today, valid). */
export function toCreateCertificateInput(values: CertificateFormValues): CreateCertificateInput {
  const input: CreateCertificateInput = {
    partyId: values.partyId,
    states: values.states,
    reason: values.reason,
    form: values.form,
    blanket: values.blanket,
    status: values.status,
  };
  const number = values.certificateNumber.trim();
  if (number) input.certificateNumber = number;
  if (values.issuedOn) input.issuedOn = values.issuedOn;
  if (values.expiresOn) input.expiresOn = values.expiresOn;
  if (!values.blanket && values.invoiceId) input.invoiceId = values.invoiceId;
  if (values.documentId) input.documentId = values.documentId;
  if (values.receivedOn) input.receivedOn = values.receivedOn;
  const notes = values.notes.trim();
  if (notes) input.notes = notes;
  return input;
}

/** The update payload: cleared optional fields go as null so they can be emptied. A blanket certificate drops its invoice. */
export function toUpdateCertificateInput(values: CertificateFormValues): UpdateCertificateInput {
  return {
    states: values.states,
    reason: values.reason,
    form: values.form,
    blanket: values.blanket,
    status: values.status,
    certificateNumber: values.certificateNumber.trim() || null,
    issuedOn: values.issuedOn || null,
    expiresOn: values.expiresOn || null,
    invoiceId: !values.blanket && values.invoiceId ? values.invoiceId : null,
    documentId: values.documentId || null,
    receivedOn: values.receivedOn || null,
    notes: values.notes.trim() || null,
  };
}

// ============================================================================
// Expiry
// ============================================================================

export type ExpiryTone = 'none' | 'ok' | 'soon' | 'expired';

/** Certificates ending within this many days are flagged on the lists. */
export const EXPIRING_SOON_DAYS = 60;

export function expiryTone(certificate: Pick<ExemptionCertificate, 'effectiveExpiresOn' | 'daysUntilExpiry'>): ExpiryTone {
  if (certificate.effectiveExpiresOn === null || certificate.daysUntilExpiry === null) return 'none';
  if (certificate.daysUntilExpiry < 0) return 'expired';
  if (certificate.daysUntilExpiry <= EXPIRING_SOON_DAYS) return 'soon';
  return 'ok';
}

/** The state rules that decide validity when the certificate has no expiry date: one hint per rule that applies. */
export function applicableRuleHints(
  stateCodes: readonly string[],
  certificate: { reason: string; form: string; blanket: boolean },
): Array<{ state: string; rule: StateCertificateRule }> {
  const hints: Array<{ state: string; rule: StateCertificateRule }> = [];
  for (const code of stateCodes) {
    const state = getSalesTaxState(code);
    if (!state) continue;
    for (const rule of certificateRulesOf(code)) {
      if (certificateRuleApplies(rule, certificate)) hints.push({ state: state.name, rule });
    }
  }
  return hints;
}

/** The label order of the statuses in the status filter. */
export const STATUS_FILTER_ORDER: readonly CertificateStatus[] = ['valid', 'pending', 'expired', 'revoked'];

/** The windows the "expiring" filter offers, in days. */
export const EXPIRING_WINDOWS = [30, 60, 90] as const;
