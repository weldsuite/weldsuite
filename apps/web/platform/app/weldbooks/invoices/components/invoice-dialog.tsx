import { useCallback, useEffect, useMemo, useTransition } from 'react';
import { toast } from 'sonner';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Autocomplete, type AutocompleteOption } from '@weldsuite/ui/components/autocomplete';
import {
  useCreateInvoice,
  useAccountingCustomer,
  useAccountingCustomers,
  useAccountingTaxRates,
} from '@/hooks/queries/use-accounting-queries';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import type { Customer } from '@/lib/api/domains/weldbooks';
import type { TaxUse } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import type { ProductOption } from '@/hooks/queries/use-weldbooks-tax-preview';
import { toPostalAddressFormValue, type PostalAddress } from '@/components/address/postal-address';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { addDaysToIsoDate } from '@/lib/weldbooks/format';
import { NO_TAX_RATE } from '@/lib/weldbooks/document-tax';
import {
  EMPTY_SALES_TAX_LINE,
  overrideChecks,
  salesTaxLineFields,
  toTaxFormLine,
  type SalesTaxLineValues,
} from '@/lib/weldbooks/document-tax-form';
import { productTaxCode } from '@/lib/weldbooks/tax-codes';
import { InvoiceAddressSection } from './invoice-address-section';
import { DocumentTaxPanel } from './document-tax-panel';
import { InvoiceLineExtras } from './invoice-line-extras';
import { buildInvoicePayload } from './invoice-payload';
import { ProductPicker } from './product-picker';
import { useDescribeError } from './sales-tax-error-notice';
import { useDocumentTaxPreview } from './use-document-tax-preview';

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
    billingAddress: addressSchema,
    shipToDifferent: z.boolean(),
    shippingAddress: addressSchema,
    items: z.array(lineItemSchema).min(1, st('sweep.weldbooks.invoiceDialog.atLeastOneLineItem')),
  });
}

type InvoiceFormValues = z.infer<ReturnType<typeof createInvoiceFormSchema>>;

const emptyLine = { description: '', quantity: 1, unitPrice: 0, taxRateId: null, discountPercent: 0, ...EMPTY_SALES_TAX_LINE };

interface InvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (invoice: { id: string }) => void;
}

