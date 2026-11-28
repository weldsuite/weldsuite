/**
 * The quote form (edition feature `books-quotes`), a page like the invoice form:
 * who it is for, its name and validity, the lines (the invoice editor's line
 * card: description, quantity, price, discount, tax rate, optional product),
 * notes and terms, with a running preview on the left. Saving a new quote
 * opens its panel on the list.
 */

import { useMemo } from 'react';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { CalendarClock, ListOrdered, Plus, StickyNote, Trash2, User } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { ContactPicker } from '@/components/accounting/contact-picker';
import { useAccountingTaxRates } from '@/hooks/queries/use-accounting-queries';
import { useCreateQuote, useUpdateQuote } from '@/hooks/queries/use-weldbooks-sales-queries';
import type { ProductOption } from '@/hooks/queries/use-weldbooks-tax-preview';
import type { QuoteDetail, QuoteInput } from '@/lib/api/domains/weldbooks-sales';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { addDaysToIsoDate } from '@/lib/weldbooks/format';
import { defaultTaxRateId, taxRateLabel, taxRatesFor } from '@/lib/weldbooks/tax-rate-options';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { InvoiceEditorLayout } from '../../invoices/components/invoice-editor-layout';
import { ProductPicker } from '../../invoices/components/product-picker';
import { NO_TAX_RATE } from '@/lib/weldbooks/document-tax';

const DEFAULT_VALID_DAYS = 30;

interface LineValues {
  description: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  taxRateId: string;
  productId: string;
}

interface QuoteFormValues {
  contactId: string;
  name: string;
  validFrom: string;
  validUntil: string;
  notes: string;
  paymentTerms: string;
  termsAndConditions: string;
  lines: LineValues[];
}

const emptyLine = (taxRateId: string): LineValues => ({
  description: '',
  quantity: '1',
  unitPrice: '',
  discountPercent: '',
  taxRateId,
  productId: '',
});

/** A number typed in a field: empty is allowed where `required` is false. */
function numberOf(text: string): number {
  return Number(text.trim().replace(',', '.'));
}

function isAmount(text: string, options: { min: number; max?: number; required: boolean }): boolean {
  if (text.trim() === '') return !options.required;
  const value = numberOf(text);
  return Number.isFinite(value) && value >= options.min && (options.max === undefined || value <= options.max);
}

function buildDefaults(
  quote: QuoteDetail | undefined,
  today: string,
  taxRateId: string,
  initialContactId = '',
): QuoteFormValues {
  if (!quote) {
    return {
      contactId: initialContactId,
      name: '',
      validFrom: today,
      validUntil: addDaysToIsoDate(today, DEFAULT_VALID_DAYS),
      notes: '',
      paymentTerms: '',
      termsAndConditions: '',
      lines: [emptyLine(taxRateId)],
    };
  }
  return {
    contactId: quote.contactId ?? '',
    name: quote.name ?? '',
    validFrom: quote.validFrom?.slice(0, 10) ?? '',
    validUntil: quote.validUntil?.slice(0, 10) ?? '',
    notes: quote.notes ?? '',
    paymentTerms: quote.paymentTerms ?? '',
    termsAndConditions: quote.termsAndConditions ?? '',
    lines:
      quote.lines.length > 0
        ? quote.lines.map((line) => ({
            description: line.description,
            quantity: String(line.quantity ?? 1),
            unitPrice: String(line.unitPrice),
            discountPercent: Number(line.discountPercent ?? 0) > 0 ? String(line.discountPercent) : '',
            taxRateId: line.taxRateId ?? taxRateId,
            productId: line.productId ?? '',
          }))
        : [emptyLine(taxRateId)],
  };
}

function FieldError({ id, message }: Readonly<{ id: string; message?: string }>) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs text-destructive">
      {message}
    </p>
  );
}

