/**
 * Small controls the properties panels share: a titled section, a switch row,
 * a nullable number field and a select with plain options.
 */

import type { ReactNode } from 'react';
import { FormField } from '@weldsuite/ui/components/form-field';
import { Label } from '@weldsuite/ui/components/label';
import { NumberInput } from '@weldsuite/ui/components/number-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { cn } from '@/lib/utils';

export function PropSection({ title, children, className }: Readonly<{ title?: string; children: ReactNode; className?: string }>) {
  return (
    <section className={cn('space-y-3 border-b px-4 py-4 last:border-b-0', className)}>
      {title && <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>}
      {children}
    </section>
  );
}

interface ToggleRowProps {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id: string;
}

export function ToggleRow({ label, description, checked, onCheckedChange, disabled, id }: Readonly<ToggleRowProps>) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id} className="text-sm font-normal">
          {label}
        </Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}

interface NumberFieldProps {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  helpText?: string;
  disabled?: boolean;
}

export function NumberField({ label, value, onChange, min, max, step, placeholder, helpText, disabled }: Readonly<NumberFieldProps>) {
  return (
    <FormField label={label} helpText={helpText}>
      <NumberInput value={value} onValueChange={onChange} min={min} max={max} step={step} placeholder={placeholder} disabled={disabled} />
    </FormField>
  );
}

interface OptionSelectProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  helpText?: string;
}

export function OptionSelect<T extends string>({ label, value, options, onChange, disabled, helpText }: Readonly<OptionSelectProps<T>>) {
  return (
    <FormField label={label} helpText={helpText}>
      <Select value={value} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}
