/**
 * The cards of the contact form (contact-form.tsx). Each reads and writes the
 * form through `useFormContext`; the form itself keeps the schema, the initial
 * values and the payload.
 */

import type { ReactNode } from 'react';
import { Controller, useFormContext, type UseFormReturn } from 'react-hook-form';
import { Building2, ExternalLink, User, X } from 'lucide-react';
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
import { isPostalAddressEmpty, toPostalAddressFormValue } from '@/components/address/postal-address';
import { useObjectPanel } from '@/components/object-panel/use-object-panel';
import type { Company } from '@/components/objects/company/use-company-data';
import type { Person } from '@/components/objects/person/use-person-data';
import type { ContactKind } from '@/lib/api/domains/weldbooks';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { useI18n } from '@/lib/i18n/provider';
import { CrmCompanyPicker, CrmPersonPicker } from './crm-record-picker';
import type { ContactFormValues } from './contact-form';

type ContactForm = UseFormReturn<ContactFormValues>;

export function splitName(name: string): { firstName: string; lastName: string } {
  const [first = '', ...rest] = name.trim().split(/\s+/);
  return { firstName: first, lastName: rest.join(' ') };
}

export const EMPTY_CONTACT_PERSON: ContactFormValues['contactPerson'] = {
  personId: '',
  linkedName: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
};

function KindIcon({ kind, className }: Readonly<{ kind: ContactKind; className?: string }>) {
  const Icon = kind === 'company' ? Building2 : User;
  return <Icon className={className ?? 'h-4 w-4'} aria-hidden />;
}

/** A row saying which WeldCRM record something is, with the action that goes with it. */
function CrmRecordRow({ kind, title, subtitle, action }: Readonly<{
  kind: ContactKind;
  title: string;
  subtitle: string;
  action: ReactNode;
}>) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <KindIcon kind={kind} className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

function OpenInCrmButton({ type, id }: Readonly<{ type: ContactKind; id: string }>) {
  const { t } = useI18n();
  const { open: openObjectPanel } = useObjectPanel();
  return (
    <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={() => openObjectPanel({ type, id })}>
      <ExternalLink className="h-3.5 w-3.5" />
      {t.accounting.contacts.openInCrm}
    </Button>
  );
}

function FieldError({ message }: Readonly<{ message?: string }>) {
  return message ? <p className="text-sm text-destructive">{message}</p> : null;
}

// ---------------------------------------------------------------------------
// General: the type, the WeldCRM record, the role and the name fields
// ---------------------------------------------------------------------------

function KindToggle() {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const form = useFormContext<ContactFormValues>();
  const kind = form.watch('kind');

  const setKind = (next: string) => {
    if ((next !== 'company' && next !== 'person') || next === kind) return;
    form.setValue('kind', next, { shouldDirty: true });
    // A picked record is of the other type now.
    form.setValue('crmLink', null);
    form.clearErrors(['companyName', 'firstName']);
  };

  return (
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
  );
}

/** The type: chosen while the contact has no CRM record yet, shown (with its record) after that. */
function KindField({ choosesIdentity, crmRecordId }: Readonly<{ choosesIdentity: boolean; crmRecordId?: string | null }>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const kind = useFormContext<ContactFormValues>().watch('kind');
  return (
    <div className="space-y-2 sm:col-span-2">
      <Label id="kind-label">{tc.kind}</Label>
      {choosesIdentity ? (
        <KindToggle />
      ) : (
        <CrmRecordRow
          kind={kind}
          title={tc.kinds[kind]}
          subtitle={tc.linkedToCrmHelp}
          action={crmRecordId ? <OpenInCrmButton type={kind} id={crmRecordId} /> : null}
        />
      )}
    </div>
  );
}

type FillableField = 'email' | 'phone' | 'notes' | 'vatNumber' | 'registrationNumber';

/** What was already typed stays; a picked record only fills the gaps. */
function fillIfEmpty(form: ContactForm, field: FillableField, value: string | null | undefined): void {
  if (value && !form.getValues(field)?.trim()) form.setValue(field, value, { shouldDirty: true });
}

function fillAddressIfEmpty(form: ContactForm, address: unknown): void {
  const normalized = normalizeAccountingAddress(address);
  if (normalized && isPostalAddressEmpty(form.getValues('billingAddress'))) {
    form.setValue('billingAddress', toPostalAddressFormValue(normalized), { shouldDirty: true });
  }
}

/** The contact is this WeldCRM company: its details fill the form. */
function pickCompany(form: ContactForm, company: Company): void {
  form.setValue('crmLink', { id: company.id, name: company.displayName }, { shouldDirty: true });
  form.setValue('companyName', company.name, { shouldDirty: true, shouldValidate: true });
  form.setValue('invoiceName', company.displayName === company.name ? '' : company.displayName, { shouldDirty: true });
  fillIfEmpty(form, 'email', company.email);
  fillIfEmpty(form, 'phone', company.phone);
  fillIfEmpty(form, 'vatNumber', company.vatNumber);
  fillIfEmpty(form, 'registrationNumber', company.registrationNumber);
  fillIfEmpty(form, 'notes', company.notes);
  fillAddressIfEmpty(form, company.primaryAddress);
}

