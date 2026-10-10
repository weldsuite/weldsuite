/**
 * Field wrappers for the payroll forms: React Hook Form's `FormField` plus the
 * shadcn `Form*` primitives, one component per input kind. Blank text becomes
 * `null` (the contract schemas use `.nullable().optional()` for "clear this")
 * unless `emptyAs` says otherwise, and numbers are parsed from what was typed,
 * decimal comma included.
 */

import { useId, useState, type ReactNode } from 'react';
import type { Control, FieldPath, FieldValues } from 'react-hook-form';
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { parseNumberInput } from '../lib/format';

interface BaseFieldProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function TextField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  disabled,
  className,
  placeholder,
  type = 'text',
  inputMode,
  maxLength,
  autoComplete,
  emptyAs = 'null',
  multiline,
  uppercase,
}: Readonly<
  BaseFieldProps<T> & {
    placeholder?: string;
    type?: 'text' | 'date' | 'email' | 'password';
    inputMode?: 'text' | 'numeric' | 'decimal';
    maxLength?: number;
    autoComplete?: string;
    /** What a blank input is stored as. */
    emptyAs?: 'null' | 'undefined' | 'string';
    multiline?: boolean;
    /** Store what is typed in capitals (state and country codes). */
    uppercase?: boolean;
  }
>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => {
        const blank = { null: null, undefined: undefined, string: '' }[emptyAs];
        const shared = {
          value: (field.value ?? '') as string,
          onChange: (e: { target: { value: string } }) => {
            const typed = uppercase ? e.target.value.toUpperCase() : e.target.value;
            field.onChange(typed === '' ? blank : typed);
          },
          onBlur: field.onBlur,
          name: field.name,
          ref: field.ref,
          disabled,
          placeholder,
          maxLength,
        };
        return (
          <FormItem className={className}>
            <FormLabel>{label}</FormLabel>
            <FormControl>
              {multiline ? (
                <Textarea rows={3} {...shared} />
              ) : (
                <Input type={type} inputMode={inputMode} autoComplete={autoComplete ?? 'off'} {...shared} />
              )}
            </FormControl>
            {description && <FormDescription>{description}</FormDescription>}
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

function numberText(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? '' : String(value);
}

function sameNumber(a: number | null, b: number | null | undefined): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  return Object.is(a, b);
}

/**
 * A number input. It keeps the typed text itself so "12," and "1e" survive a
 * keystroke, and reports the parsed value: `null` when blank, `NaN` when it is
 * not a number (the schema then says so).
 */
function NumberInput({
  value,
  onChange,
  onBlur,
  disabled,
  placeholder,
  id,
  step,
  name,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: Readonly<{
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  onBlur?: () => void;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  step?: string;
  name?: string;
  /** Passed in by FormControl. */
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}>) {
  const [text, setText] = useState(numberText(value));
  const [seen, setSeen] = useState(value);

  // Follow outside changes (a form reset) without fighting the echo of what was just typed.
  if (!Object.is(value, seen)) {
    setSeen(value);
    if (!sameNumber(parseNumberInput(text), value)) setText(numberText(value));
  }

  return (
    <Input
      id={id}
      name={name}
      inputMode="decimal"
      step={step}
      autoComplete="off"
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedBy}
      onBlur={onBlur}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseNumberInput(e.target.value));
      }}
    />
  );
}

export function NumberField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  disabled,
  className,
  placeholder,
  emptyAs = 'null',
}: Readonly<BaseFieldProps<T> & { placeholder?: string; emptyAs?: 'null' | 'undefined' }>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <NumberInput
              name={field.name}
              value={field.value as number | null | undefined}
              onChange={(next) => field.onChange(next === null && emptyAs === 'undefined' ? undefined : next)}
              onBlur={field.onBlur}
              disabled={disabled}
              placeholder={placeholder}
            />
          </FormControl>
          {description && <FormDescription>{description}</FormDescription>}
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

const NONE = '__none';

export function SelectField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  disabled,
  className,
  options,
  emptyLabel,
  placeholder,
  numeric,
}: Readonly<
  BaseFieldProps<T> & {
    options: SelectOption[];
    /** When set, an extra entry with this label clears the field to `null`. */
    emptyLabel?: string;
    placeholder?: string;
    /** The options are numbers (stored as numbers in the form). */
    numeric?: boolean;
  }
