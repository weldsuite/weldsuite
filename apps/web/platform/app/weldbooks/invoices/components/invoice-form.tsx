import { useCallback, useEffect, useMemo, useTransition } from 'react';
import { useRouter } from '@/lib/router';
import { toast } from 'sonner';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Button } from '@weldsuite/ui/components/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  FileText,
  Plus,
  Trash2,
  Receipt,
  StickyNote,
  ListOrdered,
  MapPin,
} from 'lucide-react';
import {
  useCreateInvoice,
  useUpdateInvoice,
  useAccountingCustomer,
  useAccountingCustomers,
  useAccountingTaxRates,
} from '@/hooks/queries/use-accounting-queries';
import type { InvoiceDetail } from '@/lib/api/domains/weldbooks';
import {
  EntityFormLayout,
  type FormSection,
  type SummaryField,
} from '@/components/entity-overview';
import { toPostalAddressFormValue, type PostalAddress } from '@/components/address/postal-address';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import { addDaysToIsoDate, toCalendarDate } from '@/lib/weldbooks/format';
import { InvoiceAddressSection, invoiceAddressPayload } from './invoice-address-section';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Select value for "no tax"; never sent to the API (the line gets `taxRateId: null`). */
const NO_TAX = 'none';
const DEFAULT_PAYMENT_TERMS_DAYS = 30;

const addressSchema = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});

function createInvoiceFormSchema(st: (key: string) => string) {
  const lineItemSchema = z.object({
    description: z.string().min(1, st('sweep.weldbooks.invoiceDialog.descriptionRequired')),
    quantity: z.coerce.number().min(0, st('sweep.weldbooks.invoiceDialog.mustBeAtLeastZero')).default(1),
    unitPrice: z.coerce.number().min(0, st('sweep.weldbooks.invoiceDialog.mustBeAtLeastZero')).default(0),
    taxRateId: z.string().nullable().optional(),
    accountId: z.string().nullable().optional(),
    unit: z.string().optional().default(''),
    discountPercent: z.coerce.number().min(0).max(100).default(0),
  });

  return z.object({
    contactId: z.string().min(1, st('sweep.weldbooks.invoiceDialog.customerRequired')),
    issueDate: z.string().min(1, st('sweep.weldbooks.invoiceDialog.issueDateRequired')),
    dueDate: z.string().min(1, st('sweep.weldbooks.invoiceDialog.dueDateRequired')),
    reference: z.string().optional().default(''),
    notes: z.string().optional().default(''),
    internalNotes: z.string().optional().default(''),
    billingAddress: addressSchema,
    shipToDifferent: z.boolean(),
    shippingAddress: addressSchema,
    items: z.array(lineItemSchema).min(1, st('sweep.weldbooks.invoiceDialog.atLeastOneLineItem')),
  });
}

type InvoiceFormValues = z.infer<ReturnType<typeof createInvoiceFormSchema>>;

