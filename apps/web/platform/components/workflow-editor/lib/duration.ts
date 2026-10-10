/**
 * Delay steps in words ("1 hour" instead of "3600 seconds").
 *
 * Dependency-free on purpose: the node summaries of the workflow canvas and the
 * People tab of a CRM sequence both use it, and the latter should not pull the
 * canvas bundle in for a few lines of arithmetic.
 */

/** A unit's name, with `{count}`, in the singular and the plural. */
export interface DurationUnitLabel {
  one: string;
  other: string;
}

export interface DurationLabels {
  day: DurationUnitLabel;
  hour: DurationUnitLabel;
  minute: DurationUnitLabel;
  second: DurationUnitLabel;
}

/** The delay fields in the order the engine reads them (the first one that is set wins). */
const DELAY_UNITS = [
  ['days', 86_400],
  ['hours', 3_600],
  ['minutes', 60],
  ['seconds', 1],
] as const;

const DURATION_PARTS = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
] as const;

/**
 * The length, in seconds, of a `delay` step's config: `{ seconds: 3600 }`,
 * `{ minutes: '90' }` ... Reads the fields the way the engine does (the first
 * positive one wins). 0 when no positive duration is set, e.g. for a value
 * that is still a `{{variable}}`.
 */
export function getDelaySeconds(config: Record<string, unknown> | null | undefined): number {
  const unit = DELAY_UNITS.find(([field]) => Number(config?.[field]) > 0);
  return unit ? Number(config?.[unit[0]]) * unit[1] : 0;
}

/**
 * A span of seconds in words, using its two largest units: 3600 -> "1 hour",
 * 172800 -> "2 days", 5400 -> "1 hour 30 minutes", 45 -> "45 seconds". Returns
 * '' for anything that is not a positive span.
 */
export function formatDuration(totalSeconds: number, labels: DurationLabels): string {
  let remaining = Math.round(totalSeconds);
  if (!(remaining > 0)) return '';
  const parts: string[] = [];
  for (const [unit, size] of DURATION_PARTS) {
    const count = Math.floor(remaining / size);
    if (count === 0) continue;
    remaining -= count * size;
    const forms = labels[unit];
    parts.push((count === 1 ? forms.one : forms.other).replace('{count}', String(count)));
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}
