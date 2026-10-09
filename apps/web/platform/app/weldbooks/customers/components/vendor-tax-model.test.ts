import { describe, expect, it } from 'vitest';
import type { VendorTaxView } from '@/lib/api/domains/weldbooks-1099';
import {
  EMPTY_VENDOR_TAX_VALUES,
  boxMatchesForm,
  buildVendorTaxPayload,
  createVendorTaxSchema,
  defaultBoxOptions,
  initialVendorTaxValues,
  validateVendorTax,
  type VendorTaxFormValues,
  type VendorTaxScope,
} from './vendor-tax-model';

const ALL: VendorTaxScope = { tax: true, bank: true, taxUse: true };

function values(overrides: Partial<VendorTaxFormValues> = {}): VendorTaxFormValues {
  return { ...EMPTY_VENDOR_TAX_VALUES, ...overrides };
}

const storedVendor: VendorTaxView = {
  is1099Vendor: true,
  default1099Form: 'nec',
  default1099Box: 'nec_1',
  tinType: 'ein',
  tinLast4: '6789',
  hasTin: true,
  w9: { legalName: 'Acme LLC', federalTaxClassification: 'llc', llcTaxClassification: 'S', receivedAt: '2026-02-01', documentId: 'doc_1' },
  backupWithholding: false,
  form1099EDeliveryConsentAt: '2026-03-01T10:00:00.000Z',
  achRoutingNumber: '021000021',
  achAccountLast4: '4321',
  hasAchAccount: true,
  achAccountType: 'checking',
};

describe('initialVendorTaxValues', () => {
  it('starts empty for a new contact', () => {
    expect(initialVendorTaxValues(undefined)).toEqual(EMPTY_VENDOR_TAX_VALUES);
  });

  it('never holds a stored TIN or account number: only blanks to type into', () => {
    const initial = initialVendorTaxValues(storedVendor);
    expect(initial.tin).toBe('');
    expect(initial.achAccountNumber).toBe('');
    expect(initial.removeTin).toBe(false);
    expect(initial.tinType).toBe('ein');
    expect(initial.w9Classification).toBe('llc');
    expect(initial.w9LlcClassification).toBe('S');
    expect(initial.w9ReceivedAt).toBe('2026-02-01');
    expect(initial.eDeliveryConsent).toBe(true);
    expect(JSON.stringify(initial)).not.toContain('6789');
    expect(JSON.stringify(initial)).not.toContain('4321');
  });
});

describe('buildVendorTaxPayload: write-only secrets', () => {
  it('leaves tin out when nothing was typed: blank means unchanged', () => {
    const payload = buildVendorTaxPayload(initialVendorTaxValues(storedVendor), storedVendor, ALL);
    expect('tin' in payload).toBe(false);
    expect('tinType' in payload).toBe(false);
    expect('achAccountNumber' in payload).toBe(false);
  });

  it('leaves tin out when only spaces were typed', () => {
    const payload = buildVendorTaxPayload(values({ tinType: 'ein', tin: '   ' }), undefined, ALL);
    expect('tin' in payload).toBe(false);
  });

  it('sends the typed TIN with its type, formatted with the dashes of the type', () => {
    const payload = buildVendorTaxPayload(values({ tinType: 'ein', tin: '123456789' }), undefined, ALL);
    expect(payload.tin).toBe('12-3456789');
    expect(payload.tinType).toBe('ein');

    const ssn = buildVendorTaxPayload(values({ tinType: 'ssn', tin: '123456789' }), undefined, ALL);
    expect(ssn.tin).toBe('123-45-6789');
    expect(ssn.tinType).toBe('ssn');
  });

  it('does not send a typed TIN without a type: validation catches it first', () => {
    const payload = buildVendorTaxPayload(values({ tin: '12-3456789' }), undefined, ALL);
    expect('tin' in payload).toBe(false);
  });

  it('sends null to remove the stored TIN, and nothing else about it', () => {
    const payload = buildVendorTaxPayload(values({ ...initialVendorTaxValues(storedVendor), removeTin: true, tin: '12-3456789' }), storedVendor, ALL);
    expect(payload.tin).toBeNull();
    expect('tinType' in payload).toBe(false);
  });

  it('sends the account number only when typed, digits only', () => {
    const typed = buildVendorTaxPayload(values({ achAccountNumber: '1234 5678-90' }), undefined, ALL);
    expect(typed.achAccountNumber).toBe('1234567890');
    const blank = buildVendorTaxPayload(initialVendorTaxValues(storedVendor), storedVendor, ALL);
    expect('achAccountNumber' in blank).toBe(false);
    const removed = buildVendorTaxPayload(values({ ...initialVendorTaxValues(storedVendor), removeAchAccount: true }), storedVendor, ALL);
    expect(removed.achAccountNumber).toBeNull();
  });
});

