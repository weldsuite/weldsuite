import { useMemo } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useAccountingCustomer, useAccountingCustomers, useAccountingTaxRates } from '@/hooks/queries/use-accounting-queries';
import {
  useCreateRecurringInvoice,
  useUpdateRecurringInvoice,
} from '@/hooks/queries/use-weldbooks-recurring-queries';
import type { ProductOption } from '@/hooks/queries/use-weldbooks-tax-preview';
import type { RecurringInvoice } from '@/lib/api/domains/weldbooks';
import type { RecurringTemplateTaxItem, TaxUse } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { toPostalAddressFormValue } from '@/components/address/postal-address';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import { toCalendarDate } from '@/lib/weldbooks/format';
import { NO_TAX_RATE } from '@/lib/weldbooks/document-tax';
import { EMPTY_SALES_TAX_LINE, salesTaxLineFields, type SalesTaxLineValues } from '@/lib/weldbooks/document-tax-form';
import { productTaxCode } from '@/lib/weldbooks/tax-codes';
import { InvoiceLineExtras } from '@/app/weldbooks/invoices/components/invoice-line-extras';
import { ProductPicker } from '@/app/weldbooks/invoices/components/product-picker';
import { useDescribeError } from '@/app/weldbooks/invoices/components/sales-tax-error-notice';
import { ShipFromSection } from '@/app/weldbooks/invoices/components/ship-from-section';
import { buildRecurringPayload, RECURRING_FREQUENCIES } from './recurring-payload';

const addressSchema = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});

function createRecurringSchema(messages: {
  customerRequired: string;
  dateRequired: string;
  descriptionRequired: string;
  atLeastOneLine: string;
}) {
  const lineSchema = z.object({
    description: z.string().min(1, messages.descriptionRequired),
    quantity: z.coerce.number().min(0).default(1),
    unitPrice: z.coerce.number().min(0).default(0),
    taxRateId: z.string().nullable().optional(),
    unit: z.string().optional().default(''),
    accountId: z.string().optional().default(''),
    ...salesTaxLineFields,
  });

  return z.object({
    name: z.string().max(255).optional().default(''),
    contactId: z.string().min(1, messages.customerRequired),
    frequency: z.enum(RECURRING_FREQUENCIES),
    nextIssueDate: z.string().min(1, messages.dateRequired),
    endDate: z.string().optional().default(''),
    autoFinalize: z.boolean().default(false),
    autoSend: z.boolean().default(false),
    paymentTermsDays: z.coerce.number().min(0).default(30),
    reference: z.string().optional().default(''),
    notes: z.string().optional().default(''),
    shipFromDifferent: z.boolean().default(false),
    shipFromAddress: addressSchema,
    items: z.array(lineSchema).min(1, messages.atLeastOneLine),
  });
}

type RecurringFormValues = z.infer<ReturnType<typeof createRecurringSchema>>;

const emptyLine = {
  description: '',
  quantity: 1,
  unitPrice: 0,
  taxRateId: null,
  unit: '',
  accountId: '',
  ...EMPTY_SALES_TAX_LINE,
};

interface RecurringInvoiceFormProps {
  mode: 'add' | 'edit';
  recurring?: RecurringInvoice;
  /** Called with the saved recurring invoice's id. */
  onSaved: (id: string) => void;
  onCancel?: () => void;
}

/**
 * Create or edit a recurring invoice template. The lines carry the same tax
 * fields as an invoice line (US: tax code, use, tax included, product; VAT / GST:
 * the rate) plus class and location, and the template the ship-from address.
 * No tax is calculated here: each generated invoice is taxed by the server
 * from the customer's address on the day it is made.
 */
