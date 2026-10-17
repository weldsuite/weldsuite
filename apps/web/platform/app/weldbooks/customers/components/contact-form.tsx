import { useMemo } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import {
  cleanPostalAddress,
  toPostalAddressFormValue,
  type PostalAddress,
} from '@/components/address/postal-address';
import type { ContactKind, Customer } from '@/lib/api/domains/weldbooks';
import type { VendorTaxPayload, VendorTaxView } from '@/lib/api/domains/weldbooks-1099';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { contactIdLabels } from '@/lib/weldbooks/contact-id-labels';
import { checkVatNumberFormat, isValidIban } from '@/lib/weldbooks/identifiers';
import { contactTaxIdError, ieError } from '@/lib/weldbooks/br-entity';
import {
  brContactMunicipalityError,
  brContactValues,
  brFiscalPayload,
  type BrContactValues,
  type BrFiscalView,
} from '@/lib/weldbooks/br-contact';
import { useI18n } from '@/lib/i18n/provider';
import { BrContactSection } from './br-contact-section';
import {
  BankingCard,
  BillingAddressCard,
  ContactPersonCard,
  EMPTY_CONTACT_PERSON,
  GeneralCard,
  NotesCard,
  PaymentCard,
  ShippingAddressCard,
  splitName,
  TaxRegistrationCard,
  type ContactIdFields,
} from './contact-form-sections';
import { VendorBankSection } from './vendor-bank-section';
import {
  buildVendorTaxPayload,
  createVendorTaxSchema,
  initialVendorTaxValues,
  type VendorTaxProblem,
  type VendorTaxScope,
} from './vendor-tax-model';
import { VendorTaxSection } from './vendor-tax-section';

const addressSchema = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  county: z.string().optional(),
});

interface ContactFormMessages {
  invalidEmail: string;
  companyNameRequired: string;
  personNameRequired: string;
}

interface IdentifierMessages {
  /** `{country}` and `{example}` are filled in. */
  vatNumber: string;
  iban: string;
  /** Brazil: CNPJ / CPF, state registration and municipality code. */
  br: Record<'cnpj' | 'cpf' | 'cnpjChecksum' | 'cpfChecksum' | 'ie' | 'municipalityCode', string>;
}

function createContactSchema(
  messages: ContactFormMessages,
  vendorTaxMessages: Record<VendorTaxProblem, string>,
  identifierMessages: IdentifierMessages,
  /** The entity keeps Brazilian books: a contact without a country is a Brazilian one. */
  brazilianBooks: boolean,
) {
  const email = z.string().trim().email(messages.invalidEmail).optional().or(z.literal(''));
  return z
    .object({
      vendorTax: createVendorTaxSchema(vendorTaxMessages),
      kind: z.enum(['company', 'person']),
      /** The WeldCRM company or person this new contact is, when one was picked. */
      crmLink: z.object({ id: z.string(), name: z.string() }).nullable(),
      role: z.enum(['customer', 'supplier', 'both']),
      companyName: z.string().optional(),
      invoiceName: z.string().optional(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      email,
      phone: z.string().optional(),
      vatNumber: z.string().optional(),
      registrationNumber: z.string().optional(),
      contactPerson: z.object({
        personId: z.string(),
        linkedName: z.string(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        email,
        phone: z.string().optional(),
      }),
      iban: z.string().optional(),
      bic: z.string().optional(),
      paymentTermsDays: z.coerce.number().int().min(0).optional(),
      notes: z.string().optional(),
      billingAddress: addressSchema,
      shippingSameAsBilling: z.boolean(),
      shippingAddress: addressSchema,
      br: z.custom<BrContactValues>(),
    })
    .superRefine((values, ctx) => {
      checkNames(values, ctx, messages);
      if (isBrazilianContact(values.billingAddress?.country, brazilianBooks)) {
        checkBrazilianIds(values, ctx, identifierMessages.br);
      } else if (values.kind === 'company') {
        // A person has no VAT number (outside Brazil, where the field holds their CPF).
        checkVatNumber(values, ctx, identifierMessages.vatNumber);
      }
      const iban = values.iban?.trim();
      if (iban && !isValidIban(iban)) {
        ctx.addIssue({ code: 'custom', path: ['iban'], message: identifierMessages.iban });
      }
    });
}

/** The fields the cross-field checks read. */
interface CheckedValues {
  kind: ContactKind;
  companyName?: string;
  firstName?: string;
  lastName?: string;
  vatNumber?: string;
  registrationNumber?: string;
  billingAddress?: { country?: string };
  br: BrContactValues;
}

/** A Brazilian contact, or one without a country in Brazilian books. */
function isBrazilianContact(country: string | undefined, brazilianBooks: boolean): boolean {
  const code = country?.trim().toUpperCase();
  return code === 'BR' || (!code && brazilianBooks);
}

/** A company needs its name; a person a first or a last name. */
function checkNames(values: CheckedValues, ctx: z.RefinementCtx, messages: ContactFormMessages): void {
  if (values.kind === 'company') {
    if (!values.companyName?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['companyName'], message: messages.companyNameRequired });
    }
    return;
  }
  if (!values.firstName?.trim() && !values.lastName?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['firstName'], message: messages.personNameRequired });
  }
}

