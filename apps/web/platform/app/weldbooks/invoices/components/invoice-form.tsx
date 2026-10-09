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
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
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
  Landmark,
} from 'lucide-react';
import {
  useCreateInvoice,
  useUpdateInvoice,
  useAccountingCustomer,
  useAccountingCustomers,
  useAccountingTaxRates,
} from '@/hooks/queries/use-accounting-queries';
import type { InvoiceDetail } from '@/lib/api/domains/weldbooks';
import type { InvoiceWithTax, TaxDocumentKind, TaxUse } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import {
  EntityFormLayout,
  type FormSection,
  type SummaryField,
} from '@/components/entity-overview';
import { toPostalAddressFormValue, type PostalAddress } from '@/components/address/postal-address';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import { addDaysToIsoDate, toCalendarDate } from '@/lib/weldbooks/format';
import {
  EMPTY_SALES_TAX_LINE,
  overrideChecks,
  salesTaxLineFields,
  toTaxFormLine,
  type SalesTaxLineValues,
} from '@/lib/weldbooks/document-tax-form';
import { NO_TAX_RATE } from '@/lib/weldbooks/document-tax';
import { productTaxCode } from '@/lib/weldbooks/tax-codes';
import type { ProductOption } from '@/hooks/queries/use-weldbooks-tax-preview';
import { InvoiceAddressSection } from './invoice-address-section';
import { AddressNeededNotice, DocumentTaxPanel } from './document-tax-panel';
import { InvoiceLineExtras } from './invoice-line-extras';
import { buildInvoicePayload } from './invoice-payload';
import { ProductPicker } from './product-picker';
import { useDescribeError } from './sales-tax-error-notice';
import { ShipFromSection } from './ship-from-section';
import { useDocumentTaxPreview } from './use-document-tax-preview';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const DEFAULT_PAYMENT_TERMS_DAYS = 30;

const addressSchema = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});

function createInvoiceFormSchema(
  st: (key: string) => string,
  overrideMessages: { reasonRequired: string; amountInvalid: string },
) {
  const lineItemSchema = z
    .object({
      description: z.string().min(1, st('sweep.weldbooks.invoiceDialog.descriptionRequired')),
      quantity: z.coerce.number().min(0, st('sweep.weldbooks.invoiceDialog.mustBeAtLeastZero')).default(1),
      unitPrice: z.coerce.number().min(0, st('sweep.weldbooks.invoiceDialog.mustBeAtLeastZero')).default(0),
      taxRateId: z.string().nullable().optional(),
      accountId: z.string().nullable().optional(),
      unit: z.string().optional().default(''),
      discountPercent: z.coerce.number().min(0).max(100).default(0),
      ...salesTaxLineFields,
    })
    .superRefine(overrideChecks(overrideMessages));

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
    shipFromDifferent: z.boolean().default(false),
    shipFromAddress: addressSchema,
    marketplaceFacilitated: z.boolean().default(false),
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
  ...EMPTY_SALES_TAX_LINE,
};

