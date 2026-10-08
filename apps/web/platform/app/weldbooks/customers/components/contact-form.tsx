import { useMemo } from 'react';
import { Controller, FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
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
import type { Customer } from '@/lib/api/domains/weldbooks';
import type { VendorTaxPayload, VendorTaxView } from '@/lib/api/domains/weldbooks-1099';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { useI18n } from '@/lib/i18n/provider';
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
});

function createContactSchema(st: (key: string) => string, vendorTaxMessages: Record<VendorTaxProblem, string>) {
  return z.object({
    vendorTax: createVendorTaxSchema(vendorTaxMessages),
    role: z.enum(['customer', 'supplier', 'both']),
    name: z.string().trim().min(1, st('sweep.weldbooks.contactForm.nameRequired')),
    companyName: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    email: z.string().trim().email(st('sweep.weldbooks.contactForm.invalidEmail')).optional().or(z.literal('')),
    phone: z.string().optional(),
    vatNumber: z.string().optional(),
    registrationNumber: z.string().optional(),
    iban: z.string().optional(),
    bic: z.string().optional(),
    paymentTermsDays: z.coerce.number().int().min(0).optional(),
    notes: z.string().optional(),
    billingAddress: addressSchema,
    shippingSameAsBilling: z.boolean(),
    shippingAddress: addressSchema,
  });
}

export type ContactFormValues = z.infer<ReturnType<typeof createContactSchema>>;

/**
 * The accounting-contacts create/update body (see books-api `/api/accounting-contacts`).
 * The vendor tax fields are present for a US entity only; `tin` and
 * `achAccountNumber` appear only when typed.
 */
