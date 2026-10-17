/**
 * One series in a chart tooltip: a short line in the series' colour (dashed
 * for the comparison, as on the chart), its label and a formatted value.
 */
export function MoneyTooltipRow({
  label,
  color,
  value,
  dashed = false,
}: Readonly<{ label: string; color?: string; value: string; dashed?: boolean }>) {
  return (
    <div className="flex w-full items-center gap-2">
      <span
        className={`w-3 shrink-0 border-t-2 ${dashed ? 'border-dashed' : ''}`}
        style={{ borderColor: color }}
      />
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto pl-4 font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}
