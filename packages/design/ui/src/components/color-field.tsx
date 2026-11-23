import { forwardRef, type ComponentProps } from 'react';
import { Input } from '@weldsuite/ui/components/input';
import { cn } from '@weldsuite/ui/lib/utils';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export interface ColorFieldProps extends Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'type'> {
  /** A `#rrggbb` colour, or whatever is being typed. */
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name of the colour swatch (the browser's colour picker), such as "Pick the background colour". */
  swatchLabel: string;
  /** What the swatch shows while the text is not a `#rrggbb` colour. */
  fallback?: string;
  /** Classes for the row around the swatch and the field. */
  wrapperClassName?: string;
}

/**
 * A colour as a swatch (the browser's own colour picker) next to its hex code
 * in a text field, both editing one `#rrggbb` value. Every other prop goes to
 * the text field, so a form's label, `aria-describedby` and `aria-invalid`
 * land on it; the swatch is named by `swatchLabel`.
 */
export const ColorField = forwardRef<HTMLInputElement, ColorFieldProps>(function ColorField(
  { value, onValueChange, swatchLabel, fallback = '#000000', disabled, className, wrapperClassName, ...props },
  ref,
) {
  const swatch = HEX_COLOR.test(value) ? value.toLowerCase() : fallback;
  return (
    <div className={cn('flex items-center gap-2', wrapperClassName)}>
      <input
        type="color"
        aria-label={swatchLabel}
        value={swatch}
        disabled={disabled}
        onChange={(event) => onValueChange(event.target.value)}
        className="h-9 w-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-1 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <Input
        {...props}
        ref={ref}
        type="text"
        value={value}
        disabled={disabled}
        maxLength={7}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => onValueChange(event.target.value.trim())}
        className={cn('font-mono', className)}
      />
    </div>
  );
});
