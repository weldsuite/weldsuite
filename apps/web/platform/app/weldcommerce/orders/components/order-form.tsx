/**
 * The order form: a new manual (sales) order, or the edit of an existing one.
 *
 * - Customer: a CRM company and contact, plus the name, email and phone on the order.
 * - Items: catalogue products and free lines. Prices and totals come live from
 *   `POST /orders/quote` (after a pause in typing), so what is shown is what
 *   the server will charge, with each line's problem and the discount code's
 *   in words.
 * - Editing an order that is no longer `editable` (paid, fulfilled, finished)
 *   leaves the customer, items, shipping and code read-only; addresses,
 *   reference and notes can always change.
 */

import { useMemo, useRef } from 'react';
import { useForm, type FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import {
  useCreateCommerceOrder,
  useOrderQuote,
  useUpdateCommerceOrder,
  type Order,
} from '@/hooks/queries/use-commerce-orders-queries';
import { useDebounce } from '@/hooks/use-debounce';
import { formSchemaOptions } from '@/app/weldstash/lib/form';
import { getTranslations } from '@/lib/i18n';
import {
  buildOrderFormSchema,
  emptyOrderValues,
  toOrderInput,
  toOrderPatch,
  toQuoteRequest,
  valuesFromOrder,
  type OrderFormValues,
  type QuoteRequest,
} from '../../lib/order-form';
import { apiErrorInfo, orderErrorMessage } from '../../lib/orders';
import { fill } from '../../lib/text';
import { OrderAddressFields } from './order-address-fields';
import { OrderCustomerFields } from './order-customer-fields';
import { OrderLinesEditor, quotedLinesByIndex } from './order-lines-editor';
import { OrderQuoteSummary, discountProblemText } from './order-quote-summary';

function Section({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <section className="grid gap-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** The quote request as the pause-free text the debounce watches. */
function useQuoteRequest(values: OrderFormValues, enabled: boolean): QuoteRequest | null {
  const request = useMemo(() => (enabled ? toQuoteRequest(values) : null), [enabled, values]);
  const key = JSON.stringify(request);
  const debouncedKey = useDebounce(key, 400);
  return useMemo(() => JSON.parse(debouncedKey) as QuoteRequest | null, [debouncedKey]);
}

interface OrderFormProps {
  /** The order being edited; none for a new order. */
  order?: Order;
  defaultCurrency: string;
  onSaved: (id: string) => void;
  onCancel: () => void;
}

export function OrderForm({ order, defaultCurrency, onSaved, onCancel }: Readonly<OrderFormProps>) {
  const t = getTranslations('commerce').orders;
  const tf = t.form;
  const common = getTranslations('common');
  const isEdit = order !== undefined;
  // Items, customer, shipping and the code are locked once the order is paid, fulfilled or finished.
  const locked = isEdit && !order.editable;

  const create = useCreateCommerceOrder();
  const update = useUpdateCommerceOrder();

  const schema = useMemo(() => buildOrderFormSchema(), []);
  const form = useForm<OrderFormValues>({
    resolver: zodResolver(schema, formSchemaOptions()),
    defaultValues: order ? valuesFromOrder(order) : emptyOrderValues(defaultCurrency),
  });
  const values = form.watch();

  const quoteRequest = useQuoteRequest(values, !locked);
  const quoteQuery = useOrderQuote(quoteRequest?.input ?? null);
  const quote = quoteRequest ? quoteQuery.data?.data : undefined;
  const quotedLines = useMemo(() => quotedLinesByIndex(quote, quoteRequest?.lineIndexes ?? []), [quote, quoteRequest]);
  const discountProblem = discountProblemText(quote?.discountProblem);
  const currency = (values.currency.trim() || defaultCurrency).toUpperCase();

  const fail = (err: unknown) => {
    const info = apiErrorInfo(err);
    if (info.code === 'DISCOUNT_NOT_APPLICABLE') {
      const reason = typeof info.details?.reason === 'string' ? info.details.reason : null;
      const message = discountProblemText(reason) ?? t.errors.discountNotApplicable;
      form.setError('discountCode', { message }, { shouldFocus: true });
      return;
    }
    toast.error(orderErrorMessage(err, isEdit ? getTranslations('commerce').common.saveFailed : tf.createFailed));
  };

  const copyBillingToShipping = () => {
    form.setValue('shippingAddress', { ...form.getValues('billingAddress') }, { shouldDirty: true });
  };

  const onSubmit = async (submitted: OrderFormValues) => {
    try {
      if (order) {
        await update.mutateAsync({ id: order.id, data: toOrderPatch(submitted, order) });
        toast.success(t.actions.toastUpdated);
        onSaved(order.id);
      } else {
        const res = await create.mutateAsync(toOrderInput(submitted));
        toast.success(fill(tf.toastCreated, { number: res.data.orderNumber }));
        onSaved(res.data.id);
      }
    } catch (err) {
      fail(err);
    }
  };

  const submitting = form.formState.isSubmitting;
  const formElement = useRef<HTMLFormElement>(null);

  // A failed submit moves focus to the first invalid field (react-hook-form does that); an order
  // with no items has no field to focus, so focus goes to Add product.
  const onInvalid = (errors: FieldErrors<OrderFormValues>) => {
    if (errors.items && !Array.isArray(errors.items)) formElement.current?.querySelector<HTMLElement>('[data-add-line]')?.focus();
  };

  return (
    <Form {...form}>
      <form ref={formElement} onSubmit={form.handleSubmit(onSubmit, onInvalid)} noValidate className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 gap-8">
          {locked && <InfoBanner variant="info">{t.actions.notEditable}</InfoBanner>}

          <Section title={tf.sectionCustomer}>
            <OrderCustomerFields disabled={locked} />
          </Section>

          <Section title={tf.sectionItems}>
            <OrderLinesEditor quoted={quotedLines} currency={currency} disabled={locked} />
          </Section>

          <Section title={tf.sectionAddresses}>
            <div className="grid gap-6 md:grid-cols-2">
              <OrderAddressFields name="billingAddress" />
              <div className="grid content-start gap-2">
                <OrderAddressFields name="shippingAddress" />
                <div>
                  <Button type="button" variant="ghost" size="sm" onClick={copyBillingToShipping}>
                    {t.address.copyToShipping}
                  </Button>
                </div>
              </div>
            </div>
          </Section>

          <Section title={tf.sectionNotes}>
            <FormField
              control={form.control}
              name="customerReference"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tf.customerReference}</FormLabel>
                  <FormControl>
                    <Input {...field} autoComplete="off" maxLength={255} />
                  </FormControl>
                  <FormDescription>{tf.customerReferenceHint}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-3 md:grid-cols-2">
              <FormField
                control={form.control}
                name="customerNote"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.customerNote}</FormLabel>
                    <FormControl>
                      <Textarea {...field} rows={3} maxLength={5000} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="internalNote"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.internalNote}</FormLabel>
                    <FormControl>
                      <Textarea {...field} rows={3} maxLength={5000} />
                    </FormControl>
                    <FormDescription>{tf.internalNoteHint}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </Section>
        </div>

        <aside className="grid content-start gap-6 lg:sticky lg:top-4 lg:self-start">
          <Section title={tf.sectionExtras}>
            <FormField
              control={form.control}
              name="currency"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tf.currency}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      onChange={(event) => field.onChange(event.target.value.toUpperCase())}
                      maxLength={3}
                      autoComplete="off"
                      spellCheck={false}
                      className="uppercase"
                      disabled={isEdit}
                    />
                  </FormControl>
                  <FormDescription>{tf.currencyHint}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="discountCode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tf.discountCode}</FormLabel>
                  <FormControl>
                    <Input {...field} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={locked} />
                  </FormControl>
                  {discountProblem && values.discountCode.trim() !== '' && (
                    <p role="status" className="text-sm text-destructive">
                      {discountProblem}
                    </p>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="shippingTotal"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tf.shippingTotal}</FormLabel>
                  <FormControl>
                    <Input {...field} inputMode="decimal" autoComplete="off" disabled={locked} />
                  </FormControl>
                  <FormDescription>{tf.shippingHint}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </Section>

          <Section title={tf.sectionVat}>
            <FormField
              control={form.control}
              name="pricesIncludeTax"
              render={({ field }) => (
                <FormItem className="flex items-start gap-3">
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} disabled={locked} />
                  </FormControl>
                  <div className="grid gap-0.5">
                    <FormLabel>{tf.pricesIncludeTax}</FormLabel>
                    <FormDescription>{tf.pricesIncludeTaxHint}</FormDescription>
                  </div>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="buyerVatNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tf.buyerVatNumber}</FormLabel>
                  <FormControl>
                    <Input {...field} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={50} disabled={locked} />
                  </FormControl>
                  <FormDescription>{tf.buyerVatNumberHint}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <p className="text-xs text-muted-foreground">{tf.vatAddressHint}</p>
          </Section>

          {!locked && (
            <OrderQuoteSummary
              quote={quote}
              currency={currency}
              isFetching={quoteQuery.isFetching}
              isError={quoteQuery.isError}
              hasItems={quoteRequest !== null}
            />
          )}

          {!isEdit && (
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem className="flex items-start gap-3">
                  <FormControl>
                    <Switch checked={field.value === 'confirmed'} onCheckedChange={(on) => field.onChange(on ? 'confirmed' : 'pending')} />
                  </FormControl>
                  <div className="grid gap-0.5">
                    <FormLabel>{tf.confirmedOnCreate}</FormLabel>
                    <FormDescription>{tf.confirmedOnCreateHint}</FormDescription>
                  </div>
                </FormItem>
              )}
            />
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              {common.actions.cancel}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {isEdit ? common.actions.save : tf.create}
            </Button>
          </div>
        </aside>
      </form>
    </Form>
  );
}