/** A CNPJ (company) or CPF (person) with its check digits, a company's Inscrição Estadual and an IBGE code. */
function checkBrazilianIds(values: CheckedValues, ctx: z.RefinementCtx, messages: IdentifierMessages['br']): void {
  const idProblem = contactTaxIdError(values.vatNumber ?? '');
  if (idProblem) ctx.addIssue({ code: 'custom', path: ['vatNumber'], message: messages[idProblem] });
  if (values.kind === 'company' && ieError(values.registrationNumber ?? '')) {
    ctx.addIssue({ code: 'custom', path: ['registrationNumber'], message: messages.ie });
  }
  if (brContactMunicipalityError(values.br.municipalityCode)) {
    ctx.addIssue({ code: 'custom', path: ['br', 'municipalityCode'], message: messages.municipalityCode });
  }
}

/** A VAT number has to fit its country ("BE0123" is no Belgian number). */
function checkVatNumber(values: CheckedValues, ctx: z.RefinementCtx, message: string): void {
  const vat = values.vatNumber?.trim();
  if (!vat) return;
  const check = checkVatNumberFormat(vat, values.billingAddress?.country);
  if (check.valid) return;
  ctx.addIssue({
    code: 'custom',
    path: ['vatNumber'],
    message: message.replace('{country}', check.prefix ?? '').replace('{example}', check.example ?? ''),
  });
}

export type ContactFormValues = z.infer<ReturnType<typeof createContactSchema>>;

/** A company contact's contact person as sent: an existing CRM person (`personId`) or a new one; null removes it. */
export interface ContactPersonPayload {
  personId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}

/**
 * The accounting-contacts create/update body (see books-api `/api/accounting-contacts`).
 * `kind` and the CRM record to link are sent while the contact has no identity
 * yet (always on create); a contact's kind is fixed after that. The vendor tax
 * fields are present for a US entity only; `tin` and `achAccountNumber` appear
 * only when typed. On edit a blank text field is sent as "" so the stored value
 * is cleared.
 */
