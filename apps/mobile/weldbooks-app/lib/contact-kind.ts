/**
 * Company or person: the identity half of the new-contact form.
 *
 * A WeldBooks contact wraps a WeldCRM company or person. Without `kind`,
 * books-api guesses from the names it is sent and a bare name becomes a
 * company, so the form always says which one it is and sends the names that go
 * with it. A person has no VAT or registration number; books-api refuses one.
 */

import type { ContactKind } from '@/types/accounting';

/** The limits books-api's create schema puts on these fields. */
export const NAME_MAX_LENGTH = 255;
export const PERSON_NAME_MAX_LENGTH = 100;

export interface ContactIdentityDraft {
  kind: ContactKind;
  companyName: string;
  /** Company only: a trading name printed on invoices instead of the company name. */
  nameOnInvoices: string;
  firstName: string;
  lastName: string;
  /** Company only: the VAT or other tax number. */
  taxId: string;
}

export const EMPTY_IDENTITY: ContactIdentityDraft = {
  kind: 'company',
  companyName: '',
  nameOnInvoices: '',
  firstName: '',
  lastName: '',
  taxId: '',
};

export interface ContactIdentityProblems {
  companyName?: 'required';
  personName?: 'required';
}

/** A company needs its name; a person needs a first or a last name. */
export function contactIdentityProblems(draft: ContactIdentityDraft): ContactIdentityProblems {
  if (draft.kind === 'company') {
    return draft.companyName.trim() ? {} : { companyName: 'required' };
  }
  return draft.firstName.trim() || draft.lastName.trim() ? {} : { personName: 'required' };
}

export interface ContactIdentityPayload {
  kind: ContactKind;
  fullName: string;
  companyName?: string;
  firstName?: string;
  lastName?: string;
  vatNumber?: string;
}

/**
 * The identity fields of the create request. The form keeps what was typed for
 * both kinds so switching back and forth loses nothing, but only the chosen
 * kind's fields go out: a company's VAT number never lands on a person.
 * `withTaxId` is false where the form has no tax-ID field (US).
 */
export function toContactIdentityPayload(
  draft: ContactIdentityDraft,
  options: { withTaxId: boolean },
): ContactIdentityPayload {
  if (draft.kind === 'person') {
    const firstName = draft.firstName.trim();
    const lastName = draft.lastName.trim();
    return {
      kind: 'person',
      fullName: [firstName, lastName].filter(Boolean).join(' '),
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
    };
  }

  const companyName = draft.companyName.trim();
  const taxId = options.withTaxId ? draft.taxId.trim() : '';
  return {
    kind: 'company',
    // The name on invoices; books-api stores it as the trading name when it differs.
    fullName: draft.nameOnInvoices.trim() || companyName,
    companyName,
    ...(taxId ? { vatNumber: taxId } : {}),
  };
}