>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => {
        const current = field.value === null || field.value === undefined || field.value === '' ? NONE : String(field.value);
        return (
          <FormItem className={className}>
            <FormLabel>{label}</FormLabel>
            <Select
              value={current === NONE && !emptyLabel ? undefined : current}
              disabled={disabled}
              onValueChange={(next) => {
                if (next === NONE) field.onChange(null);
                else field.onChange(numeric ? Number(next) : next);
              }}
            >
              <FormControl>
                <SelectTrigger className="w-full" onBlur={field.onBlur}>
                  <SelectValue placeholder={placeholder} />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {emptyLabel && <SelectItem value={NONE}>{emptyLabel}</SelectItem>}
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {description && <FormDescription>{description}</FormDescription>}
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

/** A labelled switch row (label and description left, switch right). */
export function SwitchField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  disabled,
  className,
}: Readonly<BaseFieldProps<T>>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={cn('flex flex-row items-center justify-between gap-4 rounded-md border p-3', className)}>
          <div className="space-y-0.5">
            <FormLabel>{label}</FormLabel>
            {description && <FormDescription>{description}</FormDescription>}
          </div>
          <FormControl>
            <Switch checked={Boolean(field.value)} onCheckedChange={field.onChange} disabled={disabled} />
          </FormControl>
        </FormItem>
      )}
    />
  );
}

/** A tri-state boolean for "use the default" overrides: default / yes / no. Stored as `null` / `true` / `false`. */
export function TriStateField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  disabled,
  className,
  defaultLabel,
  yesLabel,
  noLabel,
}: Readonly<BaseFieldProps<T> & { defaultLabel: string; yesLabel: string; noLabel: string }>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => {
        let current = 'default';
        if (field.value === true) current = 'yes';
        else if (field.value === false) current = 'no';
        return (
          <FormItem className={className}>
            <FormLabel>{label}</FormLabel>
            <Select
              value={current}
              disabled={disabled}
              onValueChange={(next) => {
                if (next === 'yes') field.onChange(true);
                else if (next === 'no') field.onChange(false);
                else field.onChange(null);
              }}
            >
              <FormControl>
                <SelectTrigger className="w-full" onBlur={field.onBlur}>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="default">{defaultLabel}</SelectItem>
                <SelectItem value="yes">{yesLabel}</SelectItem>
                <SelectItem value="no">{noLabel}</SelectItem>
              </SelectContent>
            </Select>
            {description && <FormDescription>{description}</FormDescription>}
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

/**
 * A labelled number input that is not a React Hook Form field. For values in
 * records keyed by year, which are edited as whole objects (a numeric path
 * segment such as `rates.2026` would turn the record into an array). It
 * reports `null` when blank and `NaN` when the text is not a number, and shows
 * what is wrong with it.
 */
export function PlainNumberField({
  label,
  value,
  onChange,
  description,
  min,
  max,
}: Readonly<{
  label: ReactNode;
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  description?: ReactNode;
  min?: number;
  max?: number;
}>) {
  const t = useTranslations();
  const id = useId();
  let problem: string | null = null;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) problem = t('weldhr.payroll.common.invalidNumber');
    else if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
      problem = t('weldhr.payroll.common.outOfRange', { min: min ?? '−∞', max: max ?? '∞' });
    }
  }
  return (
    <div className="grid gap-2">
      <Label htmlFor={id} data-error={problem !== null} className="data-[error=true]:text-destructive">
        {label}
      </Label>
      <NumberInput id={id} value={value} onChange={onChange} aria-invalid={problem !== null} />
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {problem && <p className="text-sm text-destructive">{problem}</p>}
    </div>
  );
}

/** The `null` / `true` / `false` select of `TriStateField`, outside a form field. */
export function PlainTriStateField({
  label,
  value,
  onChange,
  defaultLabel,
  yesLabel,
  noLabel,
}: Readonly<{
  label: ReactNode;
  value: boolean | null | undefined;
  onChange: (value: boolean | null) => void;
  defaultLabel: string;
  yesLabel: string;
  noLabel: string;
}>) {
  const id = useId();
  let current = 'default';
  if (value === true) current = 'yes';
  else if (value === false) current = 'no';
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={current} onValueChange={(next) => onChange(next === 'yes' ? true : next === 'no' ? false : null)}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">{defaultLabel}</SelectItem>
          <SelectItem value="yes">{yesLabel}</SelectItem>
          <SelectItem value="no">{noLabel}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