export interface ContactPayload extends VendorTaxPayload {
  role: ContactFormValues['role'];
  kind?: ContactKind;
  companyId?: string;
  personId?: string;
  name: string;
  companyName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  vatNumber?: string;
  registrationNumber?: string;
  contactPerson?: ContactPersonPayload | null;
  iban?: string;
  bic?: string;
  paymentTermsDays?: number;
  notes?: string;
  billingAddress?: PostalAddress;
  shippingAddress?: PostalAddress;
  /** Brazil: `null` clears what is stored. Present only on a Brazilian entity's contact. */
  brFiscal?: Omit<BrFiscalView, 'taxId'> | null;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sameAddress(a: PostalAddress | null, b: PostalAddress | null): boolean {
  const ca = cleanPostalAddress(a) ?? {};
  const cb = cleanPostalAddress(b) ?? {};
  return JSON.stringify(ca) === JSON.stringify(cb);
}

/** A contact as the form reads it: the list/detail view plus the vendor tax fields the server adds. */
export type ContactFormContact = Customer & VendorTaxView;

/** What a contact from before contacts had a type most likely is, read the way the server reads it. */
function guessKind(contact: ContactFormContact | undefined): ContactKind {
  if (!contact) return 'company';
  if (contact.kind) return contact.kind;
  if (contact.companyName || contact.vatNumber || contact.registrationNumber) return 'company';
  if (contact.firstName || contact.lastName) return 'person';
  return 'company';
}

function initialValues(contact: ContactFormContact | undefined, defaultCountry: string | null): ContactFormValues {
  const billing = normalizeAccountingAddress(contact?.billingAddress);
  const shipping = normalizeAccountingAddress(contact?.shippingAddress);
  const role = contact?.role === 'supplier' || contact?.role === 'both' ? contact.role : 'customer';
  const kind = guessKind(contact);
  const name = contact?.name ?? '';
  // A contact without an identity yet has only its name to go on.
  const legacy = !!contact && !contact.kind;
  const companyName = contact?.companyName ?? (legacy && kind === 'company' ? name : '');
  const personNames =
    legacy && kind === 'person' && !contact?.firstName && !contact?.lastName
      ? splitName(name)
      : { firstName: contact?.firstName ?? '', lastName: contact?.lastName ?? '' };
  const cp = contact?.contactPerson;
  return {
    vendorTax: initialVendorTaxValues(contact),
    kind,
    crmLink: null,
    role,
    companyName,
    invoiceName: kind === 'company' && name && name !== companyName ? name : '',
    ...personNames,
    email: contact?.email ?? '',
    phone: contact?.phone ?? '',
    // A person's CPF is kept apart from the CNPJ: the form shows whichever the contact has.
    vatNumber: contact?.vatNumber || contact?.brFiscal?.taxId || '',
    registrationNumber: contact?.registrationNumber ?? '',
    contactPerson: cp
      ? {
          personId: cp.personId,
          linkedName: cp.name,
          firstName: cp.firstName ?? '',
          lastName: cp.lastName ?? '',
          email: cp.email ?? '',
          phone: cp.phone ?? '',
        }
      : EMPTY_CONTACT_PERSON,
    iban: contact?.iban ?? '',
    bic: contact?.bic ?? '',
    paymentTermsDays: contact?.paymentTermsDays ?? 30,
    notes: contact?.notes ?? '',
    billingAddress: toPostalAddressFormValue(
      billing ?? (contact ? null : { country: defaultCountry ?? '' }),
    ),
    shippingSameAsBilling: !shipping || sameAddress(billing, shipping),
    shippingAddress: toPostalAddressFormValue(shipping),
    br: brContactValues(contact?.brFiscal),
  };
}

/** The `contactPerson` to send: the linked person, a new one, null when it was removed, or nothing. */
function contactPersonPayload(
  values: ContactFormValues['contactPerson'],
  contact: ContactFormContact | undefined,
): ContactPersonPayload | null | undefined {
  const fields = {
    firstName: values.firstName?.trim() ?? '',
    lastName: values.lastName?.trim() ?? '',
    email: values.email?.trim() ?? '',
    phone: values.phone?.trim() ?? '',
  };
  // Linked: every field, blanks included, so a cleared one is cleared on the CRM person.
  if (values.personId) return { personId: values.personId, ...fields };
  if (Object.values(fields).some(Boolean)) {
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value)) as ContactPersonPayload;
  }
  return contact?.contactPerson ? null : undefined;
}

interface ContactFormProps {
  mode: 'add' | 'edit';
  contact?: ContactFormContact;
  isPending: boolean;
  onSubmit: (payload: ContactPayload) => void | Promise<void>;
  onCancel: () => void;
}

interface PayloadContext {
  mode: 'add' | 'edit';
  contact: ContactFormContact | undefined;
  /** The contact has no CRM identity yet: send its kind, and the record picked for it. */
  choosesIdentity: boolean;
  brazilianBooks: boolean;
  brazilianContact: boolean;
  scope: VendorTaxScope;
}

type TextField = (value: string | undefined) => string | undefined;

function identityPayload(values: ContactFormValues, choosesIdentity: boolean): Partial<ContactPayload> {
  if (!choosesIdentity) return {};
  const linkId = values.crmLink?.id;
  if (!linkId) return { kind: values.kind };
  return values.kind === 'company' ? { kind: 'company', companyId: linkId } : { kind: 'person', personId: linkId };
}

/** The names and identifiers of a company, or of a person. */
function kindPayload(
  values: ContactFormValues,
  ctx: PayloadContext,
  text: TextField,
): Partial<ContactPayload> & { name: string } {
  if (values.kind === 'company') {
    const companyName = values.companyName?.trim() ?? '';
    return {
      name: optional(values.invoiceName) ?? companyName,
      companyName,
      vatNumber: text(values.vatNumber),
      registrationNumber: text(values.registrationNumber),
      contactPerson: contactPersonPayload(values.contactPerson, ctx.contact),
    };
  }
  return {
    name: [values.firstName, values.lastName].map((v) => v?.trim()).filter(Boolean).join(' '),
    firstName: optional(values.firstName),
    lastName: optional(values.lastName),
    // Brazil: a person's CPF; the server keeps it apart from a company's CNPJ.
    ...(ctx.brazilianContact ? { vatNumber: text(values.vatNumber) } : {}),
  };
}

