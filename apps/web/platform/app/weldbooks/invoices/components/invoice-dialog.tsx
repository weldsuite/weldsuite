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
import { toPostalAddressFormValue, type PostalAddress } from '@/components/address/postal-address';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { addDaysToIsoDate } from '@/lib/weldbooks/format';
import { InvoiceAddressSection, invoiceAddressPayload } from './invoice-address-section';

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
    discountPercent: z.coerce.number().min(0).max(100).default(0),
  });

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

const emptyLine = { description: '', quantity: 1, unitPrice: 0, taxRateId: null, discountPercent: 0 };

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
  const invoiceFormSchema = useMemo(() => createInvoiceFormSchema(st), [st]);
  const { entityCurrency, formatMoney, today } = useWeldbooksFormat();
  const { labels } = useJurisdictionLabels();

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
    () => contacts.map(toContactOption),
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

  const defaultValues: InvoiceFormValues = useMemo(() => {
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

  const watchedItems = form.watch('items');
  const watchedContactId = form.watch('contactId');

  // The due date follows the customer's payment terms until picked by hand.
  const { data: selectedContactData } = useAccountingCustomer(watchedContactId);
  const selectedTerms = selectedContactData?.data?.paymentTermsDays;
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

  const taxRateMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const tr of taxRates) {
      map[tr.id] = Number.parseFloat(tr.rate ?? '0');
    }
    return map;
  }, [taxRates]);

  // Preview only — the server computes the authoritative totals on save.
  const totals = useMemo(() => {
    let subtotal = 0;
    let taxTotal = 0;
    for (const item of watchedItems ?? []) {
      const qty = Number(item.quantity) || 0;
      const price = Number(item.unitPrice) || 0;
      const discount = Number(item.discountPercent) || 0;
      const lineSubtotal = qty * price * (1 - discount / 100);
      const rate = item.taxRateId ? (taxRateMap[item.taxRateId] ?? 0) : 0;
      subtotal += lineSubtotal;
      taxTotal += lineSubtotal * (rate / 100);
    }
    return { subtotal, taxTotal, total: subtotal + taxTotal };
  }, [watchedItems, taxRateMap]);

  const handleClose = (next: boolean) => {
    if (!next) {
      form.reset(defaultValues);
    }
    onOpenChange(next);
  };

  const onSubmit = (values: InvoiceFormValues) => {
    startTransition(async () => {
      try {
        const payload: Record<string, unknown> = {
          contactId: values.contactId,
          issueDate: values.issueDate,
          dueDate: values.dueDate,
          reference: values.reference || undefined,
          notes: values.notes || undefined,
          ...invoiceAddressPayload(values, 'add'),
          items: values.items.map((item) => ({
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            // "No tax" is null — the API rejects placeholder ids such as 'none'.
            taxRateId: item.taxRateId && item.taxRateId !== NO_TAX ? item.taxRateId : null,
            discountPercent: item.discountPercent || undefined,
          })),
        };
        if (entityCurrency) payload.currency = entityCurrency;

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
          description: error instanceof Error ? error.message : st('sweep.weldbooks.invoiceDialog.unexpectedError'),
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

                    <div className="space-y-1.5">
                      <Label htmlFor={id('description')} className="text-xs">{tid.description}</Label>
                      <Input
                        id={id('description')}
                        placeholder={tid.descriptionPlaceholder}
                        className="shadow-none"
                        {...form.register(`items.${index}.description`)}
                      />
                      {form.formState.errors.items?.[index]?.description && (
                        <p className="text-sm text-destructive">
                          {form.formState.errors.items[index]?.description?.message}
                        </p>
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
                      <div className="space-y-1.5">
                        <Label htmlFor={id('taxRate')} className="text-xs">{labels.taxRate}</Label>
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

          <div className="border-t px-4 sm:px-6 py-3 space-y-1 text-sm">
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
            <p className="text-xs text-muted-foreground">{tid.totalsPreview}</p>
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
