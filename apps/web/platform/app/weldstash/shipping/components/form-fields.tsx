/**
 * Form fields shared by the carrier dialog and the label dialog: a labelled
 * text input and an address block, both bound to react-hook-form through the
 * library's `Form` primitives.
 */

import type { ComponentProps } from 'react';
import type { Control, FieldValues, Path } from 'react-hook-form';
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { CountrySelect } from '@/components/settings/country-select';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface TextFieldProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  required?: boolean;
  description?: string;
  type?: 'text' | 'email' | 'tel' | 'password';
  inputMode?: ComponentProps<'input'>['inputMode'];
  autoComplete?: string;
  placeholder?: string;
  className?: string;
  /** Hide the label visually, for a field in a repeated row that is named by its column. */
  srOnlyLabel?: boolean;
}

export function TextField<T extends FieldValues>({
  control,
  name,
  label,
  required,
  description,
  type = 'text',
  inputMode,
  autoComplete,
  placeholder,
  className,
  srOnlyLabel,
}: Readonly<TextFieldProps<T>>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel className={cn(srOnlyLabel && 'sr-only')}>
            {label}
            {required ? <span aria-hidden="true" className="ml-0.5 text-destructive">*</span> : null}
          </FormLabel>
          <FormControl>
            <Input
              {...field}
              value={(field.value as string | undefined) ?? ''}
              type={type}
              inputMode={inputMode}
              autoComplete={autoComplete}
              placeholder={placeholder}
              required={required}
              spellCheck={type === 'email' || type === 'password' ? false : undefined}
            />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

interface AddressFieldsProps<T extends FieldValues> {
  control: Control<T>;
  /** The form path of the address object, such as `recipient`. */
  prefix: string;
  /** `autocomplete` section token, such as `shipping`. */
  section?: 'shipping' | 'billing';
  /** Mark name, street, postal code, city and country as required. */
  required?: boolean;
  /** Hide email and phone (a sender address needs neither). */
  withContact?: boolean;
}

/** Name, company, street, house number and addition, postal code, city, country and contact. */
export function AddressFields<T extends FieldValues>({
  control,
  prefix,
  section,
  required = false,
  withContact = true,
}: Readonly<AddressFieldsProps<T>>) {
  const t = getTranslations('weldstash').shipping.address;
  const path = (field: string) => `${prefix}.${field}` as Path<T>;
  const ac = (token: string) => (section ? `${section} ${token}` : token);

  return (
    <div className="grid grid-cols-6 gap-3">
      <TextField className="col-span-6 sm:col-span-3" control={control} name={path('name')} label={t.name} required={required} autoComplete={ac('name')} />
      <TextField className="col-span-6 sm:col-span-3" control={control} name={path('company')} label={t.company} autoComplete={ac('organization')} />
      <TextField className="col-span-6 sm:col-span-3" control={control} name={path('street')} label={t.street} required={required} autoComplete={ac('address-line1')} />
      <TextField className="col-span-3 sm:col-span-2" control={control} name={path('houseNumber')} label={t.houseNumber} inputMode="numeric" />
      <TextField className="col-span-3 sm:col-span-1" control={control} name={path('houseNumberSuffix')} label={t.addition} />
      <TextField className="col-span-3 sm:col-span-2" control={control} name={path('postalCode')} label={t.postalCode} required={required} autoComplete={ac('postal-code')} />
      <TextField className="col-span-3 sm:col-span-2" control={control} name={path('city')} label={t.city} required={required} autoComplete={ac('address-level2')} />
      <FormField
        control={control}
        name={path('country')}
        render={({ field }) => (
          <FormItem className="col-span-6 sm:col-span-2">
            <FormLabel>
              {t.country}
              {required ? <span aria-hidden="true" className="ml-0.5 text-destructive">*</span> : null}
            </FormLabel>
            <FormControl>
              <CountrySelect value={field.value as string | undefined} onChange={field.onChange} className="w-full" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      {withContact ? (
        <>
          <TextField className="col-span-6 sm:col-span-3" control={control} name={path('email')} label={t.email} type="email" autoComplete={ac('email')} />
          <TextField className="col-span-6 sm:col-span-3" control={control} name={path('phone')} label={t.phone} type="tel" autoComplete={ac('tel')} />
        </>
      ) : null}
    </div>
  );
}

interface CheckboxFieldProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function CheckboxField<T extends FieldValues>({ control, name, label, description, disabled }: Readonly<CheckboxFieldProps<T>>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <div className="flex items-center gap-2">
            <FormControl>
              <Checkbox checked={field.value === true} disabled={disabled} onCheckedChange={(checked) => field.onChange(checked === true)} />
            </FormControl>
            <FormLabel className="font-normal">{label}</FormLabel>
          </div>
          {description ? <FormDescription>{description}</FormDescription> : null}
        </FormItem>
      )}
    />
  );
}

interface SelectFieldProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  description?: string;
  className?: string;
}

export function SelectField<T extends FieldValues>({
  control,
  name,
  label,
  options,
  placeholder,
  required,
  disabled,
  description,
  className,
}: Readonly<SelectFieldProps<T>>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>
            {label}
            {required ? <span aria-hidden="true" className="ml-0.5 text-destructive">*</span> : null}
          </FormLabel>
          <Select
            value={(field.value as string | undefined) || undefined}
            // No option has an empty value, so an empty one comes from Radix's
            // hidden native select catching up, not from a choice: it would
            // undo a value set in code (the carrier's default product).
            onValueChange={(next) => {
              if (next) field.onChange(next);
            }}
            disabled={disabled}
          >
            <FormControl>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={placeholder} />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
