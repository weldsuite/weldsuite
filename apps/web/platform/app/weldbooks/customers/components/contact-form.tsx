import { useMemo, type ReactNode } from 'react';
import { Controller, FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Building2, ExternalLink, User, X } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { AddressFields } from '@/components/address/address-fields';
import {
  cleanPostalAddress,
  isPostalAddressEmpty,
  toPostalAddressFormValue,
  type PostalAddress,
} from '@/components/address/postal-address';
import { useObjectPanel } from '@/components/object-panel/use-object-panel';
import type { Company } from '@/components/objects/company/use-company-data';
import type { Person } from '@/components/objects/person/use-person-data';
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
import { CrmCompanyPicker, CrmPersonPicker } from './crm-record-picker';
import { VendorBankSection } from './vendor-bank-section';
import {
  buildVendorTaxPayload,
  createVendorTaxSchema,
  initialVendorTaxValues,
  type VendorTaxProblem,
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
      const company = values.kind === 'company';
      if (company && !values.companyName?.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['companyName'], message: messages.companyNameRequired });
      }
      if (!company && !values.firstName?.trim() && !values.lastName?.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['firstName'], message: messages.personNameRequired });
      }

      const country = values.billingAddress?.country?.trim().toUpperCase();
      const brazilian = country === 'BR' || (!country && brazilianBooks);
      if (brazilian) {
        // A CNPJ (company) or CPF (person) with its check digits, an Inscrição Estadual and an IBGE code.
        const idProblem = contactTaxIdError(values.vatNumber ?? '');
        if (idProblem) ctx.addIssue({ code: 'custom', path: ['vatNumber'], message: identifierMessages.br[idProblem] });
        const ie = company ? ieError(values.registrationNumber ?? '') : null;
        if (ie) ctx.addIssue({ code: 'custom', path: ['registrationNumber'], message: identifierMessages.br.ie });
        if (brContactMunicipalityError(values.br.municipalityCode)) {
          ctx.addIssue({ code: 'custom', path: ['br', 'municipalityCode'], message: identifierMessages.br.municipalityCode });
        }
      }
      // A VAT number has to fit its country ("BE0123" is no Belgian number); an IBAN its length and check
      // digits. A person has no VAT number (outside Brazil, where the field holds their CPF).
      const vat = brazilian || !company ? undefined : values.vatNumber?.trim();
      if (vat) {
        const check = checkVatNumberFormat(vat, values.billingAddress?.country);
        if (!check.valid) {
          ctx.addIssue({
            code: 'custom',
            path: ['vatNumber'],
            message: identifierMessages.vatNumber
              .replace('{country}', check.prefix ?? '')
              .replace('{example}', check.example ?? ''),
          });
        }
      }
      const iban = values.iban?.trim();
      if (iban && !isValidIban(iban)) {
        ctx.addIssue({ code: 'custom', path: ['iban'], message: identifierMessages.iban });
      }
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

function splitName(name: string): { firstName: string; lastName: string } {
  const [first = '', ...rest] = name.trim().split(/\s+/);
  return { firstName: first, lastName: rest.join(' ') };
}

const EMPTY_CONTACT_PERSON: ContactFormValues['contactPerson'] = {
  personId: '',
  linkedName: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
};

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

function KindIcon({ kind, className }: Readonly<{ kind: ContactKind; className?: string }>) {
  const Icon = kind === 'company' ? Building2 : User;
  return <Icon className={className ?? 'h-4 w-4'} aria-hidden />;
}

/** A row saying which WeldCRM record something is, with the action that goes with it. */
function CrmRecordRow({ icon, title, subtitle, action }: Readonly<{
  icon: ReactNode;
  title: string;
  subtitle: string;
  action: ReactNode;
}>) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {icon}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

/**
 * Shared create/edit form for accounting contacts (customers and suppliers).
 * A contact is a company or a person: the WeldCRM company or person it wraps.
 * A new contact can be an existing WeldCRM record (picked here) or a new one
 * (created in WeldCRM on save). A company contact can have a contact person,
 * the company's billing contact in WeldCRM. Tax-ID and registration labels
 * follow the selected entity's jurisdiction (VAT number / GSTIN / EIN, KvK /
 * PAN / …).
 */
