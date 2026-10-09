import { describe, expect, it } from 'vitest';
import {
  EMPTY_W9_VALUES,
  buildW9Submission,
  createW9Schema,
  serverFieldToFormField,
  type W9FormValues,
  type W9Messages,
} from './w9-form-model';

const messages: W9Messages = {
  required: 'required',
  classificationRequired: 'classification',
  llcRequired: 'llc',
  stateRequired: 'state',
  zip: 'zip',
  tinTypeRequired: 'tin type',
  tinRequired: 'tin required',
  tinFormat: 'tin format',
  tinPrefix: 'tin prefix',
  tinArea: 'tin area',
  tinGroup: 'tin group',
  tinSerial: 'tin serial',
  certifyRequired: 'certify',
  backupWithholding: 'backup withholding',
  signatureShort: 'signature',
};

const schema = createW9Schema(messages);

function valid(overrides: Partial<W9FormValues> = {}): W9FormValues {
  return {
    ...EMPTY_W9_VALUES,
    legalName: 'Jane Q. Public',
    classification: 'individual',
    line1: '1 Main St',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
    tinType: 'ssn',
    tin: '123-45-6789',
    signedName: 'Jane Q. Public',
    certify: true,
    ...overrides,
  };
}

/** `path: message` for every problem found. */
function problems(values: W9FormValues): Record<string, string> {
  const result = schema.safeParse(values);
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.'), issue.message]));
}

describe('W-9 validation', () => {
  it('accepts a complete form', () => {
    expect(problems(valid())).toEqual({});
  });

  it('wants every required field, and names each one', () => {
    expect(problems(EMPTY_W9_VALUES)).toEqual({
      legalName: 'required',
      classification: 'classification',
      line1: 'required',
      city: 'required',
      state: 'state',
      postalCode: 'zip',
      tinType: 'tin type',
      tin: 'tin required',
      signedName: 'signature',
      certify: 'certify',
    });
  });

  it('requires the tax classification of an LLC, and only then', () => {
    expect(problems(valid({ classification: 'llc' }))).toEqual({ llcClassification: 'llc' });
    expect(problems(valid({ classification: 'llc', llcClassification: 'S' }))).toEqual({});
    expect(problems(valid({ classification: 'partnership' }))).toEqual({});
  });

  it('checks an EIN: nine digits and a prefix the IRS assigns', () => {
    expect(problems(valid({ tinType: 'ein', tin: '12-3456789' }))).toEqual({});
    expect(problems(valid({ tinType: 'ein', tin: '123456789' }))).toEqual({});
    expect(problems(valid({ tinType: 'ein', tin: '12-345' }))).toEqual({ tin: 'tin format' });
    expect(problems(valid({ tinType: 'ein', tin: '07-1234567' }))).toEqual({ tin: 'tin prefix' });
  });

  it('checks an SSN: nine digits, and numbers the SSA does not issue', () => {
    expect(problems(valid({ tinType: 'ssn', tin: '123456789' }))).toEqual({});
    expect(problems(valid({ tinType: 'ssn', tin: '123-45-678' }))).toEqual({ tin: 'tin format' });
    expect(problems(valid({ tinType: 'ssn', tin: '666-45-6789' }))).toEqual({ tin: 'tin area' });
    expect(problems(valid({ tinType: 'ssn', tin: '123-00-6789' }))).toEqual({ tin: 'tin group' });
    expect(problems(valid({ tinType: 'ssn', tin: '123-45-0000' }))).toEqual({ tin: 'tin serial' });
  });

  it('checks an ITIN: starts with 9 and has a middle group the IRS issues', () => {
    expect(problems(valid({ tinType: 'itin', tin: '912-70-1234' }))).toEqual({});
    expect(problems(valid({ tinType: 'itin', tin: '123-45-6789' }))).toEqual({ tin: 'tin area' });
    expect(problems(valid({ tinType: 'itin', tin: '912-93-1234' }))).toEqual({ tin: 'tin group' });
  });

  it('checks the ZIP code and the state', () => {
    expect(problems(valid({ postalCode: '94105-1234' }))).toEqual({});
    expect(problems(valid({ postalCode: '9410' }))).toEqual({ postalCode: 'zip' });
    expect(problems(valid({ postalCode: 'ABCDE' }))).toEqual({ postalCode: 'zip' });
    expect(problems(valid({ state: 'ZZ' }))).toEqual({ state: 'state' });
    expect(problems(valid({ state: 'DC' }))).toEqual({});
  });

  it('cannot be submitted online by someone under backup withholding, or without certifying', () => {
    expect(problems(valid({ subjectToBackupWithholding: true }))).toEqual({ subjectToBackupWithholding: 'backup withholding' });
    expect(problems(valid({ certify: false }))).toEqual({ certify: 'certify' });
  });

  it('wants a signature of at least two characters', () => {
    expect(problems(valid({ signedName: 'J' }))).toEqual({ signedName: 'signature' });
  });
});

describe('buildW9Submission', () => {
  it('builds the body the public endpoint takes: dashes on the TIN, blanks left out, codes upper-cased', () => {
    const body = buildW9Submission(
      valid({
        legalName: '  Jane Q. Public ',
        businessName: '',
        tinType: 'ein',
        tin: '123456789',
        exemptPayeeCode: '5',
        fatcaCode: 'a',
        line2: 'Suite 4',
        postalCode: '78701',
      }),
    );
    expect(body).toEqual({
      legalName: 'Jane Q. Public',
      businessName: undefined,
      federalTaxClassification: 'individual',
      llcTaxClassification: undefined,
      exemptPayeeCode: '5',
      fatcaCode: 'A',
      address: { line1: '1 Main St', line2: 'Suite 4', city: 'Austin', state: 'TX', postalCode: '78701' },
      tinType: 'ein',
      tin: '12-3456789',
      signedName: 'Jane Q. Public',
      certify: true,
    });
  });

  it('sends the LLC classification only for an LLC', () => {
    expect(buildW9Submission(valid({ classification: 'llc', llcClassification: 'P' })).llcTaxClassification).toBe('P');
    expect(buildW9Submission(valid({ classification: 'individual', llcClassification: 'P' })).llcTaxClassification).toBeUndefined();
  });

  it('formats an SSN and an ITIN with the dashes of a personal number', () => {
    expect(buildW9Submission(valid({ tinType: 'ssn', tin: '123456789' })).tin).toBe('123-45-6789');
    expect(buildW9Submission(valid({ tinType: 'itin', tin: '912701234' })).tin).toBe('912-70-1234');
  });
});

describe('serverFieldToFormField', () => {
  it('maps the server field paths to the form fields', () => {
    expect(serverFieldToFormField('address.postalCode')).toBe('postalCode');
    expect(serverFieldToFormField('address.state')).toBe('state');
    expect(serverFieldToFormField('federalTaxClassification')).toBe('classification');
    expect(serverFieldToFormField('tin')).toBe('tin');
    expect(serverFieldToFormField('unknown')).toBeNull();
  });
});
