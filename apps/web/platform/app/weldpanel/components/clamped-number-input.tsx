import { useEffect, useState } from 'react';
import { NumberInput } from '@weldsuite/ui/components/number-input';

interface ClampedNumberInputProps {
  id?: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
  className?: string;
  'aria-label'?: string;
}

/**
 * A whole number between `min` and `max`. The field may be empty or out of
 * range while someone types ("1" on the way to "14"); a value in range is
 * committed at once, and on blur the field snaps to the nearest valid number.
 */
export function ClampedNumberInput({ id, value, min, max, onCommit, className, 'aria-label': ariaLabel }: Readonly<ClampedNumberInputProps>) {
  const [draft, setDraft] = useState<number | undefined>(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <NumberInput
      id={id}
      aria-label={ariaLabel}
      className={className}
      min={min}
      max={max}
      value={draft}
      onValueChange={(next) => {
        setDraft(next);
        if (next !== undefined && Number.isInteger(next) && next >= min && next <= max) onCommit(next);
      }}
      onBlur={() => {
        const snapped = draft === undefined || Number.isNaN(draft) ? value : Math.min(max, Math.max(min, Math.round(draft)));
        setDraft(snapped);
        if (snapped !== value) onCommit(snapped);
      }}
    />
  );
}
