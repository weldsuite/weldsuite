/**
 * Date helpers for WeldBooks. Accounting dates are calendar dates
 * (`YYYY-MM-DD`), not instants: "today" is the user's local day, and a date
 * the API returns as `2026-10-04` or `2026-10-04T00:00:00.000Z` stays on the
 * 4th whatever the browser's time zone.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const MIDNIGHT_UTC = /^\d{4}-\d{2}-\d{2}(T00:00(:00(\.0+)?)?(Z|[+-]00:?00)?)?$/;

/**
 * The column default of `user_preferences.date_format`. Nobody can set the
 * preference in the UI yet, so this value can't be told apart from "never
 * chosen" and is treated as no preference: the entity's locale decides.
 */
export const DEFAULT_DATE_FORMAT_PREFERENCE = 'MM/DD/YYYY';

const DATE_PATTERN = /^(YYYY|MM|DD)([-/. ])(YYYY|MM|DD)\2(YYYY|MM|DD)$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function isoFromParts(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Today's calendar date (`YYYY-MM-DD`) in the given time zone, or the browser's. */
export function localToday(timeZone?: string | null, now: Date = new Date()): string {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(now);
      const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
      const year = get('year');
      const month = get('month');
      const day = get('day');
      if (year && month && day) return isoFromParts(year, month, day);
    } catch {
      // Unknown time zone: fall through to the browser's.
    }
  }
  return isoFromParts(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** Add (or subtract) whole days to a `YYYY-MM-DD` date. */
export function addDaysToIsoDate(isoDate: string, days: number): string {
  const match = ISO_DATE.exec(isoDate);
  if (!match) return isoDate;
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return isoFromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * The calendar date of an API value as `YYYY-MM-DD`, or `null`. Date-only
 * strings and UTC-midnight timestamps keep their written day; any other
 * timestamp is an instant and becomes the browser's local day.
 */
export function toCalendarDate(value: string | Date | null | undefined): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const match = ISO_DATE.exec(trimmed);
    if (match && MIDNIGHT_UTC.test(trimmed)) return `${match[1]}-${match[2]}-${match[3]}`;
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) return null;
    return isoFromParts(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
  }
  if (Number.isNaN(value.getTime())) return null;
  return isoFromParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
}

/** True for a usable date pattern preference such as `DD-MM-YYYY`. */
export function isExplicitDatePattern(pattern: string | null | undefined): pattern is string {
  if (!pattern || pattern === DEFAULT_DATE_FORMAT_PREFERENCE) return false;
  const match = DATE_PATTERN.exec(pattern);
  if (!match) return false;
  const tokens = new Set([match[1], match[3], match[4]]);
  return tokens.size === 3;
}

function isValidLocale(locale: string | null | undefined): locale is string {
  if (!locale) return false;
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([locale]).length > 0;
  } catch {
    return false;
  }
}

/**
 * The locale to format dates with: the UI language with the entity's region
 * ("en" + "nl-NL" → "en-NL"), so month names follow the UI and the day/month
 * order follows the entity's country.
 */
export function weldbooksDateLocale(
  uiLanguage: string | null | undefined,
  entityLocale: string | null | undefined,
): string | undefined {
  const language = uiLanguage?.split(/[-_]/)[0]?.toLowerCase();
  const region = entityLocale?.split(/[-_]/)[1]?.toUpperCase();
  const candidates = [
    language && region ? `${language}-${region}` : null,
    entityLocale ?? null,
    language ?? null,
  ];
  for (const candidate of candidates) {
    if (isValidLocale(candidate)) return candidate;
  }
  return undefined;
}

export interface WeldbooksDateOptions {
  /** BCP 47 locale for the medium date style. */
  locale?: string | null;
  /** The user's `dateFormat` preference (e.g. `DD-MM-YYYY`). */
  dateFormat?: string | null;
  /** What to show for an empty value. */
  empty?: string;
}

/** Format an accounting date for display. */
export function formatWeldbooksDate(
  value: string | Date | null | undefined,
  options: WeldbooksDateOptions = {},
): string {
  const empty = options.empty ?? '—';
  const iso = toCalendarDate(value);
  if (!iso) return empty;
  const [year, month, day] = iso.split('-');

  if (isExplicitDatePattern(options.dateFormat)) {
    return options.dateFormat.replace('YYYY', year).replace('MM', month).replace('DD', day);
  }

  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const locale = isValidLocale(options.locale) ? options.locale : undefined;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** Format an instant (created/filed/imported at) with date and time, in local time. */
export function formatWeldbooksDateTime(
  value: string | Date | null | undefined,
  options: { locale?: string | null; timeZone?: string | null; empty?: string } = {},
): string {
  const empty = options.empty ?? '—';
  if (value == null || value === '') return empty;
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return empty;
  const locale = isValidLocale(options.locale) ? options.locale : undefined;
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: options.timeZone ?? undefined,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }
}

/** "October 2026" style label for grouping by month. */
export function formatWeldbooksMonth(
  value: string | Date | null | undefined,
  options: { locale?: string | null } = {},
): string {
  const iso = toCalendarDate(value);
  if (!iso) return '';
  const [year, month] = iso.split('-');
  const locale = isValidLocale(options.locale) ? options.locale : undefined;
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(year), Number(month) - 1, 1)),
  );
}