function brFiscalPart(values: ContactFormValues, ctx: PayloadContext): Partial<ContactPayload> {
  if (!ctx.brazilianBooks) return {};
  return { brFiscal: ctx.brazilianContact ? brFiscalPayload(values.br) : null };
}

/** The create/update body for what the form holds. */
export function buildContactPayload(values: ContactFormValues, ctx: PayloadContext): ContactPayload {
  const edit = ctx.mode === 'edit';
  const billing = cleanPostalAddress(values.billingAddress);
  const shipping = values.shippingSameAsBilling ? billing : cleanPostalAddress(values.shippingAddress);
  // On edit an emptied address is sent as {} so the stored one is cleared,
  // and an emptied text field as "".
  const emptyAddress = edit ? {} : undefined;
  const text: TextField = (value) => (edit ? value?.trim() ?? '' : optional(value));
  return {
    ...buildVendorTaxPayload(values.vendorTax, ctx.contact, ctx.scope),
    role: values.role,
    ...identityPayload(values, ctx.choosesIdentity),
    ...kindPayload(values, ctx, text),
    email: text(values.email),
    phone: text(values.phone),
    iban: text(values.iban),
    bic: text(values.bic),
    paymentTermsDays: values.paymentTermsDays,
    notes: text(values.notes),
    billingAddress: billing ?? emptyAddress,
    shippingAddress: shipping ?? emptyAddress,
    ...brFiscalPart(values, ctx),
  };
}

type I18nTexts = ReturnType<typeof useI18n>['t'];
type JurisdictionTexts = ReturnType<typeof useJurisdictionLabels>['labels'];

/**
 * The tax and registration fields of this contact. Their words follow the contact's country (a
 * Belgian customer of a Dutch company has a KBO/BCE number, not a KvK number), and a contact of
 * Brazilian books without a country has the Brazilian ones. A person has no VAT or registration
 * number (in Brazil the tax number field holds their CPF); a US contact has no registration number.
 */
function contactIdFields(
  t: I18nTexts,
  labels: JurisdictionTexts,
  contact: { isCompany: boolean; brazilian: boolean; country: string | undefined; hasRegistrationNumber: boolean },
): ContactIdFields {
  const tbc = t.weldbooksBr.contact;
  const idLabels = contactIdLabels(contact.country, t.accounting.terminology, labels);
  let taxIdLabel: string | null = null;
  if (contact.brazilian) taxIdLabel = tbc.taxIdLabel;
  else if (contact.isCompany) taxIdLabel = idLabels.taxId;

  let registrationLabel: string | null = null;
  if (contact.isCompany && contact.brazilian) registrationLabel = t.accounting.terminology.registrationId.ie;
  else if (contact.isCompany && (idLabels.registrationId !== null || contact.hasRegistrationNumber)) {
    registrationLabel = idLabels.registrationId ?? labels.registrationId;
  }
  return {
    taxIdLabel,
    taxIdPlaceholder: contact.brazilian ? tbc.taxIdPlaceholder : t.accounting.contacts.taxIdPlaceholder,
    registrationLabel,
  };
}

/** US-only sections: gated on the jurisdiction's features, never on a country code. */
function vendorTaxScope(features: { form1099: boolean; salesTax: boolean }, role: ContactFormValues['role']): VendorTaxScope {
  const isVendor = role === 'supplier' || role === 'both';
  const isCustomer = role === 'customer' || role === 'both';
  return {
    tax: features.form1099 && isVendor,
    bank: features.form1099 && isVendor,
    taxUse: features.salesTax && isCustomer,
  };
}

/** The WeldCRM record an existing contact is (for "Open in WeldCRM"). */
function crmRecordIdOf(contact: ContactFormContact | undefined, isCompany: boolean): string | null | undefined {
  return isCompany ? contact?.companyId : contact?.personId;
}

/** The WeldCRM company of a company contact: picked in the form, or the one it already is. */
function companyIdOf(choosesIdentity: boolean, crmLinkId: string | undefined, contact: ContactFormContact | undefined) {
  return choosesIdentity ? crmLinkId : contact?.companyId;
}