export function QuoteForm({
  mode,
  quote,
  initialContactId,
}: Readonly<{ mode: 'add' | 'edit'; quote?: QuoteDetail; /** The customer a new quote starts with (the contact page's "New quote"). */ initialContactId?: string }>) {
  const { t } = useI18n();
  const copy = t.weldbooksSales.quoteForm;
  const tf = t.accounting.invoiceForm;
  const router = useRouter();
  const { formatMoney, formatDate, today } = useWeldbooksFormat();
  const { data: taxRatesData } = useAccountingTaxRates();
  const taxRates = useMemo(() => taxRatesFor(taxRatesData?.data ?? [], 'sales'), [taxRatesData]);
  const defaultRateId = defaultTaxRateId(taxRatesData?.data, 'sales') ?? NO_TAX_RATE;
  const create = useCreateQuote();
  const update = useUpdateQuote();

  const schema = useMemo(
    () =>
      z.object({
        contactId: z.string().min(1, copy.contactRequired),
        name: z.string().trim().min(1, copy.nameRequired).max(200),
        validFrom: z.string(),
        validUntil: z.string(),
        notes: z.string().max(5000),
        paymentTerms: z.string().max(500),
        termsAndConditions: z.string().max(10_000),
        lines: z
          .array(
            z.object({
              description: z.string().trim().min(1, copy.descriptionRequired),
              quantity: z.string().refine((value) => isAmount(value, { min: 0, required: true }), copy.numberInvalid),
              unitPrice: z.string().refine((value) => isAmount(value, { min: 0, required: true }), copy.numberInvalid),
              discountPercent: z.string().refine((value) => isAmount(value, { min: 0, max: 100, required: false }), copy.discountInvalid),
              taxRateId: z.string(),
              productId: z.string(),
            }),
          )
          .min(1, copy.linesRequired),
      }),
    [copy],
  );

  const form = useForm<QuoteFormValues>({
    resolver: zodResolver(schema),
    defaultValues: buildDefaults(quote, today(), defaultRateId, initialContactId),
    // The submit handler below moves the focus itself: the customer picker is not a plain field.
    shouldFocusError: false,
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lines' });
  const errors = form.formState.errors;
  const watchedLines = useWatch({ control: form.control, name: 'lines' });
  const watchedName = useWatch({ control: form.control, name: 'name' });
  const watchedValidUntil = useWatch({ control: form.control, name: 'validUntil' });
  const currency = quote?.currency ?? undefined;

  const rateOf = (taxRateId: string): number => {
    const rate = taxRates.find((candidate) => candidate.id === taxRateId);
    return rate ? Number(rate.rate ?? 0) : 0;
  };
  const totals = useMemo(() => {
    let subtotal = 0;
    let tax = 0;
    const lineTotals = (watchedLines ?? []).map((line) => {
      const quantity = numberOf(line.quantity) || 0;
      const price = numberOf(line.unitPrice) || 0;
      const discount = numberOf(line.discountPercent) || 0;
      const net = quantity * price * (1 - discount / 100);
      subtotal += net;
      tax += (net * rateOf(line.taxRateId)) / 100;
      return net;
    });
    return { lineTotals, subtotal, tax, total: subtotal + tax };
    // `rateOf` reads `taxRates`, which is in the dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedLines, taxRates]);

  const selectProduct = (index: number, product: ProductOption | null) => {
    form.setValue(`lines.${index}.productId`, product?.id ?? '', { shouldDirty: true });
    if (!product) return;
    if (!form.getValues(`lines.${index}.description`)) form.setValue(`lines.${index}.description`, product.name, { shouldDirty: true });
    if (!form.getValues(`lines.${index}.unitPrice`) && typeof product.price === 'number') {
      form.setValue(`lines.${index}.unitPrice`, String(product.price), { shouldDirty: true });
    }
  };

  const payloadOf = (values: QuoteFormValues): QuoteInput => ({
    contactId: values.contactId,
    name: values.name.trim(),
    ...(currency ? { currency } : {}),
    ...(values.validFrom ? { validFrom: values.validFrom } : {}),
    ...(values.validUntil ? { validUntil: values.validUntil } : {}),
    lines: values.lines.map((line) => {
      const rate = taxRates.find((candidate) => candidate.id === line.taxRateId);
      const discount = numberOf(line.discountPercent);
      return {
        description: line.description.trim(),
        quantity: numberOf(line.quantity),
        unitPrice: numberOf(line.unitPrice),
        ...(discount > 0 ? { discountPercent: discount } : {}),
        ...(rate ? { taxRateId: rate.id, taxRate: Number(rate.rate ?? 0) } : {}),
        ...(line.productId ? { productId: line.productId } : {}),
      };
    }),
    ...(values.notes.trim() ? { notes: values.notes } : {}),
    ...(values.paymentTerms.trim() ? { paymentTerms: values.paymentTerms.trim() } : {}),
    ...(values.termsAndConditions.trim() ? { termsAndConditions: values.termsAndConditions } : {}),
  });

  const submit = form.handleSubmit(
    (values) => {
      const input = payloadOf(values);
      const failed = (error: unknown) =>
        toast.error(copy.saveFailed, {
          description: (error as { status?: number } | null)?.status === 409 ? copy.accepted : error instanceof Error ? error.message : undefined,
        });
      if (mode === 'edit' && quote) {
        update.mutate(
          { id: quote.id, input },
          {
            onSuccess: () => {
              toast.success(copy.updated);
              router.push(`/weldbooks/quotes?stack=quote:${encodeURIComponent(quote.id)}`);
            },
            onError: failed,
          },
        );
        return;
      }
      create.mutate(input, {
        onSuccess: (res) => {
          toast.success(copy.created);
          router.push(`/weldbooks/quotes?stack=quote:${encodeURIComponent(res.data.id)}`);
        },
        onError: failed,
      });
    },
    // A refused form moves the focus to the first field that needs fixing.
    (invalid) => {
      if (invalid.contactId) document.getElementById('quote-contact')?.focus();
      else if (invalid.name) form.setFocus('name');
    },
  );

  const sections = [
    {
      title: copy.who,
      icon: User,
      content: (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="quote-contact">{tf.customer}</Label>
            <Controller
              control={form.control}
              name="contactId"
              render={({ field }) => (
                <ContactPicker
                  id="quote-contact"
                  role="customer"
                  value={field.value}
                  onChange={field.onChange}
                  placeholder={tf.selectCustomer}
                  searchPlaceholder={t.accounting.customersPage.searchPlaceholder}
                  invalid={Boolean(errors.contactId)}
                  aria-describedby={errors.contactId ? 'quote-contact-error' : undefined}
                />
              )}
            />
            <FieldError id="quote-contact-error" message={errors.contactId?.message} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quote-name">{copy.name}</Label>
            <Input
              id="quote-name"
              placeholder={copy.namePlaceholder}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? 'quote-name-error' : undefined}
              {...form.register('name')}
            />
            <FieldError id="quote-name-error" message={errors.name?.message} />
          </div>
        </>
      ),
    },
    {
      title: copy.validity,
      icon: CalendarClock,
      content: (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="quote-valid-from">{copy.validFrom}</Label>
            <Input id="quote-valid-from" type="date" {...form.register('validFrom')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quote-valid-until">{copy.validUntil}</Label>
            <Input id="quote-valid-until" type="date" {...form.register('validUntil')} />
          </div>
        </div>
      ),
    },
    {
      title: tf.lineItems,
      icon: ListOrdered,
      content: (
        <>
          {fields.map((field, index) => {
            const idOf = (name: string) => `quote-line-${index}-${name}`;
            const lineErrors = errors.lines?.[index];
            return (
              <div key={field.id} className="space-y-3 rounded-md border border-border p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">{tf.itemNumber.replace('{number}', String(index + 1))}</span>
                  {fields.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      aria-label={tf.removeLine}
                      onClick={() => remove(index)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
                <ProductPicker
                  id={idOf('product')}
                  value={watchedLines?.[index]?.productId ?? ''}
                  selectedLabel={watchedLines?.[index]?.description}
                  onSelect={(product) => selectProduct(index, product)}
                />
                <div className="space-y-1.5">
                  <Label htmlFor={idOf('description')}>{tf.description}</Label>
                  <Input
                    id={idOf('description')}
                    placeholder={tf.itemDescriptionPlaceholder}
                    aria-invalid={lineErrors?.description ? true : undefined}
                    aria-describedby={lineErrors?.description ? idOf('description-error') : undefined}
                    {...form.register(`lines.${index}.description`)}
                  />
                  <FieldError id={idOf('description-error')} message={lineErrors?.description?.message} />
                </div>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <div className="space-y-1.5">
                    <Label htmlFor={idOf('quantity')}>{tf.quantity}</Label>
                    <Input
                      id={idOf('quantity')}
                      inputMode="decimal"
                      aria-invalid={lineErrors?.quantity ? true : undefined}
                      aria-describedby={lineErrors?.quantity ? idOf('quantity-error') : undefined}
                      {...form.register(`lines.${index}.quantity`)}
                    />
                    <FieldError id={idOf('quantity-error')} message={lineErrors?.quantity?.message} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={idOf('unit-price')}>{tf.unitPrice}</Label>
                    <Input
                      id={idOf('unit-price')}
                      inputMode="decimal"
                      aria-invalid={lineErrors?.unitPrice ? true : undefined}
                      aria-describedby={lineErrors?.unitPrice ? idOf('unit-price-error') : undefined}
                      {...form.register(`lines.${index}.unitPrice`)}
                    />
                    <FieldError id={idOf('unit-price-error')} message={lineErrors?.unitPrice?.message} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={idOf('discount')}>{tf.discountPercent}</Label>
                    <Input
                      id={idOf('discount')}
                      inputMode="decimal"
                      aria-invalid={lineErrors?.discountPercent ? true : undefined}
                      aria-describedby={lineErrors?.discountPercent ? idOf('discount-error') : undefined}
                      {...form.register(`lines.${index}.discountPercent`)}
                    />
                    <FieldError id={idOf('discount-error')} message={lineErrors?.discountPercent?.message} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={idOf('tax')}>{tf.taxRate}</Label>
                    <Controller
                      control={form.control}
                      name={`lines.${index}.taxRateId`}
                      render={({ field: rate }) => (
                        <Select value={rate.value || NO_TAX_RATE} onValueChange={rate.onChange}>
                          <SelectTrigger id={idOf('tax')}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NO_TAX_RATE}>{tf.noTax}</SelectItem>
                            {taxRates.map((option) => (
                              <SelectItem key={option.id} value={option.id}>
                                {taxRateLabel(option)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                </div>
                <div className="flex justify-end text-sm text-muted-foreground">
                  {tf.lineTotal} <span className="ml-1 font-medium text-foreground">{formatMoney(totals.lineTotals[index] ?? 0, currency)}</span>
                </div>
              </div>
            );
          })}
          <FieldError id="quote-lines-error" message={errors.lines?.root?.message ?? errors.lines?.message} />
          <Button type="button" variant="outline" size="sm" className="shadow-none" onClick={() => append(emptyLine(defaultRateId))}>
            <Plus className="mr-1 h-4 w-4" />
            {tf.addItem}
          </Button>
        </>
      ),
    },
    {
      title: copy.notesAndTerms,
      icon: StickyNote,
      content: (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="quote-notes">{copy.notes}</Label>
            <Textarea id="quote-notes" rows={3} placeholder={copy.notesPlaceholder} {...form.register('notes')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quote-payment-terms">{copy.paymentTerms}</Label>
            <Input id="quote-payment-terms" placeholder={copy.paymentTermsPlaceholder} {...form.register('paymentTerms')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quote-terms">{copy.terms}</Label>
            <Textarea id="quote-terms" rows={4} {...form.register('termsAndConditions')} />
          </div>
        </>
      ),
    },
  ];

  return (
    <InvoiceEditorLayout
      title={mode === 'edit' ? copy.editTitle : copy.newTitle}
      sections={sections}
      summaryFields={[
        { label: tf.subtotal, value: formatMoney(totals.subtotal, currency) },
        { label: tf.tax, value: formatMoney(totals.tax, currency) },
        { label: tf.total, value: formatMoney(totals.total, currency), bordered: true },
      ]}
      previewLabel={copy.preview}
      preview={
        <div className="mx-auto max-w-2xl space-y-4 rounded-lg border border-border bg-background p-6 shadow-sm" data-testid="quote-preview">
          <div>
            <h2 className="text-lg font-semibold">{watchedName || copy.newTitle}</h2>
            {watchedValidUntil ? <p className="text-sm text-muted-foreground">{copy.validUntilLine.replace('{date}', formatDate(watchedValidUntil))}</p> : null}
          </div>
          <ul className="m-0 list-none divide-y divide-border p-0">
            {(watchedLines ?? []).map((line, index) => (
              <li key={fields[index]?.id ?? index} className="flex justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 truncate">{line.description || '—'}</span>
                <span className="shrink-0 tabular-nums">{formatMoney(totals.lineTotals[index] ?? 0, currency)}</span>
              </li>
            ))}
          </ul>
          <p className="text-right text-base font-semibold tabular-nums">{formatMoney(totals.total, currency)}</p>
        </div>
      }
      onSubmit={(event) => void submit(event)}
      isPending={create.isPending || update.isPending}
      submitText={mode === 'edit' ? copy.save : copy.create}
      backLink="/weldbooks/quotes"
      backText={copy.back}
    />
  );
}
