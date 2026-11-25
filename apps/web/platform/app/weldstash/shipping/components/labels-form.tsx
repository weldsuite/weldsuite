/**
 * The form of the "Create labels" dialog: carrier account, product, pieces,
 * the product's options, a service point, the recipient, customs and, on
 * WeldSuite's contract, the price.
 */

import { useEffect, useMemo, useState } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { DialogFooter } from '@weldsuite/ui/components/dialog';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';
import { Form } from '@weldsuite/ui/components/form';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import type {
  CarrierAccount,
  CarrierProduct,
  CreateLabelsResult,
  PickListShipping,
  ServicePointChoice,
} from '@weldsuite/app-api-client/schemas/shipping';
import { useCarrierProducts, useCarrierQuote, useCreateLabels } from '@/hooks/queries/use-shipping-queries';
import { useDebounce } from '@/hooks/use-debounce';
import { getTranslations } from '@/lib/i18n';
import {
  BOOLEAN_OPTION_KEYS,
  buildLabelsInput,
  buildQuoteInput,
  makeLabelsFormSchema,
  shippingToFormValues,
  supportsReturn,
  type LabelsFormValues,
} from '../lib/labels-form';
import { AddressFields, SelectField } from './form-fields';
import { CustomsSection, NoCarriers, OptionsSection, PiecesSection, PriceRow, Section } from './labels-form-sections';
import { ServicePointPicker } from './service-point-picker';
import { ShippingErrorNotice } from './shipping-error-notice';

interface LabelsFormProps {
  pickListId: string;
  shipping: PickListShipping;
  carriers: CarrierAccount[];
  onCreated: (result: CreateLabelsResult) => void;
  onCancel: () => void;
}

/** The account the form starts on: the order's carrier, the default, else the first. */
function preferredCarrier(active: CarrierAccount[], defaultCarrierId: string | null | undefined): CarrierAccount | undefined {
  return active.find((c) => c.id === defaultCarrierId) ?? active.find((c) => c.isDefault) ?? active[0];
}

/** The product to pick when the chosen one is not offered: the carrier's default first. */
function preferredProduct(products: CarrierProduct[], defaultProduct: unknown): CarrierProduct | undefined {
  return products.find((p) => p.code === defaultProduct) ?? products[0];
}

export function LabelsForm(props: Readonly<LabelsFormProps>) {
  const activeCarriers = useMemo(() => props.carriers.filter((c) => c.isActive), [props.carriers]);
  if (activeCarriers.length === 0) return <NoCarriers onCancel={props.onCancel} />;
  return <LabelsFormBody {...props} activeCarriers={activeCarriers} />;
}

function LabelsFormBody({ pickListId, shipping, carriers, activeCarriers, onCreated, onCancel }: Readonly<LabelsFormProps & { activeCarriers: CarrierAccount[] }>) {
  const ts = getTranslations('weldstash').shipping;
  const t = ts.labels;
  const createLabels = useCreateLabels();
  const [servicePoint, setServicePoint] = useState<ServicePointChoice | null>(shipping.servicePoint);
  const [servicePointInvalid, setServicePointInvalid] = useState(false);

  const schema = useMemo(
    () =>
      makeLabelsFormSchema(
        { required: t.required, invalidWeight: t.invalidWeight, invalidNumber: t.invalidNumber, invalidQuantity: t.invalidQuantity },
        { customsRequired: shipping.customsRequired },
      ),
    [t, shipping.customsRequired],
  );

  const defaults = useMemo(
    () => ({ ...shippingToFormValues(shipping), carrierId: preferredCarrier(activeCarriers, shipping.defaultCarrierId)?.id ?? '' }),
    // The form starts from what the server sent once; later refetches must not overwrite typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

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
  const defaultProduct = carrier?.settings.defaultProduct;

  // Keep the chosen product valid for the carrier and destination.
  useEffect(() => {
    if (!productsQuery.data) return;
    if (products.some((p) => p.code === form.getValues('product'))) return;
    form.setValue('product', preferredProduct(products, defaultProduct)?.code ?? '');
  }, [productsQuery.data, products, defaultProduct, form]);

  // A service point belongs to one carrier and destination.
  const carrierKey = `${values.carrierId}|${country}`;
  const [lastCarrierKey, setLastCarrierKey] = useState(carrierKey);
  useEffect(() => {
    if (carrierKey === lastCarrierKey) return;
    setLastCarrierKey(carrierKey);
    setServicePoint(null);
  }, [carrierKey, lastCarrierKey]);

  const onWeldsuiteContract = carrier?.contract === 'weldsuite';
  const quoteBody = useDebounce(useMemo(() => buildQuoteInput(values, product), [values, product]), 500);
  const quote = useCarrierQuote(onWeldsuiteContract ? carrier.id : undefined, quoteBody);

  const listed = new Set(product?.options ?? []);
  const optionKeys = BOOLEAN_OPTION_KEYS.filter((key) => listed.has(key));
  const needsServicePoint = !!product?.servicePoint;

  const onSubmit = form.handleSubmit(async (formValues) => {
    if (needsServicePoint && !servicePoint) {
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

  const carrierOptions = activeCarriers.map((c) => ({ value: c.id, label: `${c.name} (${ts.contracts[c.contract]})` }));
  const productOptions = products.map((p) => ({ value: p.code, label: p.name }));
  const noProducts = productsQuery.isSuccess && products.length === 0;

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
          {noProducts ? <p className="text-sm text-muted-foreground">{t.productEmpty}</p> : null}
        </Section>

        <PiecesSection control={form.control} pieces={pieces} multiCollo={!!product?.multiCollo} />

        <OptionsSection control={form.control} optionKeys={optionKeys} insurance={listed.has('insurance')} showReturn={supportsReturn(product)} />

        {needsServicePoint ? (
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

        {shipping.customsRequired ? <CustomsSection control={form.control} lines={lines} /> : null}

        {onWeldsuiteContract ? <PriceRow fetching={quote.isFetching} credits={quote.data?.credits} failed={quote.isError} /> : null}

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