/** The contact is this WeldCRM person: their details fill the form. */
function pickPerson(form: ContactForm, person: Person): void {
  form.setValue('crmLink', { id: person.id, name: person.displayName }, { shouldDirty: true });
  form.setValue('firstName', person.firstName ?? '', { shouldDirty: true, shouldValidate: true });
  form.setValue('lastName', person.lastName ?? '', { shouldDirty: true });
  fillIfEmpty(form, 'email', person.email);
  fillIfEmpty(form, 'phone', person.directPhone || person.mobilePhone);
  fillIfEmpty(form, 'notes', person.notes);
  fillAddressIfEmpty(form, person.primaryAddress);
}

/** "New company …" / "New person …": not in WeldCRM yet, start from what was typed. */
function startNew(form: ContactForm, typed: string): void {
  form.setValue('crmLink', null);
  if (!typed) return;
  if (form.getValues('kind') === 'company') {
    form.setValue('companyName', typed, { shouldDirty: true, shouldValidate: true });
    return;
  }
  const names = splitName(typed);
  form.setValue('firstName', names.firstName, { shouldDirty: true, shouldValidate: true });
  form.setValue('lastName', names.lastName, { shouldDirty: true });
}

/** The WeldCRM record a new contact is: picked, or created on save. */
function CrmLinkField() {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const form = useFormContext<ContactFormValues>();
  const kind = form.watch('kind');
  const crmLink = form.watch('crmLink');

  if (crmLink) {
    return (
      <div className="sm:col-span-2">
        <CrmRecordRow
          kind={kind}
          title={crmLink.name}
          subtitle={`${tc.linkedToCrm} · ${tc.linkedToCrmHelp}`}
          action={
            <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={() => form.setValue('crmLink', null)}>
              <X className="h-3.5 w-3.5" />
              {tc.unlink}
            </Button>
          }
        />
      </div>
    );
  }

  const create = (typed: string) => startNew(form, typed);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-2">
      <p className="text-xs text-muted-foreground">{tc.newInCrm[kind]}</p>
      {kind === 'company' ? (
        <CrmCompanyPicker label={tc.findInCrm.company} onPick={(company) => pickCompany(form, company)} onCreate={create} />
      ) : (
        <CrmPersonPicker label={tc.findInCrm.person} onPick={(person) => pickPerson(form, person)} onCreate={create} />
      )}
    </div>
  );
}

function RoleField() {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const { labels } = useJurisdictionLabels();
  const form = useFormContext<ContactFormValues>();
  return (
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
  );
}

function CompanyNameFields() {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const form = useFormContext<ContactFormValues>();
  return (
    <>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="companyName">{tc.companyName} *</Label>
        <Input id="companyName" aria-describedby="companyName-help" {...form.register('companyName')} />
        <p id="companyName-help" className="text-xs text-muted-foreground">{tc.companyNameHelp}</p>
        <FieldError message={form.formState.errors.companyName?.message} />
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
  );
}

function PersonNameFields() {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const form = useFormContext<ContactFormValues>();
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="firstName">{tc.firstName}</Label>
        <Input id="firstName" autoComplete="off" {...form.register('firstName')} />
        <FieldError message={form.formState.errors.firstName?.message} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="lastName">{tc.lastName}</Label>
        <Input id="lastName" autoComplete="off" {...form.register('lastName')} />
      </div>
    </>
  );
}

