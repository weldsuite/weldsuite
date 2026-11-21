/**
 * Create and edit form for a sales channel: name, type, audience, status,
 * currency and VAT mode, and for a storefront its selling countries (EU
 * member states), guest checkout and payment methods. The API's refusals
 * land where they belong: `CHANNEL_INCOMPLETE` lists what an active
 * storefront still needs, `CURRENCY_LOCKED` sits on the currency field.
 */

import { useMemo, useState } from 'react';
import { useForm, useFormContext } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { MultiSelect } from '@weldsuite/ui/components/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  useCreateCommerceChannel,
  useUpdateCommerceChannel,
  type ChannelPaymentMethod,
  type CommerceChannel,
} from '@/hooks/queries/use-commerce-channels-queries';
import { useCommerceSettings } from '@/hooks/queries/use-commerce-orders-queries';
import { formSchemaOptions } from '@/app/weldstash/lib/form';
import { getTranslations } from '@/lib/i18n';
import {
  CHANNEL_AUDIENCES,
  CHANNEL_FORM_STATUSES,
  CHANNEL_PAYMENT_METHODS,
  CREATABLE_CHANNEL_TYPES,
  buildChannelFormSchema,
  channelAudienceLabel,
  channelStatusLabel,
  channelTypeLabel,
  countryOptions,
  defaultPricesIncludeTax,
  emptyChannelValues,
  isConnectorChannel,
  isStorefront,
  missingFields,
  paymentMethodLabel,
  toChannelInput,
  valuesFromChannel,
  type ChannelFormValues,
} from '@/app/weldcommerce/lib/channels';
import { apiErrorInfo, hasErrorCode } from '@/app/weldcommerce/lib/orders';
import { errorMessage } from '@/app/weldcommerce/lib/text';

function SwitchField({
  name,
  label,
  hint,
}: Readonly<{ name: 'pricesIncludeTax' | 'guestCheckout'; label: string; hint: string }>) {
  const form = useFormContext<ChannelFormValues>();
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem className="flex items-center justify-between gap-6 space-y-0">
          <div className="space-y-1">
            <FormLabel>{label}</FormLabel>
            <FormDescription>{hint}</FormDescription>
          </div>
          <FormControl>
            <Switch checked={field.value} onCheckedChange={field.onChange} />
          </FormControl>
        </FormItem>
      )}
    />
  );
}

