/** Metrics whose value is a percentage (0-100), so charts label them with a % unit. */
const PERCENT_METRICS: ReadonlySet<string> = new Set([
  'completion_rate',
  'hours_utilization',
  'estimation_accuracy',
  'on_time_milestones',
  'utilization_rate',
]);

/** The unit a metric's values are measured in, or `undefined` for plain counts and amounts. */
export function metricUnit(metric: string | undefined): '%' | undefined {
  return metric && PERCENT_METRICS.has(metric) ? '%' : undefined;
}

/** `42` -> `42%` for percentage metrics; the value untouched otherwise. */
export function formatMetricValue(value: unknown, unit: string | undefined): string {
  if (typeof value === 'number') {
    const rounded = Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
    return unit ? `${rounded}${unit}` : rounded;
  }
  return unit ? `${String(value)}${unit}` : String(value);
}