export function GeneralCard({ choosesIdentity, crmRecordId }: Readonly<{ choosesIdentity: boolean; crmRecordId?: string | null }>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const form = useFormContext<ContactFormValues>();
  const isCompany = form.watch('kind') === 'company';
  return (
    <Card>
      <CardHeader>
        <CardTitle>{tc.general}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <KindField choosesIdentity={choosesIdentity} crmRecordId={crmRecordId} />
        {choosesIdentity ? <CrmLinkField /> : null}
        <RoleField />
        {isCompany ? <CompanyNameFields /> : <PersonNameFields />}
        <div className="space-y-2">
          <Label htmlFor="email">{tc.email}</Label>
          <Input id="email" type="email" autoComplete="off" {...form.register('email')} />
          <FieldError message={form.formState.errors.email?.message} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">{tc.phone}</Label>
          <Input id="phone" type="tel" autoComplete="off" {...form.register('phone')} />
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Contact person of a company: its billing contact in WeldCRM
// ---------------------------------------------------------------------------

function contactPersonFrom(person: Person): ContactFormValues['contactPerson'] {
  return {
    personId: person.id,
    linkedName: person.displayName,
    firstName: person.firstName ?? '',
    lastName: person.lastName ?? '',
    email: person.email ?? '',
    phone: person.directPhone || person.mobilePhone || '',
  };
}

function hasAnyContactPerson(contactPerson: ContactFormValues['contactPerson']): boolean {
  if (contactPerson.personId) return true;
  return [contactPerson.firstName, contactPerson.lastName, contactPerson.email, contactPerson.phone].some((v) => v?.trim());
}

/** `companyId`: the WeldCRM company, so the picker can list the people who work there first. */
export function ContactPersonCard({ companyId }: Readonly<{ companyId?: string | null }>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const form = useFormContext<ContactFormValues>();
  const contactPerson = form.watch('contactPerson');
  const set = (next: ContactFormValues['contactPerson']) => form.setValue('contactPerson', next, { shouldDirty: true });

  return (
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
            onPick={(person) => set(contactPersonFrom(person))}
            onCreate={(typed) => set({ ...EMPTY_CONTACT_PERSON, ...splitName(typed) })}
          />
          {hasAnyContactPerson(contactPerson) ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => set(EMPTY_CONTACT_PERSON)}>
              {tc.removeContactPerson}
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {contactPerson.personId ? (
          <CrmRecordRow
            kind="person"
            title={tc.contactPersonLinked.replace('{name}', contactPerson.linkedName)}
            subtitle={tc.linkedToCrm}
            action={<OpenInCrmButton type="person" id={contactPerson.personId} />}
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
            <FieldError message={form.formState.errors.contactPerson?.email?.message} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cp-phone">{tc.phone}</Label>
            <Input id="cp-phone" type="tel" autoComplete="off" {...form.register('contactPerson.phone')} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export function BillingAddressCard() {
  const { t } = useI18n();
  const form = useFormContext<ContactFormValues>();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.accounting.contacts.billingAddress}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Controller
          control={form.control}
          name="billingAddress"
          render={({ field }) => <AddressFields idPrefix="billing" value={field.value} onChange={field.onChange} />}
        />
      </CardContent>
    </Card>
  );
}

export function ShippingAddressCard() {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const form = useFormContext<ContactFormValues>();
  const sameAsBilling = form.watch('shippingSameAsBilling');

  const setSameAsBilling = (same: boolean) => {
    form.setValue('shippingSameAsBilling', same, { shouldDirty: true });
    // Start the separate address from the billing one rather than blank.
    if (!same && isPostalAddressEmpty(form.getValues('shippingAddress'))) {
      form.setValue('shippingAddress', { ...form.getValues('billingAddress') });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tc.shippingAddress}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center gap-2 text-sm" htmlFor="shippingSameAsBilling">
          <Checkbox
            id="shippingSameAsBilling"
            checked={sameAsBilling}
            onCheckedChange={(checked) => setSameAsBilling(checked === true)}
          />
          {tc.sameAsBilling}
        </label>
        {sameAsBilling ? null : (
          <Controller
            control={form.control}
            name="shippingAddress"
            render={({ field }) => <AddressFields idPrefix="shipping" value={field.value} onChange={field.onChange} />}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tax and registration, banking, payment, notes
// ---------------------------------------------------------------------------

/** How the tax and registration fields are shown for the contact being edited. */
export interface ContactIdFields {
  /** null: no tax number field (a person outside Brazil). */
  taxIdLabel: string | null;
  taxIdPlaceholder: string;
  /** null: no registration number field. */
  registrationLabel: string | null;
}

function TaxUseField() {
  const { t } = useI18n();
  const tvx = t.weldbooksUs.form1099.vendorTax;
  const form = useFormContext<ContactFormValues>();
  return (
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
  );
}

export function TaxRegistrationCard({ ids, showTaxUse }: Readonly<{ ids: ContactIdFields; showTaxUse: boolean }>) {
  const { t } = useI18n();
  const form = useFormContext<ContactFormValues>();
  const errors = form.formState.errors;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.accounting.contacts.taxAndRegistration}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {ids.taxIdLabel === null ? null : (
          <div className="space-y-2">
            <Label htmlFor="vatNumber">{ids.taxIdLabel}</Label>
            <Input
              id="vatNumber"
              placeholder={ids.taxIdPlaceholder}
              aria-invalid={Boolean(errors.vatNumber)}
              {...form.register('vatNumber')}
            />
            <FieldError message={errors.vatNumber?.message} />
          </div>
        )}
        {ids.registrationLabel === null ? null : (
          <div className="space-y-2">
            <Label htmlFor="registrationNumber">{ids.registrationLabel}</Label>
            <Input id="registrationNumber" aria-invalid={Boolean(errors.registrationNumber)} {...form.register('registrationNumber')} />
            <FieldError message={errors.registrationNumber?.message} />
          </div>
        )}
        {showTaxUse ? <TaxUseField /> : null}
      </CardContent>
    </Card>
  );
}

export function BankingCard() {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const form = useFormContext<ContactFormValues>();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{tc.bankingSection}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="iban">{tc.iban}</Label>
          <Input id="iban" aria-invalid={Boolean(form.formState.errors.iban)} {...form.register('iban')} />
          <FieldError message={form.formState.errors.iban?.message} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="bic">{tc.bic}</Label>
          <Input id="bic" {...form.register('bic')} />
        </div>
      </CardContent>
    </Card>
  );
}

export function PaymentCard() {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const form = useFormContext<ContactFormValues>();
  return (
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
          <FieldError message={form.formState.errors.paymentTermsDays?.message} />
        </div>
      </CardContent>
    </Card>
  );
}

export function NotesCard() {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const form = useFormContext<ContactFormValues>();
  return (
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
  );
}
