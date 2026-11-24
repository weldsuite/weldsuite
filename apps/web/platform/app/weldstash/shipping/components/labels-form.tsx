/**
 * The form of the "Create labels" dialog: carrier account, product, pieces,
 * the product's options, a service point, the recipient, customs and, on
 * WeldSuite's contract, the price.
 */

import { useEffect, useMemo, useState } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { DialogFooter } from '@weldsuite/ui/components/dialog';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';
import { Form } from '@weldsuite/ui/components/form';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import {
  CUSTOMS_CONTENT_TYPES,
  type CarrierAccount,
  type CreateLabelsResult,
  type PickListShipping,
  type ServicePointChoice,
} from '@weldsuite/app-api-client/schemas/shipping';
import { useCarrierProducts, useCarrierQuote, useCreateLabels } from '@/hooks/queries/use-shipping-queries';
import { useDebounce } from '@/hooks/use-debounce';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import {
  BOOLEAN_OPTION_KEYS,
  buildLabelsInput,
  buildQuoteInput,
  emptyCustomsLine,
  emptyPiece,
  makeLabelsFormSchema,
  shippingToFormValues,
  supportsReturn,
  type LabelsFormValues,
} from '../lib/labels-form';
import { AddressFields, CheckboxField, SelectField, TextField } from './form-fields';
import { ServicePointPicker } from './service-point-picker';
import { ShippingErrorNotice } from './shipping-error-notice';

interface LabelsFormProps {
  pickListId: string;
  shipping: PickListShipping;
  carriers: CarrierAccount[];
  onCreated: (result: CreateLabelsResult) => void;
  onCancel: () => void;
}

function Section({ legend, children }: Readonly<{ legend: string; children: React.ReactNode }>) {
  return (
    <fieldset className="space-y-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">{legend}</legend>
      {children}
    </fieldset>
  );
}

