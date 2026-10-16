/**
 * The company / person half of the new-contact form: what blocks a save and
 * what goes into the create request.
 */

import {
  EMPTY_IDENTITY,
  contactIdentityProblems,
  toContactIdentityPayload,
  type ContactIdentityDraft,
} from '@/lib/contact-kind';

function draft(overrides: Partial<ContactIdentityDraft>): ContactIdentityDraft {
  return { ...EMPTY_IDENTITY, ...overrides };
}

describe('contactIdentityProblems', () => {
  it('starts as a company', () => {
    expect(EMPTY_IDENTITY.kind).toBe('company');
  });

  it('needs a company name for a company', () => {
    expect(contactIdentityProblems(draft({ kind: 'company', companyName: '  ' }))).toEqual({
      companyName: 'required',
    });
    expect(contactIdentityProblems(draft({ kind: 'company', companyName: 'Acme' }))).toEqual({});
  });

  it('does not take a name on invoices in place of the company name', () => {
    expect(contactIdentityProblems(draft({ kind: 'company', nameOnInvoices: 'Acme' }))).toEqual({
      companyName: 'required',
    });
  });

  it('needs a first or a last name for a person, either one will do', () => {
    expect(contactIdentityProblems(draft({ kind: 'person' }))).toEqual({ personName: 'required' });
    expect(contactIdentityProblems(draft({ kind: 'person', firstName: 'Jan' }))).toEqual({});
    expect(contactIdentityProblems(draft({ kind: 'person', lastName: 'Jansen' }))).toEqual({});
  });

  it('ignores the company name typed before switching to person', () => {
    expect(contactIdentityProblems(draft({ kind: 'person', companyName: 'Acme' }))).toEqual({
      personName: 'required',
    });
  });
});

describe('toContactIdentityPayload', () => {
  it('names a company after its company name when no name on invoices is given', () => {
    expect(
      toContactIdentityPayload(draft({ kind: 'company', companyName: ' Acme B.V. ' }), { withTaxId: true }),
    ).toEqual({ kind: 'company', fullName: 'Acme B.V.', companyName: 'Acme B.V.' });
  });

  it('prints the name on invoices and keeps the registered name as the company name', () => {
    expect(
      toContactIdentityPayload(
        draft({ kind: 'company', companyName: 'Acme Holding B.V.', nameOnInvoices: 'Acme' }),
        { withTaxId: true },
      ),
    ).toEqual({ kind: 'company', fullName: 'Acme', companyName: 'Acme Holding B.V.' });
  });

  it("sends a company's tax number only where the form has the field", () => {
    const company = draft({ kind: 'company', companyName: 'Acme', taxId: ' NL123456789B01 ' });
    expect(toContactIdentityPayload(company, { withTaxId: true }).vatNumber).toBe('NL123456789B01');
    expect(toContactIdentityPayload(company, { withTaxId: false })).not.toHaveProperty('vatNumber');
  });

  it("joins a person's first and last name into the full name", () => {
    expect(
      toContactIdentityPayload(draft({ kind: 'person', firstName: ' Jan ', lastName: 'Jansen' }), {
        withTaxId: true,
      }),
    ).toEqual({ kind: 'person', fullName: 'Jan Jansen', firstName: 'Jan', lastName: 'Jansen' });
  });

  it("sends only the half of a person's name that was typed", () => {
    expect(
      toContactIdentityPayload(draft({ kind: 'person', lastName: 'Jansen' }), { withTaxId: true }),
    ).toEqual({ kind: 'person', fullName: 'Jansen', lastName: 'Jansen' });
  });

  it('never carries company fields or a tax number onto a person', () => {
    const payload = toContactIdentityPayload(
      draft({
        kind: 'person',
        firstName: 'Jan',
        companyName: 'Acme',
        nameOnInvoices: 'Acme',
        taxId: 'NL123456789B01',
      }),
      { withTaxId: true },
    );
    expect(payload).not.toHaveProperty('companyName');
    expect(payload).not.toHaveProperty('vatNumber');
    expect(payload.fullName).toBe('Jan');
  });
});