function SelectField({
  name,
  label,
  values,
  labelOf,
  disabled,
  onChange,
}: Readonly<{
  name: 'type' | 'audience' | 'status';
  label: string;
  values: readonly string[];
  labelOf: (value: never) => string;
  disabled?: boolean;
  onChange?: (value: string) => void;
}>) {
  const form = useFormContext<ChannelFormValues>();
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <Select
            value={field.value}
            disabled={disabled}
            onValueChange={(value) => {
              field.onChange(value);
              onChange?.(value);
            }}
          >
            <FormControl>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {values.map((value) => (
                <SelectItem key={value} value={value}>
                  {labelOf(value as never)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function PaymentMethodFields() {
  const t = getTranslations('commerce').channels.form;
  const form = useFormContext<ChannelFormValues>();
  const audience = form.watch('audience');
  const selected = form.watch('paymentMethods');

  const toggle = (method: ChannelPaymentMethod, checked: boolean) => {
    const next = checked ? [...selected, method] : selected.filter((m) => m !== method);
    form.setValue('paymentMethods', next, { shouldDirty: true });
  };

  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-medium">{t.paymentMethods}</legend>
      {CHANNEL_PAYMENT_METHODS.map((method) => {
        const disabled = method === 'invoice' && audience !== 'b2b';
        const id = `channel-payment-${method}`;
        return (
          <div key={method} className="flex items-start gap-2">
            <Checkbox
              id={id}
              checked={selected.includes(method) && !disabled}
              disabled={disabled}
              onCheckedChange={(checked) => toggle(method, checked === true)}
              className="mt-0.5"
            />
            <label htmlFor={id} className="text-sm leading-snug">
              {paymentMethodLabel(method)}
              {method === 'invoice' && <span className="block text-xs text-muted-foreground">{t.invoiceOnlyB2b}</span>}
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}

function StorefrontFields() {
  const t = getTranslations('commerce').channels.form;
  const form = useFormContext<ChannelFormValues>();
  const options = useMemo(() => countryOptions(), []);
  return (
    <>
      <FormField
        control={form.control}
        name="sellingCountries"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t.sellingCountries}</FormLabel>
            <FormControl>
              <MultiSelect
                modal
                options={options}
                value={field.value}
                onChange={field.onChange}
                placeholder={t.sellingCountriesPlaceholder}
                aria-label={t.sellingCountries}
                searchPlaceholder={t.searchCountries}
                emptyText={t.noCountries}
                maxDisplay={6}
              />
            </FormControl>
            <FormDescription>{t.sellingCountriesHint}</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <SwitchField name="guestCheckout" label={t.guestCheckout} hint={t.guestCheckoutHint} />
      <PaymentMethodFields />
    </>
  );
}

function CommerceFields({ isEdit }: Readonly<{ isEdit: boolean }>) {
  const t = getTranslations('commerce').channels.form;
  const form = useFormContext<ChannelFormValues>();
  const type = form.watch('type');

  const onAudienceChange = (audience: string) => {
    // The VAT mode follows the audience until the member sets it themselves.
    if (!form.formState.dirtyFields.pricesIncludeTax) {
      form.setValue('pricesIncludeTax', defaultPricesIncludeTax(audience === 'b2b' ? 'b2b' : 'b2c'));
    }
    if (audience !== 'b2b') {
      form.setValue(
        'paymentMethods',
        form.getValues('paymentMethods').filter((m) => m !== 'invoice'),
        { shouldDirty: true },
      );
    }
  };

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          name="type"
          label={t.type}
          values={isEdit ? [type] : CREATABLE_CHANNEL_TYPES}
          labelOf={channelTypeLabel}
          disabled={isEdit}
        />
        <SelectField name="audience" label={t.audience} values={CHANNEL_AUDIENCES} labelOf={channelAudienceLabel} onChange={onAudienceChange} />
      </div>
      <FormField
        control={form.control}
        name="currency"
        render={({ field }) => (
          <FormItem className="sm:max-w-xs">
            <FormLabel>{t.currency}</FormLabel>
            <FormControl>
              <Input
                {...field}
                onChange={(event) => field.onChange(event.target.value.toUpperCase())}
                maxLength={3}
                autoComplete="off"
                spellCheck={false}
                className="uppercase"
              />
            </FormControl>
            <FormDescription>{t.currencyHint}</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <SwitchField name="pricesIncludeTax" label={t.pricesIncludeTax} hint={t.pricesIncludeTaxHint} />
      {isStorefront(type) && <StorefrontFields />}
    </>
  );
}

export function ChannelDialog({
  open,
  onOpenChange,
  channel,
  onSaved,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel?: CommerceChannel;
  /** The new channel's id after a create. */
  onSaved?: (id: string | null) => void;
}>) {
  const t = getTranslations('commerce');
  const tc = t.channels;
  const common = getTranslations('common');
  const isEdit = !!channel;
  const create = useCreateCommerceChannel();
  const update = useUpdateCommerceChannel();
  const settings = useCommerceSettings();
  const schema = useMemo(() => buildChannelFormSchema(), []);
  const [missing, setMissing] = useState<string[]>([]);

  const form = useForm<ChannelFormValues>({
    resolver: zodResolver(schema, formSchemaOptions()),
    defaultValues: channel ? valuesFromChannel(channel) : emptyChannelValues(settings.data?.data.defaultCurrency ?? 'EUR'),
  });
  const connector = channel ? isConnectorChannel(channel.type) : false;
  const statuses = channel?.status === 'archived' ? [...CHANNEL_FORM_STATUSES, 'archived' as const] : CHANNEL_FORM_STATUSES;

  const onSubmit = async (values: ChannelFormValues) => {
    setMissing([]);
    try {
      if (channel) {
        await update.mutateAsync({ id: channel.id, data: toChannelInput(values, 'edit') });
        toast.success(tc.toastUpdated);
        onSaved?.(null);
      } else {
        const res = await create.mutateAsync(toChannelInput(values, 'create'));
        toast.success(tc.toastCreated);
        onSaved?.(res.data.id);
      }
      onOpenChange(false);
    } catch (err) {
      const info = apiErrorInfo(err);
      if (hasErrorCode(err, 'CHANNEL_INCOMPLETE')) {
        setMissing(missingFields(info.details));
        return;
      }
      if (hasErrorCode(err, 'CURRENCY_LOCKED')) {
        form.setError('currency', { message: tc.form.currencyLocked }, { shouldFocus: true });
        return;
      }
      toast.error(errorMessage(err, t.common.saveFailed));
    }
  };

  const submitting = form.formState.isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{isEdit ? tc.editTitle : tc.newTitle}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-5">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tc.form.name}</FormLabel>
                  <FormControl>
                    <Input {...field} required maxLength={255} autoComplete="off" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {connector ? <InfoBanner variant="info">{tc.form.connectorHint}</InfoBanner> : <CommerceFields isEdit={isEdit} />}

            <SelectField name="status" label={tc.form.status} values={statuses} labelOf={channelStatusLabel} />

            {missing.length > 0 && (
              <InfoBanner variant="warning">
                {tc.form.incomplete}
                <ul className="mt-1 list-disc pl-5">
                  {missing.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </InfoBanner>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {common.actions.cancel}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {isEdit ? common.actions.save : common.actions.create}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