export interface ContactPayload extends VendorTaxPayload {
  role: ContactFormValues['role'];
  name: string;
  companyName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  vatNumber?: string;
  registrationNumber?: string;
  iban?: string;
  bic?: string;
  paymentTermsDays?: number;
  notes?: string;
  billingAddress?: PostalAddress;
  shippingAddress?: PostalAddress;
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

function initialValues(contact: ContactFormContact | undefined, defaultCountry: string | null): ContactFormValues {
  const billing = normalizeAccountingAddress(contact?.billingAddress);
  const shipping = normalizeAccountingAddress(contact?.shippingAddress);
  const role = contact?.role === 'supplier' || contact?.role === 'both' ? contact.role : 'customer';
  return {
    vendorTax: initialVendorTaxValues(contact),
    role,
    name: contact?.name ?? '',
    companyName: contact?.companyName ?? '',
    firstName: contact?.firstName ?? '',
    lastName: contact?.lastName ?? '',
    email: contact?.email ?? '',
    phone: contact?.phone ?? '',
    vatNumber: contact?.vatNumber ?? '',
    registrationNumber: contact?.registrationNumber ?? '',
    iban: contact?.iban ?? '',
    bic: contact?.bic ?? '',
    paymentTermsDays: contact?.paymentTermsDays ?? 30,
    notes: contact?.notes ?? '',
    billingAddress: toPostalAddressFormValue(
      billing ?? (contact ? null : { country: defaultCountry ?? '' }),
    ),
    shippingSameAsBilling: !shipping || sameAddress(billing, shipping),
    shippingAddress: toPostalAddressFormValue(shipping),
  };
}

interface ContactFormProps {
  mode: 'add' | 'edit';
  contact?: ContactFormContact;
  isPending: boolean;
  onSubmit: (payload: ContactPayload) => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Shared create/edit form for accounting contacts (customers and suppliers).
 * Tax-ID and registration labels follow the selected entity's jurisdiction
 * (VAT number / GSTIN / EIN, KvK / PAN / …).
 */
export function ContactForm({ mode, contact, isPending, onSubmit, onCancel }: Readonly<ContactFormProps>) {
  const { t } = useI18n();
  const st = useTranslations();
  const tc = t.accounting.contacts;
  const submitLabel = mode === 'add' ? tc.createContact : tc.saveChanges;
  const pendingLabel = mode === 'add' ? tc.creating : tc.saving;
  const { labels, code: jurisdictionCode, usesIban, features } = useJurisdictionLabels();
  const tvx = t.weldbooksUs.form1099.vendorTax;
  const schema = useMemo(() => createContactSchema(st, tvx.errors), [st, tvx.errors]);

  const defaults = useMemo(
    () => initialValues(contact, jurisdictionCode),
    [contact, jurisdictionCode],
  );

  const form = useForm<ContactFormValues>({
    resolver: zodResolver(schema),
    values: defaults,
    resetOptions: { keepDirtyValues: true },
  });

  const sameAsBilling = form.watch('shippingSameAsBilling');
  const role = form.watch('role');
  const showBanking = usesIban || !!contact?.iban || !!contact?.bic;
  // US-only sections: gated on the jurisdiction's features, never on a country code.
  const isVendor = role === 'supplier' || role === 'both';
  const isCustomer = role === 'customer' || role === 'both';
  const scope = {
    tax: features.form1099 && isVendor,
    bank: features.form1099 && isVendor,
    taxUse: features.salesTax && isCustomer,
  };

  const submit = async (values: ContactFormValues) => {
    const billing = cleanPostalAddress(values.billingAddress);
    const shipping = values.shippingSameAsBilling ? billing : cleanPostalAddress(values.shippingAddress);
    // On edit an emptied address is sent as {} so the stored one is cleared.
    const emptyAddress = mode === 'edit' ? {} : undefined;
    await onSubmit({
      ...buildVendorTaxPayload(values.vendorTax, contact, scope),
      role: values.role,
      name: values.name.trim(),
      companyName: optional(values.companyName),
      firstName: optional(values.firstName),
      lastName: optional(values.lastName),
      email: optional(values.email),
      phone: optional(values.phone),
      vatNumber: optional(values.vatNumber),
      registrationNumber: optional(values.registrationNumber),
      iban: optional(values.iban),
      bic: optional(values.bic),
      paymentTermsDays: values.paymentTermsDays,
      notes: optional(values.notes),
      billingAddress: billing ?? emptyAddress,
      shippingAddress: shipping ?? emptyAddress,
    });
  };

  /** Fill "Name on invoices" from the company or person name while it is still empty. */
  const suggestName = () => {
    if (form.getValues('name').trim()) return;
    const company = form.getValues('companyName')?.trim();
    const person = [form.getValues('firstName'), form.getValues('lastName')]
      .map((v) => v?.trim())
      .filter(Boolean)
      .join(' ');
    const suggestion = company || person;
    if (suggestion) form.setValue('name', suggestion, { shouldValidate: true, shouldDirty: true });
  };

  const errors = form.formState.errors;

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(submit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>{tc.general}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                      <SelectItem value="both">{tc.roles.both}</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="name">{tc.nameOnInvoice} *</Label>
              <Input id="name" aria-describedby="name-help" {...form.register('name')} />
              <p id="name-help" className="text-xs text-muted-foreground">{tc.nameOnInvoiceHelp}</p>
              {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="companyName">{tc.companyName}</Label>
              <Input
                id="companyName"
                aria-describedby="companyName-help"
                {...form.register('companyName', { onBlur: suggestName })}
              />
              <p id="companyName-help" className="text-xs text-muted-foreground">{tc.companyNameHelp}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tc.contactPerson}</CardTitle>
            <CardDescription>{tc.contactPersonHelp}</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="firstName">{tc.firstName}</Label>
              <Input id="firstName" {...form.register('firstName')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lastName">{tc.lastName}</Label>
              <Input id="lastName" {...form.register('lastName', { onBlur: suggestName })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">{tc.email}</Label>
              <Input id="email" type="email" autoComplete="email" {...form.register('email')} />
              {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone">{tc.phone}</Label>
              <Input id="phone" type="tel" autoComplete="tel" {...form.register('phone')} />
            </div>
          </CardContent>
        </Card>

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

        <Card>
          <CardHeader>
            <CardTitle>{tc.taxAndRegistration}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="vatNumber">{labels.taxId}</Label>
              <Input id="vatNumber" placeholder={tc.taxIdPlaceholder} {...form.register('vatNumber')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="registrationNumber">{labels.registrationId}</Label>
              <Input id="registrationNumber" {...form.register('registrationNumber')} />
            </div>
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

        {scope.tax ? <VendorTaxSection contact={contact} /> : null}

        {showBanking && (
          <Card>
            <CardHeader>
              <CardTitle>{tc.bankingSection}</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="iban">{tc.iban}</Label>
                <Input id="iban" {...form.register('iban')} />
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
