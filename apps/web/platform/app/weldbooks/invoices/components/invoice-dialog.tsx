import { useMemo, useTransition } from 'react';
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
  useAccountingCustomers,
  useAccountingTaxRates,
} from '@/hooks/queries/use-accounting-queries';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

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
    items: z.array(lineItemSchema).min(1, st('sweep.weldbooks.invoiceDialog.atLeastOneLineItem')),
  });
}

type InvoiceFormValues = z.infer<ReturnType<typeof createInvoiceFormSchema>>;

const formatCurrency = (value: number) =>
  new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(value);

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function defaultDueDate() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

interface InvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (invoice: { id: string }) => void;
}

export function InvoiceDialog({ open, onOpenChange, onCreated }: InvoiceDialogProps) {
  const [isPending, startTransition] = useTransition();
  const createMutation = useCreateInvoice();
  const { t } = useI18n();
  const st = useTranslations();
  const tid = t.accounting.invoiceDialog;
  const invoiceFormSchema = useMemo(() => createInvoiceFormSchema(st), [st]);

  const { data: contactsData } = useAccountingCustomers({ role: 'customer' });
  const { data: taxRatesData } = useAccountingTaxRates();

  const contacts = (contactsData as any)?.data ?? [];
  const taxRates = (taxRatesData as any)?.data ?? [];

  const toContactOption = (c: any): AutocompleteOption => {
    const fullName = [c.firstName, c.lastName].filter(Boolean).join(' ');
    const label = c.name || c.companyName || fullName || c.email || st('sweep.weldbooks.invoiceDialog.unnamedContact');
    return {
      value: c.id,
      label,
      description: c.email && c.email !== label ? c.email : undefined,
    };
  };

  const contactOptions: AutocompleteOption[] = useMemo(
    () => contacts.map(toContactOption),
    [contacts],
  );

  const searchContacts = async (query: string): Promise<AutocompleteOption[]> => {
    const res = (await accountingApi.listCustomers({
      role: 'customer',
      search: query,
      pageSize: 50,
    })) as { data?: any[] };
    return (res?.data ?? []).map(toContactOption);
  };

  const defaultValues: InvoiceFormValues = useMemo(
    () => ({
      contactId: '',
      issueDate: todayISO(),
      dueDate: defaultDueDate(),
      reference: '',
      notes: '',
      items: [{ description: '', quantity: 1, unitPrice: 0, taxRateId: null, discountPercent: 0 }],
    }),
    [],
  );

  const form = useForm({
    resolver: zodResolver(invoiceFormSchema),
    defaultValues,
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'items',
  });

  const watchedItems = form.watch('items');

  const taxRateMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const tr of taxRates) {
      map[tr.id] = parseFloat(tr.rate ?? '0');
    }
    return map;
  }, [taxRates]);

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
          items: values.items.map((item) => ({
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            taxRateId: item.taxRateId || undefined,
            discountPercent: item.discountPercent || undefined,
          })),
        };

        const result = (await createMutation.mutateAsync(payload)) as
          | { id?: string; data?: { id?: string } }
          | undefined;
        const createdId = result?.data?.id ?? result?.id;
        toast.success(tid.invoiceCreated);
        form.reset(defaultValues);
        onOpenChange(false);
        if (createdId) onCreated?.({ id: createdId });
      } catch (error) {
        console.error('Error creating invoice:', error);
        toast.error(tid.failedToCreate, {
          description: error instanceof Error ? error.message : st('sweep.weldbooks.invoiceDialog.unexpectedError'),
        });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-5xl w-full p-0 gap-0 overflow-hidden max-h-[90vh] flex flex-col">
        <DialogHeader className="px-6 py-4 border-b">
          <DialogTitle>{tid.newInvoice}</DialogTitle>
          <DialogDescription>{tid.createForCustomer}</DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
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

            <div className="grid grid-cols-2 gap-3">
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

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>{tid.lineItems}</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shadow-none h-7"
                  onClick={() =>
                    append({
                      description: '',
                      quantity: 1,
                      unitPrice: 0,
                      taxRateId: null,
                      discountPercent: 0,
                    })
                  }
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  {tid.addItem}
                </Button>
              </div>

              {fields.map((field, index) => (
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
                        onClick={() => remove(index)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>

                  <Input
                    placeholder={tid.descriptionPlaceholder}
                    className="shadow-none"
                    {...form.register(`items.${index}.description`)}
                  />
                  {form.formState.errors.items?.[index]?.description && (
                    <p className="text-sm text-destructive">
                      {form.formState.errors.items[index]?.description?.message}
                    </p>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      type="number"
                      step="any"
                      min="0"
                      placeholder={tid.qtyPlaceholder}
                      className="shadow-none"
                      {...form.register(`items.${index}.quantity`, { valueAsNumber: true })}
                    />
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder={tid.unitPricePlaceholder}
                      className="shadow-none"
                      {...form.register(`items.${index}.unitPrice`, { valueAsNumber: true })}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <Select
                      value={form.watch(`items.${index}.taxRateId`) ?? ''}
                      onValueChange={(val) =>
                        form.setValue(`items.${index}.taxRateId`, val === 'none' ? null : val, {
                          shouldValidate: true,
                        })
                      }
                    >
                      <SelectTrigger className="shadow-none">
                        <SelectValue placeholder={tid.taxRatePlaceholder} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{tid.noTax}</SelectItem>
                        {taxRates.map((tr: any) => (
                          <SelectItem key={tr.id} value={tr.id}>
                            {tr.name ?? tr.rate + '%'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      placeholder={tid.discountPlaceholder}
                      className="shadow-none"
                      {...form.register(`items.${index}.discountPercent`, {
                        valueAsNumber: true,
                      })}
                    />
                  </div>
                </div>
              ))}

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

          <div className="border-t px-6 py-3 space-y-1 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>{tid.subtotal}</span>
              <span>{formatCurrency(totals.subtotal)}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>{tid.tax}</span>
              <span>{formatCurrency(totals.taxTotal)}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>{tid.total}</span>
              <span>{formatCurrency(totals.total)}</span>
            </div>
          </div>

          <div className="border-t px-6 py-4 flex items-center justify-end gap-2">
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