export function RecurringInvoiceForm({ mode, recurring, onSaved, onCancel }: Readonly<RecurringInvoiceFormProps>) {
  const td = useDocumentTexts();
  const tr = td.recurring;
  const { labels, features } = useJurisdictionLabels();
  const { entityCurrency, today, entity } = useWeldbooksFormat();
  const describeError = useDescribeError();
  const createMutation = useCreateRecurringInvoice();
  const updateMutation = useUpdateRecurringInvoice();
  const salesTax = features.salesTax;

  const { data: contactsData } = useAccountingCustomers({ role: 'customer' });
  const { data: taxRatesData } = useAccountingTaxRates();
  const contacts = contactsData?.data ?? [];
  const taxRates = taxRatesData?.data ?? [];

  const schema = useMemo(
    () =>
      createRecurringSchema({
        customerRequired: tr.customerRequired,
        dateRequired: tr.dateRequired,
        descriptionRequired: tr.descriptionRequired,
        atLeastOneLine: tr.atLeastOneLine,
      }),
    [tr.customerRequired, tr.dateRequired, tr.descriptionRequired, tr.atLeastOneLine],
  );

  const template = recurring?.templateData ?? null;
  const storedItems = (template?.items ?? []) as RecurringTemplateTaxItem[];
  const shipFromStored = normalizeAccountingAddress((template as { shipFromAddress?: unknown } | null)?.shipFromAddress);

  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      name: recurring?.name ?? '',
      contactId: recurring?.contactId ?? '',
      frequency: (RECURRING_FREQUENCIES as readonly string[]).includes(recurring?.frequency ?? '')
        ? (recurring?.frequency as (typeof RECURRING_FREQUENCIES)[number])
        : 'monthly',
      nextIssueDate: toCalendarDate(recurring?.nextIssueDate) ?? today(),
      endDate: toCalendarDate(recurring?.endDate) ?? '',
      autoFinalize: Boolean(recurring?.autoFinalize),
      autoSend: Boolean(recurring?.autoSend),
      paymentTermsDays: template?.paymentTermsDays ?? 30,
      reference: template?.reference ?? '',
      notes: template?.notes ?? '',
      shipFromDifferent: Boolean(shipFromStored),
      shipFromAddress: toPostalAddressFormValue(shipFromStored),
      items:
        storedItems.length > 0
          ? storedItems.map((item) => ({
              description: item.description ?? '',
              quantity: item.quantity ?? 1,
              unitPrice: item.unitPrice ?? 0,
              taxRateId: item.taxRateId ?? null,
              unit: item.unit ?? '',
              accountId: item.accountId ?? '',
              productId: item.productId ?? '',
              taxCode: item.taxCode ?? '',
              taxUse: (item.taxUse ?? '') as '' | TaxUse,
              taxIncluded: Boolean(item.taxIncluded),
              taxOverrideEnabled: false,
              taxOverrideAmount: '',
              taxOverrideReason: '',
              classId: item.classId ?? '',
              locationId: item.locationId ?? '',
              originalLineId: '',
            }))
          : [{ ...emptyLine }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'items' });
  const watched = form.watch();
  const { data: contactData } = useAccountingCustomer(watched.contactId);
  const customerUse = (contactData?.data as { taxUse?: TaxUse | null } | undefined)?.taxUse ?? null;

  const setLine = (index: number, patch: Partial<SalesTaxLineValues>) => {
    const current = form.getValues(`items.${index}`);
    form.setValue(`items.${index}`, { ...current, ...patch }, { shouldDirty: true });
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

  const onSubmit = async (values: RecurringFormValues) => {
    const payload = buildRecurringPayload(values, {
      mode,
      salesTax,
      currency: entityCurrency,
      existing: recurring?.templateData,
    });
    try {
      if (mode === 'edit' && recurring) {
        await updateMutation.mutateAsync({ id: recurring.id, data: payload });
        toast.success(tr.updated);
        onSaved(recurring.id);
      } else {
        const res = await createMutation.mutateAsync(payload);
        toast.success(tr.created);
        onSaved(res.data.id);
      }
    } catch (error) {
      toast.error(tr.saveFailed, { description: describeError(error) });
    }
  };

  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{mode === 'add' ? tr.pageTitle : tr.editTitle}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="recurring-name">{tr.name}</Label>
            <Input id="recurring-name" placeholder={tr.namePlaceholder} {...form.register('name')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="recurring-contact">{tr.customer}</Label>
            <Select
              value={watched.contactId}
              onValueChange={(val) => form.setValue('contactId', val, { shouldValidate: true, shouldDirty: true })}
            >
              <SelectTrigger id="recurring-contact">
                <SelectValue placeholder={tr.selectCustomer} />
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
          <div className="space-y-2">
            <Label htmlFor="recurring-frequency">{tr.frequency}</Label>
            <Select
              value={watched.frequency}
              onValueChange={(val) =>
                form.setValue('frequency', val as (typeof RECURRING_FREQUENCIES)[number], { shouldDirty: true })
              }
            >
              <SelectTrigger id="recurring-frequency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RECURRING_FREQUENCIES.map((frequency) => (
                  <SelectItem key={frequency} value={frequency}>
                    {tr.frequencies[frequency]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="recurring-next">{tr.nextIssueDate}</Label>
            <Input id="recurring-next" type="date" {...form.register('nextIssueDate')} />
            {form.formState.errors.nextIssueDate && (
              <p className="text-sm text-destructive">{form.formState.errors.nextIssueDate.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="recurring-end">{tr.endDate}</Label>
            <Input id="recurring-end" type="date" {...form.register('endDate')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="recurring-terms">{tr.paymentTermsDays}</Label>
            <Input id="recurring-terms" type="number" min="0" step="1" {...form.register('paymentTermsDays')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="recurring-reference">{tr.reference}</Label>
            <Input id="recurring-reference" {...form.register('reference')} />
          </div>
          <div className="space-y-3 md:col-span-2">
            <label className="flex items-center gap-2 text-sm" htmlFor="recurring-autoFinalize">
              <Checkbox
                id="recurring-autoFinalize"
                checked={watched.autoFinalize}
                onCheckedChange={(checked) => form.setValue('autoFinalize', checked === true, { shouldDirty: true })}
              />
              {tr.autoFinalize}
            </label>
            <label className="flex items-center gap-2 text-sm" htmlFor="recurring-autoSend">
              <Checkbox
                id="recurring-autoSend"
                checked={watched.autoSend}
                onCheckedChange={(checked) => form.setValue('autoSend', checked === true, { shouldDirty: true })}
              />
              {tr.autoSend}
            </label>
          </div>
        </CardContent>
      </Card>

      {salesTax && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tr.shipFromTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <ShipFromSection
              idPrefix="recurring-shipfrom"
              entityAddress={normalizeAccountingAddress(entity?.address)}
              shipFromDifferent={Boolean(watched.shipFromDifferent)}
              shipFromAddress={watched.shipFromAddress}
              onShipFromDifferentChange={(next) => form.setValue('shipFromDifferent', next, { shouldDirty: true })}
              onShipFromAddressChange={(next) =>
                form.setValue('shipFromAddress', toPostalAddressFormValue(next), { shouldDirty: true })
              }
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">{tr.lineItems}</CardTitle>
          <Button type="button" variant="outline" size="sm" onClick={() => append({ ...emptyLine })}>
            <Plus className="h-4 w-4 mr-1" />
            {tr.addLine}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">{tr.taxNote}</p>
          {fields.map((field, index) => {
            const line = watched.items?.[index];
            const errors = form.formState.errors.items?.[index];
            return (
              <div key={field.id} className="space-y-3 rounded-md border border-border p-4">
                <div className="flex items-center justify-end">
                  {fields.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      aria-label={td.bill.removeLine}
                      onClick={() => remove(index)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>

                {salesTax && (
                  <ProductPicker
                    id={`recurring-${index}-product`}
                    value={line?.productId ?? ''}
                    selectedLabel={line?.description}
                    onSelect={(product) => selectProduct(index, product)}
                  />
                )}

                <div className="space-y-2">
                  <Label htmlFor={`recurring-${index}-description`}>{tr.description}</Label>
                  <Input id={`recurring-${index}-description`} {...form.register(`items.${index}.description`)} />
                  {errors?.description && <p className="text-sm text-destructive">{errors.description.message}</p>}
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor={`recurring-${index}-quantity`}>{tr.quantity}</Label>
                    <Input
                      id={`recurring-${index}-quantity`}
                      type="number"
                      step="any"
                      min="0"
                      {...form.register(`items.${index}.quantity`, { valueAsNumber: true })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`recurring-${index}-unitPrice`}>{tr.unitPrice}</Label>
                    <Input
                      id={`recurring-${index}-unitPrice`}
                      type="number"
                      step="0.01"
                      min="0"
                      {...form.register(`items.${index}.unitPrice`, { valueAsNumber: true })}
                    />
                  </div>
                  {!salesTax && (
                    <div className="space-y-2">
                      <Label htmlFor={`recurring-${index}-taxRate`}>{labels.taxRate}</Label>
                      <Select
                        value={watched.items?.[index]?.taxRateId ?? NO_TAX_RATE}
                        onValueChange={(val) =>
                          form.setValue(`items.${index}.taxRateId`, val === NO_TAX_RATE ? null : val, { shouldDirty: true })
                        }
                      >
                        <SelectTrigger id={`recurring-${index}-taxRate`}>
                          <SelectValue placeholder={labels.noTax} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_TAX_RATE}>{labels.noTax}</SelectItem>
                          {taxRates.map((rate) => (
                            <SelectItem key={rate.id} value={rate.id}>
                              {rate.name ?? `${Number(rate.rate)}%`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>

                {line && (
                  <InvoiceLineExtras
                    idPrefix={`recurring-${index}`}
                    salesTax={salesTax}
                    mode="template"
                    value={line as SalesTaxLineValues}
                    onChange={(patch) => setLine(index, patch)}
                    customerUse={customerUse}
                  />
                )}
              </div>
            );
          })}
          {form.formState.errors.items?.root && (
            <p className="text-sm text-destructive">{form.formState.errors.items.root.message}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{tr.notes}</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea rows={3} aria-label={tr.notes} {...form.register('notes')} />
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
            {tr.cancelEdit}
          </Button>
        )}
        <Button type="submit" disabled={saving}>
          {saving ? tr.saving : tr.save}
        </Button>
      </div>
    </form>
  );
}
