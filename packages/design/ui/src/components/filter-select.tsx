'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { cn } from '@weldsuite/ui/lib/utils';

/** Radix selects reject an empty item value, so "no filter" is this sentinel. */
export const ALL_FILTER_VALUE = '__all__';

export interface FilterSelectOption {
  value: string;
  label: string;
}

export interface FilterSelectProps {
  /** The active value, or `undefined` for no filter. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  options: FilterSelectOption[];
  /** The "no filter" option ("All statuses"). */
  allLabel: string;
  ariaLabel: string;
  className?: string;
}

/** A compact "all or one value" filter for a list toolbar. */
export function FilterSelect({ value, onChange, options, allLabel, ariaLabel, className }: Readonly<FilterSelectProps>) {
  return (
    <Select
      value={value ?? ALL_FILTER_VALUE}
      onValueChange={(next) => onChange(next === ALL_FILTER_VALUE ? undefined : next)}
    >
      <SelectTrigger size="sm" aria-label={ariaLabel} className={cn('h-8 w-auto min-w-[8rem] shadow-none', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_FILTER_VALUE}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
