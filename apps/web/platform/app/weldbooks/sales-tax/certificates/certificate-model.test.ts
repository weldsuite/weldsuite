import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import type { ExemptionCertificate } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import {
  applicableRuleHints,
  certificateToForm,
  emptyCertificateForm,
  expiryTone,
  makeCertificateSchema,
  toCreateCertificateInput,
  toUpdateCertificateInput,
  type CertificateFormValues,
} from './certificate-model';

const texts = en.weldbooksUs.salesTax.setup.validation;
const schema = makeCertificateSchema(texts);

function messages(values: CertificateFormValues): Record<string, string> {
  const result = schema.safeParse(values);
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((i) => [String(i.path[0]), i.message]));
}

const valid: CertificateFormValues = {
  ...emptyCertificateForm('prt_1', '2026-10-08'),
  states: ['TX', 'OK'],
  certificateNumber: ' 32-123 ',
};

function certificate(overrides: Partial<ExemptionCertificate> = {}): ExemptionCertificate {
  return {
    id: 'exc_1',
    entityId: 'ent_1',
    partyId: 'prt_1',
    states: ['TX'],
    reason: 'resale',
    certificateNumber: '32-123',
    form: 'state_form',
    issuedOn: '2026-01-15',
    expiresOn: null,
    blanket: true,
    invoiceId: null,
    documentId: null,
    status: 'valid',
    storedStatus: 'valid',
    expiryByState: { TX: null },
    expiredStates: [],
    effectiveExpiresOn: null,
    daysUntilExpiry: null,
    lastUsedOn: null,
    receivedOn: '2026-01-20',
    notes: null,
    createdAt: '2026-01-20T00:00:00.000Z',
    updatedAt: '2026-01-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('certificate payload', () => {
  it('sends the customer, states, reason and form with the coverage', () => {
    expect(toCreateCertificateInput(valid)).toEqual({
      partyId: 'prt_1',
      states: ['TX', 'OK'],
      reason: 'resale',
      form: 'state_form',
      blanket: true,
      status: 'valid',
      certificateNumber: '32-123',
      receivedOn: '2026-10-08',
    });
  });

  it('sends dates, the scan and notes when there are some', () => {
    expect(
      toCreateCertificateInput({
        ...valid,
        issuedOn: '2026-01-15',
        expiresOn: '2027-01-14',
        documentId: 'doc_1',
        notes: ' on file ',
      }),
    ).toMatchObject({ issuedOn: '2026-01-15', expiresOn: '2027-01-14', documentId: 'doc_1', notes: 'on file' });
  });

  it('names the invoice only for a single-purchase certificate', () => {
    const single = { ...valid, blanket: false, invoiceId: 'inv_1' };
    expect(toCreateCertificateInput(single)).toMatchObject({ blanket: false, invoiceId: 'inv_1' });
    expect(toCreateCertificateInput({ ...valid, blanket: true, invoiceId: 'inv_1' })).not.toHaveProperty('invoiceId');
  });

  it('leaves blanks out of a create so the server defaults apply', () => {
    const input = toCreateCertificateInput({ ...valid, certificateNumber: '', receivedOn: '' });
    expect(input).not.toHaveProperty('certificateNumber');
    expect(input).not.toHaveProperty('receivedOn');
    expect(input).not.toHaveProperty('issuedOn');
    expect(input).not.toHaveProperty('expiresOn');
    expect(input).not.toHaveProperty('documentId');
  });

  it('clears optional fields with null on an update, and has no customer', () => {
    const update = toUpdateCertificateInput({ ...valid, certificateNumber: '', issuedOn: '', expiresOn: '', receivedOn: '', notes: '' });
    expect(update).toEqual({
      states: ['TX', 'OK'],
      reason: 'resale',
      form: 'state_form',
      blanket: true,
      status: 'valid',
      certificateNumber: null,
      issuedOn: null,
      expiresOn: null,
      invoiceId: null,
      documentId: null,
      receivedOn: null,
      notes: null,
    });
    expect(update).not.toHaveProperty('partyId');
  });

  it('drops the invoice of a certificate that became blanket', () => {
    expect(toUpdateCertificateInput({ ...valid, blanket: true, invoiceId: 'inv_1' }).invoiceId).toBeNull();
    expect(toUpdateCertificateInput({ ...valid, blanket: false, invoiceId: 'inv_1' }).invoiceId).toBe('inv_1');
  });

  it('round-trips a stored certificate through the form', () => {
    const values = certificateToForm(certificate({ states: ['TX', 'OK'], expiresOn: '2027-01-14', documentId: 'doc_1' }));
    expect(values).toMatchObject({
      partyId: 'prt_1',
      states: ['TX', 'OK'],
      certificateNumber: '32-123',
      expiresOn: '2027-01-14',
      documentId: 'doc_1',
      status: 'valid',
      blanket: true,
    });
  });

  it('shows a lapsed certificate as valid in the form: the dates decide, the status field is for pending and revoked', () => {
    expect(certificateToForm(certificate({ status: 'expired', storedStatus: 'valid' })).status).toBe('valid');
    expect(certificateToForm(certificate({ status: 'expired', storedStatus: 'expired' })).status).toBe('valid');
    expect(certificateToForm(certificate({ status: 'pending', storedStatus: 'pending' })).status).toBe('pending');
    expect(certificateToForm(certificate({ status: 'revoked', storedStatus: 'revoked' })).status).toBe('revoked');
  });
});

