/**
 * One series in a chart tooltip: a swatch in the series' colour (a short line,
 * dashed for a comparison, or a square for a share), its label and the
 * formatted value.
 */

import { cn } from '@weldsuite/ui/lib/utils';

export interface ChartTooltipRowProps {
  label: string;
  /** The formatted value, such as "€12,400.00". */
  value: string;
  /** The series' colour; any CSS colour. */
  color?: string;
  /** Draws the line swatch dashed, for a comparison series. */
  dashed?: boolean;
  /** A short line, as on a line chart (the default), a square, as on bars and cells, or none. */
  swatch?: 'line' | 'square' | 'none';
}

export function ChartTooltipRow({ label, color, value, dashed = false, swatch = 'line' }: Readonly<ChartTooltipRowProps>) {
  const square = swatch === 'square';
  return (
    <div className="flex w-full items-center gap-2">
      {swatch !== 'none' && (
        <span
          className={cn('shrink-0', square ? 'size-2 rounded-[2px]' : 'w-3 border-t-2', !square && dashed && 'border-dashed')}
          style={square ? { backgroundColor: color } : { borderColor: color }}
        />
      )}
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto pl-4 font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}
