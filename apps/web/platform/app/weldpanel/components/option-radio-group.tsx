/**
 * A choice between a few options, each with a sentence on what it does: the
 * project type, the consent mode and the masking level. Renders inside a
 * react-hook-form `FormItem` (the group is the form control).
 */

import { useId } from 'react';
import { FormControl } from '@weldsuite/ui/components/form';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { cn } from '@/lib/utils';

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  description: string;
}

interface OptionRadioGroupProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly RadioOption<T>[];
  /** Names the group for assistive technology (the form label cannot: a group is not a labelable element). */
  ariaLabel: string;
  disabled?: boolean;
}

export function OptionRadioGroup<T extends string>({ value, onChange, options, ariaLabel, disabled }: Readonly<OptionRadioGroupProps<T>>) {
  const groupId = useId();
  return (
    <FormControl>
      <RadioGroup value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled} aria-label={ariaLabel} className="gap-2">
        {options.map((option) => {
          const id = `${groupId}-${option.value}`;
          return (
            <label
              key={option.value}
              htmlFor={id}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/40',
                'has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5',
                disabled && 'cursor-not-allowed opacity-60 hover:bg-transparent',
              )}
            >
              <RadioGroupItem id={id} value={option.value} className="mt-0.5" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium">{option.label}</span>
                <span className="text-sm text-muted-foreground">{option.description}</span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
    </FormControl>
  );
}