describe('buildVendorTaxPayload: the rest of the tax data', () => {
  it('sends nothing of the sections that are out of scope (a non-US entity, a customer)', () => {
    const payload = buildVendorTaxPayload(
      values({ is1099Vendor: true, tinType: 'ein', tin: '12-3456789', achRoutingNumber: '021000021', taxUse: 'business' }),
      undefined,
      { tax: false, bank: false, taxUse: false },
    );
    expect(payload).toEqual({});
  });

  it('sends the 1099 flags and defaults, clearing an unset default with null', () => {
    const payload = buildVendorTaxPayload(values({ is1099Vendor: true, default1099Form: 'misc', default1099Box: 'misc_1', backupWithholding: true }), undefined, ALL);
    expect(payload).toMatchObject({ is1099Vendor: true, default1099Form: 'misc', default1099Box: 'misc_1', backupWithholding: true });
    const cleared = buildVendorTaxPayload(values(), undefined, ALL);
    expect(cleared.default1099Form).toBeNull();
    expect(cleared.default1099Box).toBeNull();
  });

  it('builds the W-9 only when something is filled in or a W-9 was already on file', () => {
    expect(buildVendorTaxPayload(values(), undefined, ALL).w9).toBeUndefined();
    const filled = buildVendorTaxPayload(
      values({ w9LegalName: ' Acme LLC ', w9Classification: 'llc', w9LlcClassification: 'C', w9ExemptPayeeCode: 'a', w9ReceivedAt: '2026-02-01', w9IsAttorney: true }),
      undefined,
      ALL,
    );
    expect(filled.w9).toMatchObject({
      legalName: 'Acme LLC',
      federalTaxClassification: 'llc',
      llcTaxClassification: 'C',
      exemptPayeeCode: 'A',
      receivedAt: '2026-02-01',
      isAttorney: true,
    });
    // An existing W-9 is sent even when untouched, so a cleared field clears on the server.
    expect(buildVendorTaxPayload(initialVendorTaxValues(storedVendor), storedVendor, ALL).w9).toBeDefined();
  });

  it('drops the LLC classification when the classification is not an LLC', () => {
    const payload = buildVendorTaxPayload(values({ w9LegalName: 'Jo', w9Classification: 'individual', w9LlcClassification: 'C' }), undefined, ALL);
    expect(payload.w9?.llcTaxClassification).toBeUndefined();
  });

  it('marks a newly attached scan as an upload, and keeps the source of an unchanged one', () => {
    const attached = buildVendorTaxPayload(values({ w9LegalName: 'Jo', w9DocumentId: 'doc_9' }), undefined, ALL);
    expect(attached.w9?.source).toBe('upload');
    const unchanged = buildVendorTaxPayload(initialVendorTaxValues(storedVendor), storedVendor, ALL);
    expect(unchanged.w9?.source).toBeUndefined();
  });

  it('sends the consent only when it changes: given now, or withdrawn', () => {
    expect(buildVendorTaxPayload(values({ eDeliveryConsent: true }), undefined, ALL).form1099EDeliveryConsentAt).toBe(true);
    expect('form1099EDeliveryConsentAt' in buildVendorTaxPayload(initialVendorTaxValues(storedVendor), storedVendor, ALL)).toBe(false);
    const withdrawn = buildVendorTaxPayload(values({ ...initialVendorTaxValues(storedVendor), eDeliveryConsent: false }), storedVendor, ALL);
    expect(withdrawn.form1099EDeliveryConsentAt).toBe(false);
  });

  it('sends bank details only when they changed, and the customer tax use as a value or null', () => {
    const untouched = buildVendorTaxPayload(initialVendorTaxValues(storedVendor), storedVendor, ALL);
    expect('achRoutingNumber' in untouched).toBe(false);
    expect('achAccountType' in untouched).toBe(false);

    const changed = buildVendorTaxPayload(values({ ...initialVendorTaxValues(storedVendor), achRoutingNumber: '011-000-015', achAccountType: 'savings' }), storedVendor, ALL);
    expect(changed.achRoutingNumber).toBe('011000015');
    expect(changed.achAccountType).toBe('savings');

    const removedRouting = buildVendorTaxPayload(values({ ...initialVendorTaxValues(storedVendor), achRoutingNumber: '' }), storedVendor, ALL);
    expect(removedRouting.achRoutingNumber).toBeNull();

    expect(buildVendorTaxPayload(values({ taxUse: 'personal' }), undefined, ALL).taxUse).toBe('personal');
    expect(buildVendorTaxPayload(values(), undefined, ALL).taxUse).toBeNull();
  });
});