const emptyLine = {
  description: '',
  quantity: 1,
  unitPrice: 0,
  taxRateId: null,
  accountId: null,
  unit: '',
  discountPercent: 0,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface InvoiceFormProps {
  mode: 'add' | 'edit';
  invoice?: InvoiceDetail;
}

export function InvoiceForm({ mode, invoice }: Readonly<InvoiceFormProps>) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const { t } = useI18n();
  const st = useTranslations();
  const tf = t.accounting.invoiceForm;
  const invoiceFormSchema = useMemo(() => createInvoiceFormSchema(st), [st]);
  const { currency, entityCurrency, formatMoney, formatDate, today } = useWeldbooksFormat();
  const { labels } = useJurisdictionLabels();
  const displayCurrency = invoice?.currency || currency;

  const createMutation = useCreateInvoice();
  const updateMutation = useUpdateInvoice();

  // Invoices only go to customers — exclude suppliers. Backend expands
  // role=customer to include "both"-role contacts, so dual-role parties qualify.
  const { data: contactsData } = useAccountingCustomers({ role: 'customer' });
  const { data: taxRatesData } = useAccountingTaxRates();

  const contacts = useMemo(() => contactsData?.data ?? [], [contactsData]);
  const taxRates = useMemo(() => taxRatesData?.data ?? [], [taxRatesData]);

  // Build default values
  const defaultValues: InvoiceFormValues = useMemo(() => {
    const issueDate = today();
    if (mode === 'edit' && invoice) {
      const billing = normalizeAccountingAddress(invoice.billingAddress);
      const shipping = normalizeAccountingAddress(invoice.shippingAddress);
      return {
        contactId: invoice.contactId ?? '',
        issueDate: toCalendarDate(invoice.issueDate) ?? issueDate,
        dueDate: toCalendarDate(invoice.dueDate) ?? addDaysToIsoDate(issueDate, DEFAULT_PAYMENT_TERMS_DAYS),
        reference: invoice.reference ?? '',
        notes: invoice.notes ?? '',
        internalNotes: invoice.internalNotes ?? '',
        billingAddress: toPostalAddressFormValue(billing),
        shipToDifferent: !!shipping,
        shippingAddress: toPostalAddressFormValue(shipping),
        items:
          invoice.items && invoice.items.length > 0
            ? invoice.items.map((item) => ({
                description: item.description ?? '',
                quantity: Number.parseFloat(item.quantity ?? '1') || 1,
                unitPrice: Number.parseFloat(item.unitPrice) || 0,
                taxRateId: item.taxRateId ?? null,
                accountId: item.accountId ?? null,
                unit: item.unit ?? '',
                discountPercent: Number.parseFloat(item.discountPercent ?? '0') || 0,
              }))
            : [{ ...emptyLine }],
      };
    }
    return {
      contactId: '',
      issueDate,
      dueDate: addDaysToIsoDate(issueDate, DEFAULT_PAYMENT_TERMS_DAYS),
      reference: '',
      notes: '',
      internalNotes: '',
      billingAddress: toPostalAddressFormValue(null),
      shipToDifferent: false,
      shippingAddress: toPostalAddressFormValue(null),
      items: [{ ...emptyLine }],
    };
  }, [mode, invoice, today]);

  const form = useForm({
    resolver: zodResolver(invoiceFormSchema),
    defaultValues,
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'items',
  });

  const watchedItems = form.watch('items');
  const watchedContactId = form.watch('contactId');

  // New invoice: the due date follows the customer's payment terms until the
  // user picks one by hand.
  const { data: selectedContactData } = useAccountingCustomer(mode === 'add' ? watchedContactId : '');
  const selectedTerms = selectedContactData?.data?.paymentTermsDays;
  useEffect(() => {
    if (mode !== 'add' || selectedTerms == null || form.getFieldState('dueDate').isDirty) return;
    form.setValue('dueDate', addDaysToIsoDate(form.getValues('issueDate'), selectedTerms));
  }, [mode, selectedTerms, form]);

  const setBillingAddress = useCallback(
    (next: PostalAddress) => form.setValue('billingAddress', toPostalAddressFormValue(next), { shouldDirty: true }),
    [form],
  );
  const setShippingAddress = useCallback(
    (next: PostalAddress) => form.setValue('shippingAddress', toPostalAddressFormValue(next), { shouldDirty: true }),
    [form],
  );
  const setShipToDifferent = useCallback(
    (next: boolean) => form.setValue('shipToDifferent', next, { shouldDirty: true }),
    [form],
  );

  // ---------------------------------------------------------------------------
  // Calculations (preview only — the server computes the authoritative totals)
  // ---------------------------------------------------------------------------

  const taxRateMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const tr of taxRates) {
      map[tr.id] = Number.parseFloat(tr.rate ?? '0');
    }
    return map;
  }, [taxRates]);

  const lineCalculations = useMemo(() => {
    return (watchedItems ?? []).map((item) => {
      const qty = Number(item.quantity) || 0;
      const price = Number(item.unitPrice) || 0;
      const discount = Number(item.discountPercent) || 0;
      const subtotal = qty * price * (1 - discount / 100);
      const rate = item.taxRateId ? (taxRateMap[item.taxRateId] ?? 0) : 0;
      const tax = subtotal * (rate / 100);
      return { subtotal, tax, total: subtotal + tax };
    });
  }, [watchedItems, taxRateMap]);

  const totals = useMemo(() => {
    let subtotal = 0;
    let taxTotal = 0;
    for (const lc of lineCalculations) {
      subtotal += lc.subtotal;
      taxTotal += lc.tax;
    }
    return { subtotal, taxTotal, total: subtotal + taxTotal };
  }, [lineCalculations]);

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  const onSubmit = (values: InvoiceFormValues) => {
    startTransition(async () => {
      try {
        const payload: Record<string, unknown> = {
          contactId: values.contactId,
          issueDate: values.issueDate,
          dueDate: values.dueDate,
          reference: values.reference || undefined,
          notes: values.notes || undefined,
          internalNotes: values.internalNotes || undefined,
          ...invoiceAddressPayload(values, mode),
          items: values.items.map((item) => ({
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            // "No tax" is null — the API rejects placeholder ids such as 'none'.
            taxRateId: item.taxRateId && item.taxRateId !== NO_TAX ? item.taxRateId : null,
            accountId: item.accountId || undefined,
            unit: item.unit || undefined,
            discountPercent: item.discountPercent || undefined,
          })),
        };
        if (mode === 'edit' && invoice?.currency) {
          payload.currency = invoice.currency;
        } else if (entityCurrency) {
          payload.currency = entityCurrency;
        }

        if (mode === 'edit' && invoice) {
          await updateMutation.mutateAsync({ id: invoice.id, data: payload });
          toast.success(tf.invoiceUpdated);
        } else {
          await createMutation.mutateAsync(payload);
          toast.success(tf.invoiceCreated);
        }

        setTimeout(() => {
          router.push('/weldbooks/invoices');
        }, 500);
      } catch (error) {
        toast.error(tf.failedToSave, {
          description: error instanceof Error ? error.message : undefined,
        });
      }
    });
  };

  // ---------------------------------------------------------------------------
  // Selected contact label
  // ---------------------------------------------------------------------------

  const selectedContact = contacts.find((c) => c.id === watchedContactId);
  const contactLabel = selectedContact?.name ?? selectedContact?.email ?? '';

  // ---------------------------------------------------------------------------
  // Sections
  // ---------------------------------------------------------------------------

  const sections: FormSection[] = [
    {
      title: tf.basicInformation,
      icon: FileText,
      content: (
        <>
          <div className="space-y-2">
            <Label htmlFor="contactId">{tf.customer}</Label>
            <Select
              value={form.watch('contactId')}
              onValueChange={(val) => form.setValue('contactId', val, { shouldValidate: true })}
            >
              <SelectTrigger id="contactId" className="shadow-none">
                <SelectValue placeholder={tf.selectCustomer} />
              </SelectTrigger>
              <SelectContent>
                {contacts.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name || c.email || c.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.contactId && (
              <p className="text-sm text-destructive">{form.formState.errors.contactId.message}</p>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="issueDate">{tf.issueDate}</Label>
              <Input
                id="issueDate"
                type="date"
                className="shadow-none"
                {...form.register('issueDate')}
              />
              {form.formState.errors.issueDate && (
                <p className="text-sm text-destructive">{form.formState.errors.issueDate.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="dueDate">{tf.dueDate}</Label>
              <Input
                id="dueDate"
                type="date"
                className="shadow-none"
                {...form.register('dueDate')}
              />
              {form.formState.errors.dueDate && (
                <p className="text-sm text-destructive">{form.formState.errors.dueDate.message}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="reference">{tf.reference}</Label>
            <Input
              id="reference"
              placeholder={tf.referencePlaceholder}
              className="shadow-none"
              {...form.register('reference')}
            />
          </div>
        </>
      ),
    },
    {
      title: t.accounting.invoiceAddresses.title,
      icon: MapPin,
      content: (
        <InvoiceAddressSection
          contactId={watchedContactId}
          initialContactId={mode === 'edit' ? invoice?.contactId : null}
          billingAddress={form.watch('billingAddress')}
          shippingAddress={form.watch('shippingAddress')}
          shipToDifferent={form.watch('shipToDifferent')}
          onBillingAddressChange={setBillingAddress}
          onShippingAddressChange={setShippingAddress}
          onShipToDifferentChange={setShipToDifferent}
        />
      ),
    },
    {
      title: tf.lineItems,
      icon: ListOrdered,
      content: (
        <>
          {fields.map((field, index) => {
            const id = (name: string) => `items-${index}-${name}`;
            return (
              <div key={field.id} className="rounded-md border border-border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">
                    {tf.itemNumber.replace('{number}', String(index + 1))}
                  </span>
                  {fields.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      aria-label={tf.itemNumber.replace('{number}', String(index + 1))}
                      onClick={() => remove(index)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor={id('description')}>{tf.description}</Label>
                  <Input
                    id={id('description')}
                    placeholder={tf.itemDescriptionPlaceholder}
                    className="shadow-none"
                    {...form.register(`items.${index}.description`)}
                  />
                  {form.formState.errors.items?.[index]?.description && (
                    <p className="text-sm text-destructive">
                      {form.formState.errors.items[index].description?.message}
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor={id('quantity')}>{tf.quantity}</Label>
                    <Input
                      id={id('quantity')}
                      type="number"
                      step="any"
                      min="0"
                      className="shadow-none"
                      {...form.register(`items.${index}.quantity`, { valueAsNumber: true })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={id('unitPrice')}>{tf.unitPrice}</Label>
                    <Input
                      id={id('unitPrice')}
                      type="number"
                      step="0.01"
                      min="0"
                      className="shadow-none"
                      {...form.register(`items.${index}.unitPrice`, { valueAsNumber: true })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={id('taxRate')}>{labels.taxRate}</Label>
                    <Select
                      value={form.watch(`items.${index}.taxRateId`) ?? NO_TAX}
                      onValueChange={(val) =>
                        form.setValue(`items.${index}.taxRateId`, val === NO_TAX ? null : val, {
                          shouldValidate: true,
                        })
                      }
                    >
                      <SelectTrigger id={id('taxRate')} className="shadow-none">
                        <SelectValue placeholder={labels.noTax} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_TAX}>{labels.noTax}</SelectItem>
                        {taxRates.map((tr) => (
                          <SelectItem key={tr.id} value={tr.id}>
                            {tr.name ?? `${Number(tr.rate)}%`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={id('discountPercent')}>{tf.discountPercent}</Label>
                    <Input
                      id={id('discountPercent')}
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      className="shadow-none"
                      {...form.register(`items.${index}.discountPercent`, { valueAsNumber: true })}
                    />
                  </div>
                </div>

                <div className="flex justify-end text-sm text-muted-foreground">
                  {tf.lineTotal}{' '}
                  <span className="ml-1 font-medium text-foreground">
                    {formatMoney(lineCalculations[index]?.total ?? 0, displayCurrency)}
                  </span>
                </div>
              </div>
            );
          })}

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shadow-none"
            onClick={() => append({ ...emptyLine })}
          >
            <Plus className="h-4 w-4 mr-1" />
            {tf.addItem}
          </Button>

          {form.formState.errors.items?.root && (
            <p className="text-sm text-destructive">{form.formState.errors.items.root.message}</p>
          )}
        </>
      ),
    },
    {
      title: tf.notes,
      icon: StickyNote,
      content: (
        <>
          <div className="space-y-2">
            <Label htmlFor="notes">{tf.notesLabel}</Label>
            <Textarea
              id="notes"
              placeholder={tf.notesPlaceholder}
              rows={3}
              className="shadow-none"
              {...form.register('notes')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="internalNotes">{tf.internalNotes}</Label>
            <Textarea
              id="internalNotes"
              placeholder={tf.internalNotesPlaceholder}
              rows={3}
              className="shadow-none"
              {...form.register('internalNotes')}
            />
          </div>
        </>
      ),
    },
  ];

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  const itemCount = fields.length;
  const summaryFields: SummaryField[] = [
    { label: tf.customer, value: contactLabel || undefined },
    { label: tf.issueDate, value: form.watch('issueDate') ? formatDate(form.watch('issueDate')) : undefined },
    { label: tf.dueDate, value: form.watch('dueDate') ? formatDate(form.watch('dueDate')) : undefined },
    { label: tf.reference, value: form.watch('reference') || undefined, hideIfEmpty: true },
    {
      label: tf.lineItems,
      value: itemCount === 1
        ? tf.items.replace('{count}', String(itemCount))
        : tf.itemsPlural.replace('{count}', String(itemCount)),
    },
    { label: tf.subtotal, value: formatMoney(totals.subtotal, displayCurrency), bordered: true },
    { label: labels.tax, value: formatMoney(totals.taxTotal, displayCurrency) },
    { label: tf.total, value: <span className="font-semibold">{formatMoney(totals.total, displayCurrency)}</span> },
  ];

  return (
    <EntityFormLayout
      title={mode === 'add' ? tf.newInvoice : tf.editInvoice}
      sections={sections}
      summaryTitle={tf.invoiceSummary}
      summaryIcon={Receipt}
      summaryFields={summaryFields}
      summaryContent={<p className="text-xs text-muted-foreground">{tf.totalsPreview}</p>}
      onSubmit={form.handleSubmit(onSubmit)}
      isPending={isPending}
      submitText={mode === 'add' ? tf.createInvoice : tf.updateInvoice}
      cancelLink="/weldbooks/invoices"
      showBackButton
      backLink="/weldbooks/invoices"
      backButtonText={tf.backToInvoices}
    />
  );
}