export function ContactForm({ mode, contact, isPending, onSubmit, onCancel }: Readonly<ContactFormProps>) {
  const { t } = useI18n();
  const st = useTranslations();
  const tc = t.accounting.contacts;
  const submitLabel = mode === 'add' ? tc.createContact : tc.saveChanges;
  const pendingLabel = mode === 'add' ? tc.creating : tc.saving;
  const { labels, code: jurisdictionCode, usesIban, features } = useJurisdictionLabels();
  const tvx = t.weldbooksUs.form1099.vendorTax;
  const tbc = t.weldbooksBr.contact;
  const { open: openObjectPanel } = useObjectPanel();
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
  const kind = form.watch('kind');
  const isCompany = kind === 'company';
  const crmLink = form.watch('crmLink');
  const contactPerson = form.watch('contactPerson');
  const sameAsBilling = form.watch('shippingSameAsBilling');
  const role = form.watch('role');
  // The words of the tax and registration fields follow the contact's country (a Belgian customer of a
  // Dutch company has a KBO/BCE number, not a KvK number); a US contact has no registration number here.
  const billingCountry = form.watch('billingAddress')?.country?.trim().toUpperCase();
  const brazilianContact = brazilianBooks && (!billingCountry || billingCountry === 'BR');
  const idLabels = contactIdLabels(billingCountry, t.accounting.terminology, labels);
  // A contact of Brazilian books without a country has the Brazilian labels too.
  const taxIdLabel = brazilianContact ? tbc.taxIdLabel : idLabels.taxId;
  const registrationLabel = brazilianContact ? t.accounting.terminology.registrationId.ie : idLabels.registrationId;
  const hasRegistrationNumber = Boolean(form.watch('registrationNumber')?.trim());
  const showRegistration = isCompany && (brazilianContact || idLabels.registrationId !== null || hasRegistrationNumber);
  // A person has no VAT or registration number; in Brazil the tax number field holds their CPF.
  const showTaxId = isCompany || brazilianContact;
  const showBanking = usesIban || !!contact?.iban || !!contact?.bic;
  // US-only sections: gated on the jurisdiction's features, never on a country code.
  const isVendor = role === 'supplier' || role === 'both';
  const isCustomer = role === 'customer' || role === 'both';
  const scope = {
    tax: features.form1099 && isVendor,
    bank: features.form1099 && isVendor,
    taxUse: features.salesTax && isCustomer,
  };
  const companyId = choosesIdentity ? (isCompany ? crmLink?.id : undefined) : contact?.companyId;
  const crmRecordId = isCompany ? contact?.companyId : contact?.personId;

  const submit = async (values: ContactFormValues) => {
    const billing = cleanPostalAddress(values.billingAddress);
    const shipping = values.shippingSameAsBilling ? billing : cleanPostalAddress(values.shippingAddress);
    // On edit an emptied address is sent as {} so the stored one is cleared,
    // and an emptied text field as "".
    const emptyAddress = mode === 'edit' ? {} : undefined;
    const text = (value: string | undefined) => (mode === 'edit' ? value?.trim() ?? '' : optional(value));
    const company = values.kind === 'company';
    const companyName = values.companyName?.trim() ?? '';
    const personName = [values.firstName, values.lastName].map((v) => v?.trim()).filter(Boolean).join(' ');
    const linkId = values.crmLink?.id;

    await onSubmit({
      ...buildVendorTaxPayload(values.vendorTax, contact, scope),
      role: values.role,
      ...(choosesIdentity ? { kind: values.kind } : {}),
      ...(choosesIdentity && linkId ? (company ? { companyId: linkId } : { personId: linkId }) : {}),
      name: company ? optional(values.invoiceName) ?? companyName : personName,
      ...(company
        ? {
            companyName,
            vatNumber: text(values.vatNumber),
            registrationNumber: text(values.registrationNumber),
            contactPerson: contactPersonPayload(values.contactPerson, contact),
          }
        : {
            firstName: optional(values.firstName),
            lastName: optional(values.lastName),
            // Brazil: a person's CPF; the server keeps it apart from a company's CNPJ.
            ...(brazilianContact ? { vatNumber: text(values.vatNumber) } : {}),
          }),
      email: text(values.email),
      phone: text(values.phone),
      iban: text(values.iban),
      bic: text(values.bic),
      paymentTermsDays: values.paymentTermsDays,
      notes: text(values.notes),
      billingAddress: billing ?? emptyAddress,
      shippingAddress: shipping ?? emptyAddress,
      ...(brazilianBooks ? { brFiscal: brazilianContact ? brFiscalPayload(values.br) : null } : {}),
    });
  };

  const fillIfEmpty = (field: 'email' | 'phone' | 'notes' | 'vatNumber' | 'registrationNumber', value: string | null | undefined) => {
    if (value && !form.getValues(field)?.trim()) form.setValue(field, value, { shouldDirty: true });
  };

  const fillAddressIfEmpty = (address: unknown) => {
    const normalized = normalizeAccountingAddress(address);
    if (normalized && isPostalAddressEmpty(form.getValues('billingAddress'))) {
      form.setValue('billingAddress', toPostalAddressFormValue(normalized), { shouldDirty: true });
    }
  };

  const setKind = (next: string) => {
    if (next !== 'company' && next !== 'person') return;
    if (next === kind) return;
    form.setValue('kind', next, { shouldDirty: true });
    // A picked record is of the other type now.
    form.setValue('crmLink', null);
    form.clearErrors(['companyName', 'firstName']);
  };

  /** The contact is this WeldCRM company: its details fill the form; what is already typed stays. */
  const pickCompany = (company: Company) => {
    form.setValue('crmLink', { id: company.id, name: company.displayName }, { shouldDirty: true });
    form.setValue('companyName', company.name, { shouldDirty: true, shouldValidate: true });
    form.setValue('invoiceName', company.displayName !== company.name ? company.displayName : '', { shouldDirty: true });
    fillIfEmpty('email', company.email);
    fillIfEmpty('phone', company.phone);
    fillIfEmpty('vatNumber', company.vatNumber);
    fillIfEmpty('registrationNumber', company.registrationNumber);
    fillIfEmpty('notes', company.notes);
    fillAddressIfEmpty(company.primaryAddress);
  };

  const pickPerson = (person: Person) => {
    form.setValue('crmLink', { id: person.id, name: person.displayName }, { shouldDirty: true });
    form.setValue('firstName', person.firstName ?? '', { shouldDirty: true, shouldValidate: true });
    form.setValue('lastName', person.lastName ?? '', { shouldDirty: true });
    fillIfEmpty('email', person.email);
    fillIfEmpty('phone', person.directPhone || person.mobilePhone);
    fillIfEmpty('notes', person.notes);
    fillAddressIfEmpty(person.primaryAddress);
  };

  /** "New company …" / "New person …": not in WeldCRM yet, start from what was typed. */
  const startNew = (typed: string) => {
    form.setValue('crmLink', null);
    if (!typed) return;
    if (isCompany) {
      form.setValue('companyName', typed, { shouldDirty: true, shouldValidate: true });
    } else {
      const names = splitName(typed);
      form.setValue('firstName', names.firstName, { shouldDirty: true, shouldValidate: true });
      form.setValue('lastName', names.lastName, { shouldDirty: true });
    }
  };

  const pickContactPerson = (person: Person) => {
    form.setValue(
      'contactPerson',
      {
        personId: person.id,
        linkedName: person.displayName,
        firstName: person.firstName ?? '',
        lastName: person.lastName ?? '',
        email: person.email ?? '',
        phone: person.directPhone || person.mobilePhone || '',
      },
      { shouldDirty: true },
    );
  };

  const newContactPerson = (typed: string) => {
    const names = splitName(typed);
    form.setValue('contactPerson', { ...EMPTY_CONTACT_PERSON, ...names }, { shouldDirty: true });
  };

  const removeContactPerson = () => form.setValue('contactPerson', EMPTY_CONTACT_PERSON, { shouldDirty: true });

  const errors = form.formState.errors;
  const hasContactPerson =
    !!contactPerson.personId ||
    [contactPerson.firstName, contactPerson.lastName, contactPerson.email, contactPerson.phone].some((v) => v?.trim());
  const showTaxCard = showTaxId || scope.taxUse;

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(submit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>{tc.general}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2 sm:col-span-2">
              <Label id="kind-label">{tc.kind}</Label>
              {choosesIdentity ? (
                <>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={kind}
                    onValueChange={setKind}
                    aria-labelledby="kind-label"
                    aria-describedby="kind-help"
                  >
                    <ToggleGroupItem value="company" className="gap-2 px-4">
                      <KindIcon kind="company" />
                      {tc.kinds.company}
                    </ToggleGroupItem>
                    <ToggleGroupItem value="person" className="gap-2 px-4">
                      <KindIcon kind="person" />
                      {tc.kinds.person}
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <p id="kind-help" className="text-xs text-muted-foreground">{tc.kindHelp}</p>
                </>
              ) : (
                <CrmRecordRow
                  icon={<KindIcon kind={kind} className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  title={tc.kinds[kind]}
                  subtitle={tc.linkedToCrmHelp}
                  action={
                    crmRecordId ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => openObjectPanel({ type: kind, id: crmRecordId })}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        {tc.openInCrm}
                      </Button>
                    ) : null
                  }
                />
              )}
            </div>

            {choosesIdentity ? (
              <div className="sm:col-span-2">
                {crmLink ? (
                  <CrmRecordRow
                    icon={<KindIcon kind={kind} className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    title={crmLink.name}
                    subtitle={`${tc.linkedToCrm} · ${tc.linkedToCrmHelp}`}
                    action={
                      <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={() => form.setValue('crmLink', null)}>
                        <X className="h-3.5 w-3.5" />
                        {tc.unlink}
                      </Button>
                    }
                  />
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">{tc.newInCrm[kind]}</p>
                    {isCompany ? (
                      <CrmCompanyPicker label={tc.findInCrm.company} onPick={pickCompany} onCreate={startNew} />
                    ) : (
                      <CrmPersonPicker label={tc.findInCrm.person} onPick={pickPerson} onCreate={startNew} />
                    )}
                  </div>
                )}
              </div>
            ) : null}

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="role">{tc.role}</Label>
              <Controller
                control={form.control}
                name="role"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="customer">{tc.roles.customer}</SelectItem>
                      <SelectItem value="supplier">{labels.supplier}</SelectItem>
                      <SelectItem value="both">{labels.customerAndSupplier}</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            {isCompany ? (
              <>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="companyName">{tc.companyName} *</Label>
                  <Input id="companyName" aria-describedby="companyName-help" {...form.register('companyName')} />
                  <p id="companyName-help" className="text-xs text-muted-foreground">{tc.companyNameHelp}</p>
                  {errors.companyName && <p className="text-sm text-destructive">{errors.companyName.message}</p>}
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="invoiceName">{tc.nameOnInvoice}</Label>
                  <Input
                    id="invoiceName"
                    aria-describedby="invoiceName-help"
                    placeholder={form.watch('companyName') || undefined}
                    {...form.register('invoiceName')}
                  />
                  <p id="invoiceName-help" className="text-xs text-muted-foreground">{tc.nameOnInvoiceHelp}</p>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="firstName">{tc.firstName}</Label>
                  <Input id="firstName" autoComplete="off" {...form.register('firstName')} />
                  {errors.firstName && <p className="text-sm text-destructive">{errors.firstName.message}</p>}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">{tc.lastName}</Label>
                  <Input id="lastName" autoComplete="off" {...form.register('lastName')} />
                </div>
              </>
            )}

            <div className="space-y-2">
              <Label htmlFor="email">{tc.email}</Label>
              <Input id="email" type="email" autoComplete="off" {...form.register('email')} />
              {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone">{tc.phone}</Label>
              <Input id="phone" type="tel" autoComplete="off" {...form.register('phone')} />
            </div>
          </CardContent>
        </Card>

        {isCompany ? (
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
              <div className="space-y-1.5">
                <CardTitle>{tc.contactPerson}</CardTitle>
                <CardDescription>{tc.contactPersonHelp}</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <CrmPersonPicker
                  label={tc.chooseContactPerson}
                  companyId={companyId}
                  onPick={pickContactPerson}
                  onCreate={newContactPerson}
                />
                {hasContactPerson ? (
                  <Button type="button" variant="ghost" size="sm" onClick={removeContactPerson}>
                    {tc.removeContactPerson}
                  </Button>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {contactPerson.personId ? (
                <CrmRecordRow
                  icon={<KindIcon kind="person" className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  title={tc.contactPersonLinked.replace('{name}', contactPerson.linkedName)}
                  subtitle={tc.linkedToCrm}
                  action={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => openObjectPanel({ type: 'person', id: contactPerson.personId })}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      {tc.openInCrm}
                    </Button>
                  }
                />
              ) : null}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="cp-firstName">{tc.firstName}</Label>
                  <Input id="cp-firstName" autoComplete="off" {...form.register('contactPerson.firstName')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cp-lastName">{tc.lastName}</Label>
                  <Input id="cp-lastName" autoComplete="off" {...form.register('contactPerson.lastName')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cp-email">{tc.email}</Label>
                  <Input id="cp-email" type="email" autoComplete="off" {...form.register('contactPerson.email')} />
                  {errors.contactPerson?.email && (
                    <p className="text-sm text-destructive">{errors.contactPerson.email.message}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cp-phone">{tc.phone}</Label>
                  <Input id="cp-phone" type="tel" autoComplete="off" {...form.register('contactPerson.phone')} />
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>{tc.billingAddress}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Controller
              control={form.control}
              name="billingAddress"
              render={({ field }) => (
                <AddressFields idPrefix="billing" value={field.value} onChange={field.onChange} />
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tc.shippingAddress}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Controller
              control={form.control}
              name="shippingSameAsBilling"
              render={({ field }) => (
                <label className="flex items-center gap-2 text-sm" htmlFor="shippingSameAsBilling">
                  <Checkbox
                    id="shippingSameAsBilling"
                    checked={field.value}
                    onCheckedChange={(checked) => {
                      const same = checked === true;
                      field.onChange(same);
                      // Start the separate address from the billing one rather than blank.
                      if (!same && isPostalAddressEmpty(form.getValues('shippingAddress'))) {
                        form.setValue('shippingAddress', { ...form.getValues('billingAddress') });
                      }
                    }}
                  />
                  {tc.sameAsBilling}
                </label>
              )}
            />
            {!sameAsBilling && (
              <Controller
                control={form.control}
                name="shippingAddress"
                render={({ field }) => (
                  <AddressFields idPrefix="shipping" value={field.value} onChange={field.onChange} />
                )}
              />
            )}
          </CardContent>
        </Card>

        {showTaxCard ? (
          <Card>
            <CardHeader>
              <CardTitle>{tc.taxAndRegistration}</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {showTaxId ? (
                <div className="space-y-2">
                  <Label htmlFor="vatNumber">{taxIdLabel}</Label>
                  <Input
                    id="vatNumber"
                    placeholder={brazilianContact ? tbc.taxIdPlaceholder : tc.taxIdPlaceholder}
                    aria-invalid={Boolean(errors.vatNumber)}
                    {...form.register('vatNumber')}
                  />
                  {errors.vatNumber && <p className="text-sm text-destructive">{errors.vatNumber.message}</p>}
                </div>
              ) : null}
              {showRegistration ? (
                <div className="space-y-2">
                  <Label htmlFor="registrationNumber">{registrationLabel ?? labels.registrationId}</Label>
                  <Input id="registrationNumber" aria-invalid={Boolean(errors.registrationNumber)} {...form.register('registrationNumber')} />
                  {errors.registrationNumber && <p className="text-sm text-destructive">{errors.registrationNumber.message}</p>}
                </div>
              ) : null}
              {scope.taxUse ? (
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="taxUse">{tvx.taxUse}</Label>
                  <Controller
                    control={form.control}
                    name="vendorTax.taxUse"
                    render={({ field }) => (
                      <Select value={field.value || '__none__'} onValueChange={(next) => field.onChange(next === '__none__' ? '' : next)}>
                        <SelectTrigger id="taxUse" aria-describedby="taxUse-help">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">{tvx.notSet}</SelectItem>
                          <SelectItem value="business">{tvx.taxUseOptions.business}</SelectItem>
                          <SelectItem value="personal">{tvx.taxUseOptions.personal}</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                  <p id="taxUse-help" className="text-xs text-muted-foreground">{tvx.taxUseHelp}</p>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {brazilianContact ? <BrContactSection /> : null}

        {scope.tax ? <VendorTaxSection contact={contact} /> : null}

        {showBanking && (
          <Card>
            <CardHeader>
              <CardTitle>{tc.bankingSection}</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="iban">{tc.iban}</Label>
                <Input id="iban" aria-invalid={Boolean(errors.iban)} {...form.register('iban')} />
                {errors.iban && <p className="text-sm text-destructive">{errors.iban.message}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="bic">{tc.bic}</Label>
                <Input id="bic" {...form.register('bic')} />
              </div>
            </CardContent>
          </Card>
        )}

        {scope.bank ? <VendorBankSection contact={contact} /> : null}

        <Card>
          <CardHeader>
            <CardTitle>{tc.payment}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="paymentTermsDays">{tc.paymentTermsDays}</Label>
              <Input
                id="paymentTermsDays"
                type="number"
                min={0}
                step={1}
                aria-describedby="paymentTermsDays-help"
                {...form.register('paymentTermsDays')}
              />
              <p id="paymentTermsDays-help" className="text-xs text-muted-foreground">{tc.paymentTermsHelp}</p>
              {errors.paymentTermsDays && (
                <p className="text-sm text-destructive">{errors.paymentTermsDays.message}</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <Label htmlFor="notes" className="text-base font-semibold">{tc.notes}</Label>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea id="notes" rows={4} placeholder={tc.notesPlaceholder} {...form.register('notes')} />
          </CardContent>
        </Card>

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3">
          <Button type="button" variant="outline" onClick={onCancel}>
            {tc.cancel}
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending ? pendingLabel : submitLabel}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}