export function InvoiceDialog({ open, onOpenChange, onCreated }: Readonly<InvoiceDialogProps>) {
  const [isPending, startTransition] = useTransition();
  const createMutation = useCreateInvoice();
  const { t } = useI18n();
  const st = useTranslations();
  const tid = t.accounting.invoiceDialog;
  const td = useDocumentTexts();
  const invoiceFormSchema = useMemo(
    () =>
      createInvoiceFormSchema(st, {
        reasonRequired: td.line.overrideReasonRequired,
        amountInvalid: td.line.overrideAmountInvalid,
      }),
    [st, td.line.overrideReasonRequired, td.line.overrideAmountInvalid],
  );
  const { entityCurrency, formatMoney, today } = useWeldbooksFormat();
  const { labels } = useJurisdictionLabels();
  const describeError = useDescribeError();

  const { data: contactsData } = useAccountingCustomers({ role: 'customer' });
  const { data: taxRatesData } = useAccountingTaxRates();

  const contacts = useMemo(() => contactsData?.data ?? [], [contactsData]);
  const taxRates = useMemo(() => taxRatesData?.data ?? [], [taxRatesData]);

  const toContactOption = useCallback((c: Customer): AutocompleteOption => {
    const fullName = [c.firstName, c.lastName].filter(Boolean).join(' ');
    const label = c.name || c.companyName || fullName || c.email || st('sweep.weldbooks.invoiceDialog.unnamedContact');
    return {
      value: c.id,
      label,
      description: c.email && c.email !== label ? c.email : undefined,
    };
  }, [st]);

  const contactOptions: AutocompleteOption[] = useMemo(
    () => contacts.map((c) => toContactOption(c)),
    [contacts, toContactOption],
  );

  const searchContacts = async (query: string): Promise<AutocompleteOption[]> => {
    const res = await accountingApi.listCustomers({
      role: 'customer',
      search: query,
      pageSize: 50,
    });
    return (res?.data ?? []).map((c) => toContactOption(c));
  };

  const defaultValues = useMemo(() => {
    const issueDate = today();
    return {
      contactId: '',
      issueDate,
      dueDate: addDaysToIsoDate(issueDate, DEFAULT_PAYMENT_TERMS_DAYS),
      reference: '',
      notes: '',
      billingAddress: toPostalAddressFormValue(null),
      shipToDifferent: false,
      shippingAddress: toPostalAddressFormValue(null),
      items: [{ ...emptyLine }],
    };
  }, [today]);

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

  // The due date follows the customer's payment terms until picked by hand.
  const { data: selectedContactData } = useAccountingCustomer(watchedContactId);
  const selectedTerms = selectedContactData?.data?.paymentTermsDays;
  const customerUse = (selectedContactData?.data as { taxUse?: TaxUse | null } | undefined)?.taxUse ?? null;
  useEffect(() => {
    if (selectedTerms == null || form.getFieldState('dueDate').isDirty) return;
    form.setValue('dueDate', addDaysToIsoDate(form.getValues('issueDate'), selectedTerms));
  }, [selectedTerms, form]);

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

  // The server calculates the totals and each line's tax; nothing is computed here.
  const { salesTax, preview, totals, lineTax } = useDocumentTaxPreview({
    kind: 'invoice',
    contactId: watchedContactId,
    issueDate: watched.issueDate,
    currency: entityCurrency,
    billingAddress: watched.billingAddress,
    shipToDifferent: watched.shipToDifferent,
    shippingAddress: watched.shippingAddress,
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
        taxCode: productTaxCode(product) ?? '',
        description: current.description || product.name,
        unitPrice: Number(current.unitPrice) > 0 || !product.price ? current.unitPrice : product.price,
      },
      { shouldDirty: true },
    );
  };

  const handleClose = (next: boolean) => {
    if (!next) {
      form.reset(defaultValues);
    }
    onOpenChange(next);
  };

  const onSubmit = (values: InvoiceFormValues) => {
    startTransition(async () => {
      try {
        const payload = buildInvoicePayload(
          { ...values, shipFromDifferent: false, marketplaceFacilitated: false },
          { mode: 'add', kind: 'invoice', salesTax, currency: entityCurrency },
        );

        const result = (await createMutation.mutateAsync(payload)) as
          | { id?: string; data?: { id?: string } }
          | undefined;
        const createdId = result?.data?.id ?? result?.id;
        toast.success(tid.invoiceCreated);
        form.reset(defaultValues);
        onOpenChange(false);
        if (createdId) onCreated?.({ id: createdId });
      } catch (error) {
        toast.error(tid.failedToCreate, {
          description: describeError(error) ?? st('sweep.weldbooks.invoiceDialog.unexpectedError'),
        });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-5xl w-full p-0 gap-0 overflow-hidden max-h-[90vh] flex flex-col">
        <DialogHeader className="px-4 sm:px-6 py-4 border-b">
          <DialogTitle>{tid.newInvoice}</DialogTitle>
          <DialogDescription>{tid.createForCustomer}</DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-6">
            <div className="space-y-2">
              <Label htmlFor="contactId">{tid.customer}</Label>
              <Autocomplete
                options={contactOptions}
                value={form.watch('contactId')}
                onValueChange={(val) => form.setValue('contactId', val, { shouldValidate: true })}
                onSearch={searchContacts}
                minSearchLength={2}
                debounceMs={300}
                placeholder={tid.selectCustomer}
                searchPlaceholder={tid.searchCustomers}
                emptyText={tid.noCustomersFound}
              />
              {form.formState.errors.contactId && (
                <p className="text-sm text-destructive">
                  {form.formState.errors.contactId.message}
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="issueDate">{tid.issueDate}</Label>
                <Input
                  id="issueDate"
                  type="date"
                  className="shadow-none"
                  {...form.register('issueDate')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="dueDate">{tid.dueDate}</Label>
                <Input
                  id="dueDate"
                  type="date"
                  className="shadow-none"
                  {...form.register('dueDate')}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="reference">{tid.reference}</Label>
              <Input
                id="reference"
                placeholder={tid.referencePlaceholder}
                className="shadow-none"
                {...form.register('reference')}
              />
            </div>

            {watchedContactId ? (
              <InvoiceAddressSection
                idPrefix="invoice-dialog"
                contactId={watchedContactId}
                billingAddress={form.watch('billingAddress')}
                shippingAddress={form.watch('shippingAddress')}
                shipToDifferent={form.watch('shipToDifferent')}
                onBillingAddressChange={setBillingAddress}
                onShippingAddressChange={setShippingAddress}
                onShipToDifferentChange={setShipToDifferent}
              />
            ) : null}

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>{tid.lineItems}</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shadow-none h-7"
                  onClick={() => append({ ...emptyLine })}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  {tid.addItem}
                </Button>
              </div>

              {fields.map((field, index) => {
                const id = (name: string) => `dialog-items-${index}-${name}`;
                const line = watchedItems?.[index];
                const calculated = lineTax(index);
                const errors = form.formState.errors.items?.[index];
                return (
                  <div key={field.id} className="rounded-md border border-border p-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">
                        {tid.itemNumber.replace('{number}', String(index + 1))}
                      </span>
                      {fields.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-destructive"
                          aria-label={tid.itemNumber.replace('{number}', String(index + 1))}
                          onClick={() => remove(index)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>

                    {salesTax && (
                      <ProductPicker
                        id={id('product')}
                        value={line?.productId ?? ''}
                        selectedLabel={line?.description}
                        onSelect={(product) => selectProduct(index, product)}
                      />
                    )}

                    <div className="space-y-1.5">
                      <Label htmlFor={id('description')} className="text-xs">{tid.description}</Label>
                      <Input
                        id={id('description')}
                        placeholder={tid.descriptionPlaceholder}
                        className="shadow-none"
                        {...form.register(`items.${index}.description`)}
                      />
                      {errors?.description && (
                        <p className="text-sm text-destructive">{errors.description.message}</p>
                      )}
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                      <div className="space-y-1.5">
                        <Label htmlFor={id('quantity')} className="text-xs">{tid.quantity}</Label>
                        <Input
                          id={id('quantity')}
                          type="number"
                          step="any"
                          min="0"
                          className="shadow-none"
                          {...form.register(`items.${index}.quantity`, { valueAsNumber: true })}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={id('unitPrice')} className="text-xs">{tid.unitPrice}</Label>
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
                        <div className="space-y-1.5">
                          <Label htmlFor={id('taxRate')} className="text-xs">{labels.taxRate}</Label>
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
                      <div className="space-y-1.5">
                        <Label htmlFor={id('discountPercent')} className="text-xs">{tid.discountPercent}</Label>
                        <Input
                          id={id('discountPercent')}
                          type="number"
                          step="0.01"
                          min="0"
                          max="100"
                          className="shadow-none"
                          {...form.register(`items.${index}.discountPercent`, {
                            valueAsNumber: true,
                          })}
                        />
                      </div>
                    </div>

                    {line && (
                      <InvoiceLineExtras
                        idPrefix={`dialog-items-${index}`}
                        salesTax={salesTax}
                        mode="invoice"
                        value={line as SalesTaxLineValues}
                        onChange={(patch) => setLine(index, patch)}
                        customerUse={customerUse}
                        tax={calculated ? { amount: calculated.taxAmount, rate: calculated.taxRate } : null}
                        currency={entityCurrency}
                        errors={{
                          taxOverrideAmount: errors?.taxOverrideAmount?.message,
                          taxOverrideReason: errors?.taxOverrideReason?.message,
                        }}
                      />
                    )}
                  </div>
                );
              })}

              {form.formState.errors.items?.root && (
                <p className="text-sm text-destructive">
                  {form.formState.errors.items.root.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">{tid.notes}</Label>
              <Textarea
                id="notes"
                rows={3}
                placeholder={tid.notesPlaceholder}
                className="shadow-none"
                {...form.register('notes')}
              />
            </div>
          </div>

          {/* The breakdown and warnings can run long: they scroll here instead of squeezing the form. */}
          <div className="border-t px-4 sm:px-6 py-3 space-y-2 text-sm max-h-[35vh] overflow-y-auto">
            <div className="flex justify-between text-muted-foreground">
              <span>{tid.subtotal}</span>
              <span>{formatMoney(totals.subtotal)}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>{labels.tax}</span>
              <span>{formatMoney(totals.taxTotal)}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>{tid.total}</span>
              <span>{formatMoney(totals.total)}</span>
            </div>
            <DocumentTaxPanel state={preview} salesTax={salesTax} currency={entityCurrency} taxLabel={labels.tax} />
            {!salesTax && <p className="text-xs text-muted-foreground">{tid.totalsPreview}</p>}
          </div>

          <div className="border-t px-4 sm:px-6 py-4 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleClose(false)}
              disabled={isPending}
              className="shadow-none"
            >
              {tid.cancel}
            </Button>
            <Button type="submit" disabled={isPending} className="shadow-none">
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {tid.creating}
                </>
              ) : (
                tid.createInvoice
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
