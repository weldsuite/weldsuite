/**
 * Create and edit form for a shipping rate: the zone it belongs to (a name
 * and countries, limited to what the channel sells in), the rate's name, its
 * price in the channel's currency, and the order subtotal from which
 * shipping is free.
 */

import { useMemo } from 'react';
import { useForm, useFormContext } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { MultiSelect } from '@weldsuite/ui/components/multi-select';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  useCreateShippingRate,
  useUpdateShippingRate,
  type CommerceChannel,
  type ShippingRate,
} from '@/hooks/queries/use-commerce-channels-queries';
import { formSchemaOptions } from '@/app/weldstash/lib/form';
import { getTranslations } from '@/lib/i18n';
import {
  buildShippingRateFormSchema,
  countryOptions,
  emptyShippingRateValues,
  toShippingRateInput,
  valuesFromShippingRate,
  type ShippingRateFormValues,
} from '@/app/weldcommerce/lib/channels';
import { errorMessage } from '@/app/weldcommerce/lib/text';

function MoneyField({
  name,
  label,
  hint,
  currency,
}: Readonly<{ name: 'price' | 'freeShippingThreshold'; label: string; hint?: string; currency: string }>) {
  const form = useFormContext<ShippingRateFormValues>();
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>
            {label} <span className="font-normal text-muted-foreground">({currency})</span>
          </FormLabel>
          <FormControl>
            <Input {...field} inputMode="decimal" autoComplete="off" placeholder="0.00" />
          </FormControl>
          {hint && <FormDescription>{hint}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function ShippingRateDialog({
  open,
  onOpenChange,
  channel,
  rate,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; channel: CommerceChannel; rate?: ShippingRate }>) {
  const t = getTranslations('commerce');
  const ts = t.channels.shipping;
  const common = getTranslations('common');
  const create = useCreateShippingRate();
  const update = useUpdateShippingRate();
  const schema = useMemo(() => buildShippingRateFormSchema(), []);
  // Only countries the channel sells in; a country the channel has since dropped stays listed so it can be taken off.
  const options = useMemo(
    () => countryOptions([...new Set([...channel.sellingCountries, ...(rate?.countries ?? [])])]),
    [channel.sellingCountries, rate],
  );
  const form = useForm<ShippingRateFormValues>({
    resolver: zodResolver(schema, formSchemaOptions()),
    defaultValues: rate ? valuesFromShippingRate(rate) : emptyShippingRateValues(),
  });

  const onSubmit = async (values: ShippingRateFormValues) => {
    try {
      const data = toShippingRateInput(values);
      if (rate) {
        await update.mutateAsync({ channelId: channel.id, rateId: rate.id, data });
        toast.success(ts.toastUpdated);
      } else {
        await create.mutateAsync({ channelId: channel.id, data });
        toast.success(ts.toastCreated);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err, t.common.saveFailed));
    }
  };

  const submitting = form.formState.isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{rate ? ts.editTitle : ts.newTitle}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
            <FormField
              control={form.control}
              name="zoneName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{ts.form.zoneName}</FormLabel>
                  <FormControl>
                    <Input {...field} required maxLength={255} autoComplete="off" placeholder={ts.form.zonePlaceholder} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="countries"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{ts.form.countries}</FormLabel>
                  <FormControl>
                    <MultiSelect
                      modal
                      options={options}
                      value={field.value}
                      onChange={field.onChange}
                      placeholder={ts.form.countriesPlaceholder}
                      aria-label={ts.form.countries}
                      searchPlaceholder={t.channels.form.searchCountries}
                      emptyText={t.channels.form.noCountries}
                      maxDisplay={6}
                    />
                  </FormControl>
                  <FormDescription>
                    {channel.sellingCountries.length === 0 ? ts.form.noSellingCountries : ts.form.countriesHint}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{ts.form.name}</FormLabel>
                  <FormControl>
                    <Input {...field} required maxLength={255} autoComplete="off" placeholder={ts.form.namePlaceholder} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <MoneyField name="price" label={ts.form.price} currency={channel.currency} />
              <MoneyField
                name="freeShippingThreshold"
                label={ts.form.freeFrom}
                hint={channel.pricesIncludeTax ? ts.form.freeFromHintIncl : ts.form.freeFromHintExcl}
                currency={channel.currency}
              />
            </div>
            <FormField
              control={form.control}
              name="active"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between gap-6 space-y-0">
                  <div className="space-y-1">
                    <FormLabel>{ts.form.active}</FormLabel>
                    <FormDescription>{ts.form.activeHint}</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {common.actions.cancel}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {rate ? common.actions.save : common.actions.create}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
