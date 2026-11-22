/**
 * One address of the order form (billing or shipping). These are a
 * customer's details typed in by staff, not the signed-in member's own
 * address, so the browser's autofill is switched off: it would offer the
 * staff member's address for a stranger's order.
 */

import { useFormContext } from 'react-hook-form';
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { getTranslations } from '@/lib/i18n';
import type { AddressValues, OrderFormValues } from '../../lib/order-form';

type AddressName = 'billingAddress' | 'shippingAddress';

interface FieldSpec {
  key: keyof AddressValues;
  type?: 'text' | 'email' | 'tel';
  /** Grid span on the two-column layout. */
  wide?: boolean;
}

const FIELDS: FieldSpec[] = [
  { key: 'name' },
  { key: 'company' },
  { key: 'line1', wide: true },
  { key: 'line2', wide: true },
  { key: 'postalCode' },
  { key: 'city' },
  { key: 'region' },
  { key: 'country' },
  { key: 'phone', type: 'tel' },
  { key: 'email', type: 'email' },
];

export function OrderAddressFields({ name }: Readonly<{ name: AddressName }>) {
  const t = getTranslations('commerce').orders.address;
  const form = useFormContext<OrderFormValues>();

  return (
    <fieldset className="grid gap-3 sm:grid-cols-2">
      <legend className="mb-2 text-sm font-medium">{name === 'billingAddress' ? t.billing : t.shipping}</legend>
      {FIELDS.map(({ key, type, wide }) => (
        <FormField
          key={key}
          control={form.control}
          name={`${name}.${key}`}
          render={({ field }) => (
            <FormItem className={wide ? 'sm:col-span-2' : undefined}>
              <FormLabel>{t[key]}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type={type ?? 'text'}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={key === 'country' ? 2 : undefined}
                  className={key === 'country' ? 'uppercase' : undefined}
                />
              </FormControl>
              {key === 'country' && <FormDescription>{t.countryHint}</FormDescription>}
              <FormMessage />
            </FormItem>
          )}
        />
      ))}
    </fieldset>
  );
}
