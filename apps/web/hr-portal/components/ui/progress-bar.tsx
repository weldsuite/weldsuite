export function ProgressBar({ value, max, label }: Readonly<{ value: number; max: number; label?: string }>) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div>
      {label && (
        <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
          <span>{label}</span>
          <span>
            {value}/{max}
          </span>
        </div>
      )}
      <progress className="sr-only" value={value} max={max > 0 ? max : 1} aria-label={label} />
      <div className="h-2 w-full rounded-full bg-gray-100" aria-hidden="true">
        <div className="h-2 rounded-full portal-btn-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
