'use client';

import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { cn } from '@weldsuite/ui/lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the group for assistive technology, e.g. "Group the invoice lines". */
  ariaLabel: string;
  size?: 'default' | 'sm';
  className?: string;
}

/**
 * A row of mutually exclusive choices with one always selected, for a setting
 * the view reacts to at once (a grouping, a filter): a single-select toggle
 * group, so arrow keys move between the segments and a screen reader says
 * which is on. Pressing the selected segment keeps it selected. It holds no
 * translations: every word comes from props.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'sm',
  className,
}: Readonly<SegmentedControlProps<T>>) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size={size}
      value={value}
      onValueChange={(next) => {
        // Radix reports an empty string when the pressed item was already on.
        if (next) onChange(next as T);
      }}
      aria-label={ariaLabel}
      className={cn('flex-wrap', className)}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} className="px-3 text-xs">
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