function FormActions({ mode, isPending, onCancel }: Readonly<Pick<ContactFormProps, 'mode' | 'isPending' | 'onCancel'>>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const submitLabel = mode === 'add' ? tc.createContact : tc.saveChanges;
  const pendingLabel = mode === 'add' ? tc.creating : tc.saving;
  return (
    <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3">
      <Button type="button" variant="outline" onClick={onCancel}>
        {tc.cancel}
      </Button>
      <Button type="submit" disabled={isPending}>
        {isPending ? pendingLabel : submitLabel}
      </Button>
    </div>
  );
}

/**
 * Shared create/edit form for accounting contacts (customers and suppliers).
 * A contact is a company or a person: the WeldCRM company or person it wraps.
 * A new contact can be an existing WeldCRM record (picked here) or a new one
 * (created in WeldCRM on save). A company contact can have a contact person,
 * the company's billing contact in WeldCRM. Tax-ID and registration labels
 * follow the contact's country and the entity's jurisdiction (VAT number /
 * GSTIN / EIN, KvK / PAN / …).
 */
export function ContactForm({ mode, contact, isPending, onSubmit, onCancel }: Readonly<ContactFormProps>) {
  const { t } = useI18n();
  const st = useTranslations();
  const tc = t.accounting.contacts;
  const { labels, code: jurisdictionCode, usesIban, features } = useJurisdictionLabels();
  const tvx = t.weldbooksUs.form1099.vendorTax;
  const tbc = t.weldbooksBr.contact;
  // Brazilian books: the CNPJ / CPF, IE and fiscal details apply to a Brazilian (or country-less) contact.
  const brazilianBooks = features.brTaxReturn || jurisdictionCode === 'BR';
  const schema = useMemo(
    () =>
      createContactSchema(
        {
          invalidEmail: st('sweep.weldbooks.contactForm.invalidEmail'),
          companyNameRequired: tc.companyNameRequired,
          personNameRequired: tc.personNameRequired,
        },
        tvx.errors,
        { vatNumber: tc.vatNumberInvalid, iban: tc.ibanInvalid, br: tbc.errors },
        brazilianBooks,
      ),
    [st, tc.companyNameRequired, tc.personNameRequired, tvx.errors, tc.vatNumberInvalid, tc.ibanInvalid, tbc.errors, brazilianBooks],
  );

  const defaults = useMemo(
    () => initialValues(contact, jurisdictionCode),
    [contact, jurisdictionCode],
  );

  const form = useForm<ContactFormValues>({
    resolver: zodResolver(schema),
    values: defaults,
    resetOptions: { keepDirtyValues: true },
  });

  // The type is chosen while the contact has no CRM identity yet: always when adding.
  const choosesIdentity = mode === 'add' || !contact?.kind;
  const isCompany = form.watch('kind') === 'company';
  const country = form.watch('billingAddress')?.country?.trim().toUpperCase();
  const brazilianContact = brazilianBooks && isBrazilianContact(country, true);
  const ids = contactIdFields(t, labels, {
    isCompany,
    brazilian: brazilianContact,
    country,
    hasRegistrationNumber: Boolean(form.watch('registrationNumber')?.trim()),
  });
  const scope = vendorTaxScope(features, form.watch('role'));
  const showTaxCard = ids.taxIdLabel !== null || ids.registrationLabel !== null || scope.taxUse;
  const showBanking = usesIban || !!contact?.iban || !!contact?.bic;

  const submit = (values: ContactFormValues) =>
    onSubmit(buildContactPayload(values, { mode, contact, choosesIdentity, brazilianBooks, brazilianContact, scope }));

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(submit)} className="space-y-6">
        <GeneralCard choosesIdentity={choosesIdentity} crmRecordId={crmRecordIdOf(contact, isCompany)} />
        {isCompany ? (
          <ContactPersonCard companyId={companyIdOf(choosesIdentity, form.watch('crmLink')?.id, contact)} />
        ) : null}
        <BillingAddressCard />
        <ShippingAddressCard />
        {showTaxCard ? <TaxRegistrationCard ids={ids} showTaxUse={scope.taxUse} /> : null}
        {brazilianContact ? <BrContactSection /> : null}
        {scope.tax ? <VendorTaxSection contact={contact} /> : null}
        {showBanking ? <BankingCard /> : null}
        {scope.bank ? <VendorBankSection contact={contact} /> : null}
        <PaymentCard />
        <NotesCard />
        <FormActions mode={mode} isPending={isPending} onCancel={onCancel} />
      </form>
    </FormProvider>
  );
}
