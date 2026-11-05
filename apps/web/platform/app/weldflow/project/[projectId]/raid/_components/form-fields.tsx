/**
 * Field building blocks of the RAID dialogs, generic over the form: text,
 * number, date and select inputs wired to React Hook Form with the shared
 * shadcn `Form` primitives.
 */

import type { Control, FieldPath, FieldValues } from 'react-hook-form';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';

/** Radix selects cannot hold an empty string, so "none" is this value. */
export const NONE = '__none__';

interface BaseFieldProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  description?: string;
}

export function TextField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  placeholder,
  type = 'text',
  autoFocus,
}: Readonly<BaseFieldProps<T> & { placeholder?: string; type?: 'text' | 'date'; autoFocus?: boolean }>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              {...field}
              type={type}
              value={(field.value as string | null | undefined) ?? ''}
              placeholder={placeholder}
              autoFocus={autoFocus}
            />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function TextAreaField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  placeholder,
  rows = 3,
}: Readonly<BaseFieldProps<T> & { placeholder?: string; rows?: number }>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Textarea {...field} value={(field.value as string | null | undefined) ?? ''} placeholder={placeholder} rows={rows} />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** A number input whose empty value is null. */
export function NumberField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  min = 0,
  step,
}: Readonly<BaseFieldProps<T> & { min?: number; step?: number | 'any' }>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="number"
              inputMode="decimal"
              min={min}
              step={step}
              name={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              value={(field.value as number | null | undefined) ?? ''}
              onChange={(event) => field.onChange(event.target.value === '' ? null : Number(event.target.value))}
            />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

/** A select whose "none" choice stores null. */
export function SelectField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  options,
  noneLabel,
  placeholder,
}: Readonly<
  BaseFieldProps<T> & {
    options: SelectOption[];
    /** Offers a first choice that stores null. */
    noneLabel?: string;
    placeholder?: string;
  }
>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <Select
            value={(field.value as string | null | undefined) ?? (noneLabel ? NONE : '')}
            onValueChange={(value) => field.onChange(value === NONE ? null : value)}
          >
            <FormControl>
              <SelectTrigger>
                <SelectValue placeholder={placeholder} />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {noneLabel ? <SelectItem value={NONE}>{noneLabel}</SelectItem> : null}
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

export function CheckboxField<T extends FieldValues>({
  control,
  name,
  label,
}: Readonly<Omit<BaseFieldProps<T>, 'description'>>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className="flex flex-row items-center gap-2.5 space-y-0">
          <FormControl>
            <Checkbox checked={field.value === true} onCheckedChange={(checked) => field.onChange(checked === true)} />
          </FormControl>
          <FormLabel className="font-normal text-foreground/80">{label}</FormLabel>
        </FormItem>
      )}
    />
  );
}
