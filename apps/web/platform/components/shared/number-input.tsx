import { forwardRef, type ComponentProps } from 'react';
import { Input } from '@weldsuite/ui/components/input';

interface NumberInputProps extends Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'type'> {
  value: number | undefined;
  /** `undefined` while the field is empty, so a form can report it as missing instead of 0 or NaN. */
  onValueChange: (value: number | undefined) => void;
}

/** A whole-number field for react-hook-form: the form holds a number (or nothing), never a string or NaN. */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { value, onValueChange, ...props },
  ref,
) {
  return (
    <Input
      {...props}
      ref={ref}
      type="number"
      inputMode="numeric"
      value={typeof value === 'number' && !Number.isNaN(value) ? value : ''}
      onChange={(event) => onValueChange(event.target.value === '' ? undefined : Number(event.target.value))}
    />
  );
});