export function LabelsForm({ pickListId, shipping, carriers, onCreated, onCancel }: Readonly<LabelsFormProps>) {
  const t = getTranslations('weldstash').shipping.labels;
  const ts = getTranslations('weldstash').shipping;
  const router = useRouter();
  const createLabels = useCreateLabels();
  const [servicePoint, setServicePoint] = useState<ServicePointChoice | null>(shipping.servicePoint);
  const [servicePointInvalid, setServicePointInvalid] = useState(false);

  const activeCarriers = useMemo(() => carriers.filter((c) => c.isActive), [carriers]);

  const schema = useMemo(
    () =>
      makeLabelsFormSchema(
        { required: t.required, invalidWeight: t.invalidWeight, invalidNumber: t.invalidNumber, invalidQuantity: t.invalidQuantity },
        { customsRequired: shipping.customsRequired },
      ),
    [t, shipping.customsRequired],
  );

  const defaults = useMemo(() => {
    const values = shippingToFormValues(shipping);
    const preferred = activeCarriers.find((c) => c.id === shipping.defaultCarrierId) ?? activeCarriers.find((c) => c.isDefault) ?? activeCarriers[0];
    return { ...values, carrierId: preferred?.id ?? '' };
    // The form starts from what the server sent once; later refetches must not overwrite typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const form = useForm<LabelsFormValues>({ resolver: zodResolver(schema), defaultValues: defaults });
  const pieces = useFieldArray({ control: form.control, name: 'pieces' });
  const lines = useFieldArray({ control: form.control, name: 'customs.lines' });
  const values = useWatch({ control: form.control }) as LabelsFormValues;

  const carrier = carriers.find((c) => c.id === values.carrierId);
  const country = (values.recipient?.country ?? '').trim().toUpperCase();
  const business = (values.recipient?.company ?? '').trim() !== '';
  const lookup = useDebounce({ country, business }, 400);

  const productsQuery = useCarrierProducts(values.carrierId || undefined, { toCountry: lookup.country, business: lookup.business }, lookup.country.length === 2);
  const products = useMemo(() => productsQuery.data ?? [], [productsQuery.data]);
  const product = products.find((p) => p.code === values.product);

  // Keep the chosen product valid for the carrier and destination: the carrier's default first.
  useEffect(() => {
    if (!productsQuery.data) return;
    if (products.some((p) => p.code === form.getValues('product'))) return;
    const preferred = products.find((p) => p.code === carrier?.settings.defaultProduct) ?? products[0];
    form.setValue('product', preferred?.code ?? '');
  }, [productsQuery.data, products, carrier?.settings.defaultProduct, form]);

  // A service point belongs to one carrier and destination.
  const carrierKey = `${values.carrierId}|${country}`;
  const [lastCarrierKey, setLastCarrierKey] = useState(carrierKey);
  useEffect(() => {
    if (carrierKey === lastCarrierKey) return;
    setLastCarrierKey(carrierKey);
    setServicePoint(null);
  }, [carrierKey, lastCarrierKey]);

  const quoteBody = useDebounce(useMemo(() => buildQuoteInput(values, product), [values, product]), 500);
  const quote = useCarrierQuote(carrier?.contract === 'weldsuite' ? carrier.id : undefined, quoteBody);

  const listed = new Set(product?.options ?? []);
  const optionKeys = BOOLEAN_OPTION_KEYS.filter((key) => listed.has(key));
  const showReturn = supportsReturn(product);

  const onSubmit = form.handleSubmit(async (formValues) => {
    if (product?.servicePoint && !servicePoint) {
      setServicePointInvalid(true);
      return;
    }
    setServicePointInvalid(false);
    try {
      const result = await createLabels.mutateAsync({
        pickListId,
        data: buildLabelsInput(formValues, { product, servicePoint, customsRequired: shipping.customsRequired }),
      });
      toast.success(t.created);
      onCreated(result);
    } catch {
      // The notice below the form shows the error.
    }
  });

  if (activeCarriers.length === 0) {
    return (
      <div className="space-y-4">
        <InfoBanner
          variant="warning"
          title={t.noCarrierTitle}
          action={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                try {
                  sessionStorage.setItem('settings-return-url', window.location.pathname);
                } catch {
                  // Private mode: the Settings back button then goes to its default.
                }
                router.push('/settings/apps/weldstash');
              }}
            >
              {t.noCarrierLink}
            </Button>
          }
        >
          {t.noCarrierBody}
        </InfoBanner>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t.close}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  const carrierOptions = activeCarriers.map((c) => ({ value: c.id, label: `${c.name} (${ts.contracts[c.contract]})` }));
  const productOptions = products.map((p) => ({ value: p.code, label: p.name }));
  const contentOptions = CUSTOMS_CONTENT_TYPES.map((c) => ({ value: c, label: ts.customsContent[c] }));

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Section legend={t.carrier}>
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField control={form.control} name="carrierId" label={t.carrier} options={carrierOptions} required />
            <SelectField
              control={form.control}
              name="product"
              label={t.product}
              options={productOptions}
              required
              disabled={productsQuery.isLoading || products.length === 0}
              placeholder={productsQuery.isLoading ? t.productLoading : undefined}
            />
          </div>
          {productsQuery.isError ? <ErrorBanner error={(productsQuery.error as Error).message || t.productLoadError} /> : null}
          {productsQuery.isSuccess && products.length === 0 ? <p className="text-sm text-muted-foreground">{t.productEmpty}</p> : null}
        </Section>

        <Section legend={t.pieces}>
          <p className="text-sm text-muted-foreground">{t.dimensionsHint}</p>
          {pieces.fields.map((field, index) => {
            const number = index + 1;
            return (
              <div key={field.id} className="grid grid-cols-2 items-end gap-3 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
                <TextField control={form.control} name={`pieces.${index}.weightKg`} label={`${t.piece.replace('{number}', String(number))}: ${t.weightKg}`} inputMode="decimal" required />
                <TextField control={form.control} name={`pieces.${index}.lengthCm`} label={t.lengthCm} inputMode="decimal" />
                <TextField control={form.control} name={`pieces.${index}.widthCm`} label={t.widthCm} inputMode="decimal" />
                <TextField control={form.control} name={`pieces.${index}.heightCm`} label={t.heightCm} inputMode="decimal" />
                {pieces.fields.length > 1 ? (
                  <Button type="button" variant="ghost" size="icon" onClick={() => pieces.remove(index)} aria-label={t.removePiece.replace('{number}', String(number))}>
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            );
          })}
          {product?.multiCollo ? (
            <Button type="button" size="sm" variant="outline" onClick={() => pieces.append(emptyPiece())}>
              <Plus className="size-4" aria-hidden="true" />
              {t.addPiece}
            </Button>
          ) : null}
        </Section>

        {optionKeys.length > 0 || listed.has('insurance') || showReturn ? (
          <Section legend={t.options}>
            <div className="grid gap-2 sm:grid-cols-2">
              {optionKeys.map((key) => (
                <CheckboxField key={key} control={form.control} name={key} label={ts.options[key]} />
              ))}
              {showReturn ? <CheckboxField control={form.control} name="returnLabel" label={t.returnLabel} /> : null}
            </div>
            {listed.has('insurance') ? (
              <TextField className="max-w-48" control={form.control} name="insuredValue" label={t.insuredValue} inputMode="decimal" />
            ) : null}
          </Section>
        ) : null}

        {product?.servicePoint ? (
          <Section legend={t.servicePoint}>
            <p className="text-sm text-muted-foreground">{t.servicePointHint}</p>
            <ServicePointPicker
              key={carrierKey}
              carrierId={values.carrierId}
              country={country}
              defaultPostalCode={values.recipient?.postalCode ?? ''}
              defaultHouseNumber={values.recipient?.houseNumber ?? ''}
              value={servicePoint}
              onChange={(choice) => {
                setServicePoint(choice);
                if (choice) setServicePointInvalid(false);
              }}
              invalid={servicePointInvalid}
            />
            {servicePointInvalid ? <p role="alert" className="text-sm text-destructive">{t.servicePointRequired}</p> : null}
          </Section>
        ) : null}

        <Section legend={t.recipient}>
          <AddressFields control={form.control} prefix="recipient" section="shipping" required />
        </Section>

        {shipping.customsRequired ? (
          <Section legend={t.customs}>
            <p className="text-sm text-muted-foreground">{t.customsHint}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <SelectField control={form.control} name="customs.content" label={t.customsContent} options={contentOptions} required />
              <TextField control={form.control} name="customs.invoiceNumber" label={t.invoiceNumber} />
              <TextField control={form.control} name="customs.currency" label={t.currency} required />
            </div>
            <p className="text-sm font-medium">{t.customsLines}</p>
            {lines.fields.map((field, index) => {
              const number = index + 1;
              return (
                <div key={field.id} className="grid grid-cols-6 items-end gap-3 rounded-md border p-3">
                  <TextField className="col-span-6 sm:col-span-3" control={form.control} name={`customs.lines.${index}.description`} label={t.lineDescription} required />
                  <TextField className="col-span-2 sm:col-span-1" control={form.control} name={`customs.lines.${index}.quantity`} label={t.lineQuantity} inputMode="numeric" required />
                  <TextField className="col-span-2 sm:col-span-1" control={form.control} name={`customs.lines.${index}.value`} label={t.lineValue} inputMode="decimal" required />
                  <TextField className="col-span-2 sm:col-span-1" control={form.control} name={`customs.lines.${index}.weightGrams`} label={t.lineWeightGrams} inputMode="numeric" />
                  <TextField className="col-span-3 sm:col-span-2" control={form.control} name={`customs.lines.${index}.hsCode`} label={t.lineHsCode} inputMode="numeric" />
                  <TextField className="col-span-3 sm:col-span-2" control={form.control} name={`customs.lines.${index}.originCountry`} label={t.lineOrigin} required />
                  <div className="col-span-6 flex justify-end sm:col-span-2">
                    {lines.fields.length > 1 ? (
                      <Button type="button" variant="ghost" size="icon" onClick={() => lines.remove(index)} aria-label={t.removeLine.replace('{number}', String(number))}>
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
            <Button type="button" size="sm" variant="outline" onClick={() => lines.append(emptyCustomsLine())}>
              <Plus className="size-4" aria-hidden="true" />
              {t.addLine}
            </Button>
          </Section>
        ) : null}

        {carrier?.contract === 'weldsuite' ? (
          <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-4 py-3 text-sm" aria-live="polite">
            <div>
              <p className="font-medium">{t.price}</p>
              <p className="text-xs text-muted-foreground">{t.priceHint}</p>
            </div>
            <p className="font-medium tabular-nums">
              {quote.isFetching ? (
                <span className="flex items-center gap-2 text-muted-foreground">
                  <InlineSpinner /> {t.priceLoading}
                </span>
              ) : quote.data?.credits !== null && quote.data?.credits !== undefined ? (
                t.priceCredits.replace('{credits}', new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(quote.data.credits))
              ) : quote.isError ? (
                <span className="text-destructive">{t.priceUnavailable}</span>
              ) : (
                '—'
              )}
            </p>
          </div>
        ) : null}

        {createLabels.isError ? <ShippingErrorNotice error={createLabels.error} title={t.createFailed} /> : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t.cancel}
          </Button>
          <Button type="submit" disabled={createLabels.isPending || productsQuery.isLoading}>
            {createLabels.isPending ? <InlineSpinner /> : null}
            {createLabels.isPending ? t.submitting : t.submit}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
