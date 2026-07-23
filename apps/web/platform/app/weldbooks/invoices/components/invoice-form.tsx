import { useMemo, useTransition } from 'react';
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
} from 'lucide-react';
import {
  useCreateInvoice,
  useUpdateInvoice,
  useAccountingCustomers,
  useAccountingTaxRates,
  useAccountingAccounts,
} from '@/hooks/queries/use-accounting-queries';
import type { InvoiceDetail } from '@/lib/api/domains/weldbooks';
import {
  EntityFormLayout,
  type FormSection,
  type SummaryField,
} from '@/components/entity-overview';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

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
    items: z.array(lineItemSchema).min(1, st('sweep.weldbooks.invoiceDialog.atLeastOneLineItem')),
  });
}

type InvoiceFormValues = z.infer<ReturnType<typeof createInvoiceFormSchema>>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface InvoiceFormProps {
  mode: 'add' | 'edit';
  invoice?: InvoiceDetail;
}

export function InvoiceForm({ mode, invoice }: InvoiceFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const { t } = useI18n();
  const st = useTranslations();
  const tf = t.accounting.invoiceForm;
  const invoiceFormSchema = useMemo(() => createInvoiceFormSchema(st), [st]);

  const createMutation = useCreateInvoice();
  const updateMutation = useUpdateInvoice();

  // Data queries
  // Invoices only go to customers — exclude suppliers. Backend expands
  // role=customer to include "both"-role contacts, so dual-role parties qualify.
  const { data: contactsData } = useAccountingCustomers({ role: 'customer' });
  const { data: taxRatesData } = useAccountingTaxRates();
  const { data: accountsData } = useAccountingAccounts();

  const contacts = (contactsData as any)?.data ?? [];
  const taxRates = (taxRatesData as any)?.data ?? [];
  const accounts = (accountsData as any)?.data ?? [];

  // Build default values
  const defaultValues: InvoiceFormValues = useMemo(() => {
    if (mode === 'edit' && invoice) {
      return {
        contactId: invoice.contactId ?? '',
        issueDate: invoice.issueDate?.slice(0, 10) ?? todayISO(),
        dueDate: invoice.dueDate?.slice(0, 10) ?? defaultDueDate(),
        reference: invoice.reference ?? '',
        notes: (invoice as any).notes ?? '',
        internalNotes: (invoice as any).internalNotes ?? '',
        items:
          invoice.items && invoice.items.length > 0
            ? invoice.items.map((item) => ({
                description: item.description ?? '',
                quantity: parseFloat(item.quantity ?? '1') || 1,
                unitPrice: parseFloat(item.unitPrice) || 0,
                taxRateId: item.taxRateId ?? null,
                accountId: item.accountId ?? null,
                unit: item.unit ?? '',
                discountPercent: parseFloat(item.discountPercent ?? '0') || 0,
              }))
            : [{ description: '', quantity: 1, unitPrice: 0, taxRateId: null, accountId: null, unit: '', discountPercent: 0 }],
      };
    }
    return {
      contactId: '',
      issueDate: todayISO(),
      dueDate: defaultDueDate(),
      reference: '',
      notes: '',
      internalNotes: '',
      items: [{ description: '', quantity: 1, unitPrice: 0, taxRateId: null, accountId: null, unit: '', discountPercent: 0 }],
    };
  }, [mode, invoice]);

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

  // ---------------------------------------------------------------------------
  // Calculations
  // ---------------------------------------------------------------------------

  const taxRateMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const tr of taxRates) {
      map[tr.id] = parseFloat(tr.rate ?? '0');
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

  const onSubmit = (values: any) => {
    startTransition(async () => {
      try {
        const payload: Record<string, unknown> = {
          contactId: values.contactId,
          issueDate: values.issueDate,
          dueDate: values.dueDate,
          reference: values.reference || undefined,
          notes: values.notes || undefined,
          internalNotes: values.internalNotes || undefined,
          items: values.items.map((item: any) => ({
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            taxRateId: item.taxRateId || undefined,
            accountId: item.accountId || undefined,
            unit: item.unit || undefined,
            discountPercent: item.discountPercent || undefined,
          })),
        };

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
        console.error('Error saving invoice:', error);
        toast.error(tf.failedToSave, {
          description: error instanceof Error ? error.message : undefined,
        });
      }
    });
  };

  // ---------------------------------------------------------------------------
  // Selected contact label
  // ---------------------------------------------------------------------------

  const selectedContact = contacts.find((c: any) => c.id === watchedContactId);
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
              <SelectTrigger className="shadow-none">
                <SelectValue placeholder={tf.selectCustomer} />
              </SelectTrigger>
              <SelectContent>
                {contacts.map((c: any) => (
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
      title: tf.lineItems,
      icon: ListOrdered,
      content: (
        <>
          {fields.map((field, index) => (
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
                    onClick={() => remove(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>

              <div className="space-y-2">
                <Label>{tf.description}</Label>
                <Input
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
                  <Label>{tf.quantity}</Label>
                  <Input
                    type="number"
                    step="any"
                    min="0"
                    className="shadow-none"
                    {...form.register(`items.${index}.quantity`, { valueAsNumber: true })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{tf.unitPrice}</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    className="shadow-none"
                    {...form.register(`items.${index}.unitPrice`, { valueAsNumber: true })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{tf.taxRate}</Label>
                  <Select
                    value={form.watch(`items.${index}.taxRateId`) ?? ''}
                    onValueChange={(val) =>
                      form.setValue(`items.${index}.taxRateId`, val || null, { shouldValidate: true })
                    }
                  >
                    <SelectTrigger className="shadow-none">
                      <SelectValue placeholder={tf.noTax} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{tf.noTax}</SelectItem>
                      {taxRates.map((tr: any) => (
                        <SelectItem key={tr.id} value={tr.id}>
                          {tr.name ?? tr.rate + '%'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{tf.discountPercent}</Label>
                  <Input
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
                  {formatCurrency(lineCalculations[index]?.total ?? 0)}
                </span>
              </div>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shadow-none"
            onClick={() =>
              append({
                description: '',
                quantity: 1,
                unitPrice: 0,
                taxRateId: null,
                accountId: null,
                unit: '',
                discountPercent: 0,
              })
            }
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
    { label: tf.issueDate, value: form.watch('issueDate') || undefined },
    { label: tf.dueDate, value: form.watch('dueDate') || undefined },
    { label: tf.reference, value: form.watch('reference') || undefined, hideIfEmpty: true },
    {
      label: tf.lineItems,
      value: itemCount === 1
        ? tf.items.replace('{count}', String(itemCount))
        : tf.itemsPlural.replace('{count}', String(itemCount)),
    },
    { label: tf.subtotal, value: formatCurrency(totals.subtotal), bordered: true },
    { label: tf.tax, value: formatCurrency(totals.taxTotal) },
    { label: tf.total, value: <span className="font-semibold">{formatCurrency(totals.total)}</span> },
  ];

  return (
    <EntityFormLayout
      title={mode === 'add' ? tf.newInvoice : tf.editInvoice}
      sections={sections}
      summaryTitle={tf.invoiceSummary}
      summaryIcon={Receipt}
      summaryFields={summaryFields}
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
