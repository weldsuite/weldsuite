/** One series in a chart tooltip: colour swatch, label and a formatted money value. */
export function MoneyTooltipRow({ label, color, value }: Readonly<{ label: string; color?: string; value: string }>) {
  return (
    <div className="flex w-full items-center gap-2">
      <span className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} />
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto pl-4 font-mono font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}