/** The kind of document an invoice row is, for the tax calculation. */
function documentKind(invoice: Pick<InvoiceDetail, 'type'> | undefined): TaxDocumentKind {
  if (invoice?.type === 'credit_note') return 'credit_memo';
  if (invoice?.type === 'proforma') return 'estimate';
  return 'invoice';
}

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
  const td = useDocumentTexts();
  const invoiceFormSchema = useMemo(
    () =>
      createInvoiceFormSchema(st, {
        reasonRequired: td.line.overrideReasonRequired,
        amountInvalid: td.line.overrideAmountInvalid,
      }),
    [st, td.line.overrideReasonRequired, td.line.overrideAmountInvalid],
  );
  const { currency, entityCurrency, formatMoney, formatDate, today, entity } = useWeldbooksFormat();
  const { labels } = useJurisdictionLabels();
  const displayCurrency = invoice?.currency || currency;
  const describeError = useDescribeError();

  const createMutation = useCreateInvoice();
  const updateMutation = useUpdateInvoice();

  // Invoices only go to customers — exclude suppliers. Backend expands
  // role=customer to include "both"-role contacts, so dual-role parties qualify.
  const { data: contactsData } = useAccountingCustomers({ role: 'customer' });
  const { data: taxRatesData } = useAccountingTaxRates();

  const contacts = useMemo(() => contactsData?.data ?? [], [contactsData]);
  const taxRates = useMemo(() => taxRatesData?.data ?? [], [taxRatesData]);

  const stored = invoice as unknown as InvoiceWithTax | undefined;
  const kind = documentKind(invoice);
  const isCreditMemo = kind === 'credit_memo';

  // Build default values
  const defaultValues = useMemo(() => {
    const issueDate = today();
    if (mode === 'edit' && stored) {
      const billing = normalizeAccountingAddress(stored.billingAddress);
      const shipping = normalizeAccountingAddress(stored.shippingAddress);
      const shipFrom = normalizeAccountingAddress(stored.shipFromAddress);
      return {
        contactId: stored.contactId ?? '',
        issueDate: toCalendarDate(stored.issueDate) ?? issueDate,
        dueDate: toCalendarDate(stored.dueDate) ?? addDaysToIsoDate(issueDate, DEFAULT_PAYMENT_TERMS_DAYS),
        reference: stored.reference ?? '',
        notes: stored.notes ?? '',
        internalNotes: stored.internalNotes ?? '',
        billingAddress: toPostalAddressFormValue(billing),
        shipToDifferent: !!shipping,
        shippingAddress: toPostalAddressFormValue(shipping),
        shipFromDifferent: !!shipFrom,
        shipFromAddress: toPostalAddressFormValue(shipFrom),
        marketplaceFacilitated: Boolean(stored.marketplaceFacilitated),
        items:
          stored.items && stored.items.length > 0
            ? stored.items.map((item) => ({
                description: item.description ?? '',
                quantity: Number.parseFloat(item.quantity ?? '1') || 1,
                unitPrice: Number.parseFloat(item.unitPrice) || 0,
                taxRateId: item.taxRateId ?? null,
                accountId: item.accountId ?? null,
                unit: item.unit ?? '',
                discountPercent: Number.parseFloat(item.discountPercent ?? '0') || 0,
                productId: item.productId ?? '',
                taxCode: item.taxCode ?? '',
                taxUse: (item.taxUse ?? '') as '' | TaxUse,
                taxIncluded: Boolean(item.taxIncluded),
                taxOverrideEnabled: item.taxOverrideAmount !== null && item.taxOverrideAmount !== undefined,
                taxOverrideAmount: item.taxOverrideAmount ?? '',
                taxOverrideReason: item.taxOverrideReason ?? '',
                classId: item.classId ?? '',
                locationId: item.locationId ?? '',
                originalLineId: item.originalLineId ?? '',
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
      shipFromDifferent: false,
      shipFromAddress: toPostalAddressFormValue(null),
      marketplaceFacilitated: false,
      items: [{ ...emptyLine }],
    };
  }, [mode, stored, today]);

  const form = useForm({
    resolver: zodResolver(invoiceFormSchema),
    defaultValues,
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'items',
  });

  const watched = form.watch();
  const watchedItems = watched.items;
  const watchedContactId = watched.contactId;

  // The due date follows the customer's payment terms until the user picks
  // one by hand (new invoices). The customer's default use feeds the lines.
  const { data: selectedContactData } = useAccountingCustomer(watchedContactId);
  const selectedTerms = selectedContactData?.data?.paymentTermsDays;
  const customerUse = (selectedContactData?.data as { taxUse?: TaxUse | null } | undefined)?.taxUse ?? null;
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
  // Tax: what the server calculates for the form's state (nothing is computed here)
  // ---------------------------------------------------------------------------

  const { salesTax, preview, totals, lineTax } = useDocumentTaxPreview({
    kind,
    contactId: watchedContactId,
    issueDate: watched.issueDate,
    currency: invoice?.currency || entityCurrency,
    billingAddress: watched.billingAddress,
    shipToDifferent: watched.shipToDifferent,
    shippingAddress: watched.shippingAddress,
    shipFromDifferent: watched.shipFromDifferent,
    shipFromAddress: watched.shipFromAddress,
    marketplaceFacilitated: watched.marketplaceFacilitated,
    originalInvoiceId: stored?.creditNoteForInvoiceId,
    lines: (watchedItems ?? []).map(toTaxFormLine),
  });

  const setLine = (index: number, patch: Partial<SalesTaxLineValues>) => {
    const current = form.getValues(`items.${index}`);
    form.setValue(`items.${index}`, { ...current, ...patch }, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  };

  const selectProduct = (index: number, product: ProductOption | null) => {
    if (!product) {
      setLine(index, { productId: '' });
      return;
    }
    const current = form.getValues(`items.${index}`);
    form.setValue(
      `items.${index}`,
      {
        ...current,
        productId: product.id,
        // The product's tax class gives the line its tax code; the user can still change it.
        taxCode: productTaxCode(product) ?? '',
        description: current.description || product.name,
        unitPrice: Number(current.unitPrice) > 0 || !product.price ? current.unitPrice : product.price,
      },
      { shouldDirty: true },
    );
  };

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  const onSubmit = (values: InvoiceFormValues) => {
    startTransition(async () => {
      try {
        const payload = buildInvoicePayload(values, {
          mode,
          kind,
          salesTax,
          currency: mode === 'edit' && invoice?.currency ? invoice.currency : entityCurrency,
        });

        if (mode === 'edit' && invoice) {
          await updateMutation.mutateAsync({ id: invoice.id, data: payload });
          toast.success(isCreditMemo ? td.form.creditMemoUpdated : tf.invoiceUpdated);
        } else {
          await createMutation.mutateAsync(payload);
          toast.success(tf.invoiceCreated);
        }

        setTimeout(() => {
          router.push(isCreditMemo && invoice ? `/weldbooks/invoices/${invoice.id}` : '/weldbooks/invoices');
        }, 500);
      } catch (error) {
        toast.error(tf.failedToSave, { description: describeError(error) });
      }
    });
  };

  // ---------------------------------------------------------------------------
  // Selected contact label
  // ---------------------------------------------------------------------------

  const selectedContact = contacts.find((c) => c.id === watchedContactId);
  const contactLabel = selectedContact?.name ?? selectedContact?.email ?? '';

  const entityAddress = normalizeAccountingAddress(entity?.address);
  const lineErrors = form.formState.errors.items;

  // ---------------------------------------------------------------------------
  // Sections
  // ---------------------------------------------------------------------------

  const sections: FormSection[] = [
    {
      title: tf.basicInformation,
      icon: FileText,
      content: (
        <>
          {isCreditMemo && <InfoBanner variant="info">{td.form.creditMemoNote}</InfoBanner>}
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
          notice={salesTax && preview.result?.addressIncomplete ? <AddressNeededNotice /> : null}
        />
      ),
    },
    ...(salesTax && !isCreditMemo
      ? [
          {
            title: td.shipFrom.title,
            icon: Landmark,
            content: (
              <ShipFromSection
                entityAddress={entityAddress}
                shipFromDifferent={Boolean(form.watch('shipFromDifferent'))}
                shipFromAddress={form.watch('shipFromAddress')}
                onShipFromDifferentChange={(next) => form.setValue('shipFromDifferent', next, { shouldDirty: true })}
                onShipFromAddressChange={(next) =>
                  form.setValue('shipFromAddress', toPostalAddressFormValue(next), { shouldDirty: true })
                }
                marketplace={{
                  value: Boolean(form.watch('marketplaceFacilitated')),
                  onChange: (next) => form.setValue('marketplaceFacilitated', next, { shouldDirty: true }),
                }}
              />
            ),
          },
        ]
      : []),
    {
      title: tf.lineItems,
      icon: ListOrdered,
      content: (
        <>
          {fields.map((field, index) => {
            const id = (name: string) => `items-${index}-${name}`;
            const line = watchedItems?.[index];
            const calculated = lineTax(index);
            const errors = lineErrors?.[index];
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

                {salesTax && !isCreditMemo && (
                  <ProductPicker
                    id={id('product')}
                    value={line?.productId ?? ''}
                    selectedLabel={line?.description}
                    onSelect={(product) => selectProduct(index, product)}
                  />
                )}

                <div className="space-y-2">
                  <Label htmlFor={id('description')}>{tf.description}</Label>
                  <Input
                    id={id('description')}
                    placeholder={tf.itemDescriptionPlaceholder}
                    className="shadow-none"
                    {...form.register(`items.${index}.description`)}
                  />
                  {errors?.description && (
                    <p className="text-sm text-destructive">{errors.description.message}</p>
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
                  {!salesTax && (
                    <div className="space-y-2">
                      <Label htmlFor={id('taxRate')}>{labels.taxRate}</Label>
                      <Select
                        value={form.watch(`items.${index}.taxRateId`) ?? NO_TAX_RATE}
                        onValueChange={(val) =>
                          form.setValue(`items.${index}.taxRateId`, val === NO_TAX_RATE ? null : val, {
                            shouldValidate: true,
                          })
                        }
                      >
                        <SelectTrigger id={id('taxRate')} className="shadow-none">
                          <SelectValue placeholder={labels.noTax} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_TAX_RATE}>{labels.noTax}</SelectItem>
                          {taxRates.map((tr) => (
                            <SelectItem key={tr.id} value={tr.id}>
                              {tr.name ?? `${Number(tr.rate)}%`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
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

                {line && (
                  <InvoiceLineExtras
                    idPrefix={`items-${index}`}
                    salesTax={salesTax}
                    mode={isCreditMemo ? 'creditMemo' : 'invoice'}
                    value={line as SalesTaxLineValues}
                    onChange={(patch) => setLine(index, patch)}
                    customerUse={customerUse}
                    tax={calculated ? { amount: calculated.taxAmount, rate: calculated.taxRate } : null}
                    currency={displayCurrency}
                    errors={{
                      taxOverrideAmount: errors?.taxOverrideAmount?.message,
                      taxOverrideReason: errors?.taxOverrideReason?.message,
                    }}
                  />
                )}

                <div className="flex justify-end text-sm text-muted-foreground">
                  {tf.lineTotal}{' '}
                  <span className="ml-1 font-medium text-foreground">
                    {formatMoney(calculated?.lineTotalWithTax ?? 0, displayCurrency)}
                  </span>
                </div>
              </div>
            );
          })}

          {/* A credit memo credits lines of its invoice; a new line would not be on it. */}
          {!isCreditMemo && (
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
          )}

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

  const title = isCreditMemo ? td.form.creditMemoTitle : mode === 'add' ? tf.newInvoice : tf.editInvoice;

  return (
    <EntityFormLayout
      title={title}
      sections={sections}
      summaryTitle={tf.invoiceSummary}
      summaryIcon={Receipt}
      summaryFields={summaryFields}
      summaryContent={
        <div className="space-y-3">
          <DocumentTaxPanel
            state={preview}
            salesTax={salesTax}
            currency={displayCurrency}
            taxLabel={labels.tax}
            showAddressNotice={false}
          />
          {!salesTax && <p className="text-xs text-muted-foreground">{tf.totalsPreview}</p>}
        </div>
      }
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