describe('validateVendorTax', () => {
  it('has nothing to say about an untouched form', () => {
    expect(validateVendorTax(values())).toEqual([]);
    expect(validateVendorTax(initialVendorTaxValues(storedVendor))).toEqual([]);
  });

  it('wants a type for a typed TIN, and checks its format', () => {
    expect(validateVendorTax(values({ tin: '12-3456789' }))).toEqual([{ field: 'tinType', problem: 'tinTypeRequired' }]);
    expect(validateVendorTax(values({ tinType: 'ein', tin: '12-345' }))).toEqual([{ field: 'tin', problem: 'tinFormat' }]);
    expect(validateVendorTax(values({ tinType: 'ssn', tin: '666-12-3456' }))).toEqual([{ field: 'tin', problem: 'tinArea' }]);
    expect(validateVendorTax(values({ tinType: 'ein', tin: '12-3456789' }))).toEqual([]);
  });

  it('requires the tax classification of an LLC', () => {
    expect(validateVendorTax(values({ w9Classification: 'llc' }))).toEqual([{ field: 'w9LlcClassification', problem: 'llcRequired' }]);
    expect(validateVendorTax(values({ w9Classification: 'llc', w9LlcClassification: 'P' }))).toEqual([]);
  });

  it('checks the ABA routing number and the account number length', () => {
    expect(validateVendorTax(values({ achRoutingNumber: '12345' }))).toEqual([{ field: 'achRoutingNumber', problem: 'routingFormat' }]);
    expect(validateVendorTax(values({ achRoutingNumber: '123456789' }))).toEqual([{ field: 'achRoutingNumber', problem: 'routingChecksum' }]);
    expect(validateVendorTax(values({ achRoutingNumber: '021000021' }))).toEqual([]);
    expect(validateVendorTax(values({ achAccountNumber: '123' }))).toEqual([{ field: 'achAccountNumber', problem: 'accountNumber' }]);
    expect(validateVendorTax(values({ achAccountNumber: '1234-5678' }))).toEqual([]);
  });

  it('turns the problems into field errors of the zod schema with the given messages', () => {
    const messages = {
      tinTypeRequired: 'type!',
      tinFormat: 'format!',
      tinPrefix: 'prefix!',
      tinArea: 'area!',
      tinGroup: 'group!',
      tinSerial: 'serial!',
      llcRequired: 'llc!',
      routingFormat: 'routing format!',
      routingChecksum: 'routing checksum!',
      accountNumber: 'account!',
    };
    const schema = createVendorTaxSchema(messages);
    const result = schema.safeParse(values({ tinType: 'ein', tin: '12-3', achRoutingNumber: '12345' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
        ['tin', 'format!'],
        ['achRoutingNumber', 'routing format!'],
      ]);
    }
    expect(schema.safeParse(values()).success).toBe(true);
  });
});

describe('default box options', () => {
  it('offers the boxes of the chosen form, plus leaving the vendor out of reporting', () => {
    const nec = defaultBoxOptions('nec');
    expect(nec.filter((o) => o.form).every((o) => o.form === 'nec')).toBe(true);
    expect(nec.some((o) => o.code === 'nec_1')).toBe(true);
    expect(nec.some((o) => o.code === 'omit' && o.form === null)).toBe(true);
    expect(nec.some((o) => o.code === 'misc_1')).toBe(false);
    expect(defaultBoxOptions('').some((o) => o.code === 'misc_1')).toBe(true);
  });

  it('does not offer the federal tax withheld boxes: backup withholding fills them', () => {
    const codes = defaultBoxOptions('').map((o) => o.code);
    expect(codes).not.toContain('nec_4');
    expect(codes).not.toContain('misc_4');
  });

  it('knows whether a box still fits the form', () => {
    expect(boxMatchesForm('nec_1', 'nec')).toBe(true);
    expect(boxMatchesForm('nec_1', 'misc')).toBe(false);
    expect(boxMatchesForm('omit', 'misc')).toBe(true);
    expect(boxMatchesForm('', 'misc')).toBe(true);
    expect(boxMatchesForm('misc_1', '')).toBe(true);
  });
});