describe('certificate validation', () => {
  it('accepts a customer with a state', () => {
    expect(messages(valid)).toEqual({});
  });

  it('needs a customer and at least one state', () => {
    expect(messages({ ...valid, partyId: '', states: [] })).toMatchObject({
      partyId: texts.customer,
      states: texts.statesRequired,
    });
  });

  it('refuses an expiry before the issue date', () => {
    expect(messages({ ...valid, issuedOn: '2026-06-01', expiresOn: '2026-05-31' }).expiresOn).toBe(texts.endBeforeStart);
    expect(messages({ ...valid, issuedOn: '2026-06-01', expiresOn: '2026-06-01' })).toEqual({});
  });

  it('wants the invoice a single-purchase certificate covers', () => {
    expect(messages({ ...valid, blanket: false, invoiceId: '' }).invoiceId).toBe(texts.invoice);
    expect(messages({ ...valid, blanket: false, invoiceId: 'inv_1' })).toEqual({});
    expect(messages({ ...valid, blanket: true, invoiceId: '' })).toEqual({});
  });

  it('wants real dates', () => {
    expect(messages({ ...valid, issuedOn: 'yesterday' }).issuedOn).toBe(texts.date);
  });
});

describe('expiryTone', () => {
  it('has no tone for a certificate that does not expire', () => {
    expect(expiryTone(certificate())).toBe('none');
  });

  it('flags a certificate that ends within 60 days', () => {
    expect(expiryTone(certificate({ effectiveExpiresOn: '2026-11-30', daysUntilExpiry: 53 }))).toBe('soon');
    expect(expiryTone(certificate({ effectiveExpiresOn: '2027-06-30', daysUntilExpiry: 265 }))).toBe('ok');
    expect(expiryTone(certificate({ effectiveExpiresOn: '2026-10-01', daysUntilExpiry: -7 }))).toBe('expired');
  });
});

describe('applicableRuleHints', () => {
  it("names the state's rule for a resale certificate without an expiry date", () => {
    const hints = applicableRuleHints(['FL', 'TX'], { reason: 'resale', form: 'state_form', blanket: true });
    expect(hints.map((h) => `${h.state}:${h.rule.expiry.kind}`)).toEqual(['Florida:calendar_year_end']);
  });

  it('adds the SST blanket rule for a Streamlined Sales Tax certificate in an SST state', () => {
    const hints = applicableRuleHints(['OH', 'TX'], { reason: 'resale', form: 'sst_f0003', blanket: true });
    expect(hints.map((h) => `${h.state}:${h.rule.expiry.kind}`)).toEqual(['Ohio:months_from_last_purchase']);
    expect(applicableRuleHints(['OH'], { reason: 'resale', form: 'sst_f0003', blanket: false })).toEqual([]);
  });

  it('knows nothing about a state it does not know', () => {
    expect(applicableRuleHints(['ZZ'], { reason: 'resale', form: 'state_form', blanket: true })).toEqual([]);
  });
});
