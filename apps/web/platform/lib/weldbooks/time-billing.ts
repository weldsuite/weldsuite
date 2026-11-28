/**
 * The invoice lines the server makes of unbilled time, computed in the browser
 * so the preview next to the entries is what the invoice will hold. It mirrors
 * `group_lines` in `rust/modules/books-sales/src/time_billing.rs`: one line per
 * group of the grouping and per rate, projects together, oldest group first
 * inside a project, the description `project · who or what · dates · hours h`.
 *
 * The server sums exact minutes; the entries carry hours rounded to two
 * decimals, so a line's quantity can differ from the invoice's in the fourth
 * decimal. The description, the grouping and the rates are the same.
 */
import type { TimeGrouping, UnbilledCustomer, UnbilledEntry } from '@/lib/api/domains/weldbooks-time-billing';

/** An entry with the project it belongs to, as the grouping needs it. */
export interface TimedEntry extends UnbilledEntry {
  projectId: string;
  projectName: string;
}

export interface PreviewLine {
  projectId: string;
  projectName: string;
  description: string;
  /** Hours, up to four decimals. */
  quantity: number;
  /** Per hour, in the currency's units. */
  unitPrice: number;
  /** `quantity × unitPrice`, rounded to cents. */
  amount: number;
  entryIds: string[];
}

const MONTHS: Readonly<Record<'en' | 'nl', readonly string[]>> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  nl: ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'],
};

interface Ymd {
  year: number;
  month: number;
  day: number;
}

function parseDate(value: string): Ymd {
  const [year = 0, month = 1, day = 1] = value.slice(0, 10).split('-').map(Number);
  return { year, month, day };
}

/** `24 Nov`, `24–26 Nov`, `28 Nov – 2 Dec`, `28 Dec 2025 – 2 Jan 2026`. */
export function dateRange(first: string, last: string, locale: 'en' | 'nl'): string {
  const a = parseDate(first);
  const b = parseDate(last);
  const names = MONTHS[locale];
  const day = (d: Ymd) => `${d.day} ${names[d.month - 1]}`;
  if (first.slice(0, 10) === last.slice(0, 10)) return day(a);
  if (a.year !== b.year) return `${day(a)} ${a.year} – ${day(b)} ${b.year}`;
  if (a.month === b.month) return `${a.day}–${b.day} ${names[a.month - 1]}`;
  return `${day(a)} – ${day(b)}`;
}

/** Up to `digits` decimals without trailing zeros: `12.5`, `0.1167`. */
function trimmed(value: number, digits: number): string {
  const factor = 10 ** digits;
  return String(Math.round(value * factor) / factor);
}

/** Hours as the description shows them: two decimals at most, a comma in Dutch. */
export function hoursText(hours: number, locale: 'en' | 'nl'): string {
  const text = trimmed(hours, 2);
  return locale === 'nl' ? text.replace('.', ',') : text;
}

/** The entries of every project of one customer row, with their project. */
export function entriesOf(customer: UnbilledCustomer): TimedEntry[] {
  return customer.projects.flatMap((project) =>
    project.entries.map((entry) => ({ ...entry, projectId: project.projectId, projectName: project.name })),
  );
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function subKey(entry: TimedEntry, grouping: TimeGrouping): string {
  switch (grouping) {
    case 'project':
      return '';
    case 'person':
      return entry.userId;
    case 'activity':
      return entry.activity ?? '';
    case 'entry':
      return entry.id;
  }
}

function lineDescription(list: readonly TimedEntry[], grouping: TimeGrouping, locale: 'en' | 'nl'): string {
  const first = list[0]!;
  const dates = list.map((entry) => entry.date).sort();
  const parts: string[] = [first.projectName];
  if (grouping === 'person') parts.push(first.userName);
  else if (grouping === 'activity' && first.activity) parts.push(first.activity);
  parts.push(dateRange(dates[0]!, dates[dates.length - 1]!, locale));
  if (grouping === 'entry') {
    const detail = first.description || first.activity || first.userName;
    if (detail) parts.push(detail);
  }
  const hours = list.reduce((sum, entry) => sum + Number(entry.hours), 0);
  return [...parts.filter((part) => part !== ''), `${hoursText(hours, locale)} h`].join(' · ');
}

/** The entries as invoice lines, as the server groups them. */
export function groupTimeLines(
  entries: readonly TimedEntry[],
  grouping: TimeGrouping,
  locale: 'en' | 'nl',
): PreviewLine[] {
  const groups = new Map<string, { key: [string, string, string, number]; list: TimedEntry[] }>();
  for (const entry of entries) {
    const rate = Math.round(Number(entry.rate) * 100);
    const key: [string, string, string, number] = [entry.projectName, entry.projectId, subKey(entry, grouping), rate];
    const id = JSON.stringify(key);
    const group = groups.get(id);
    if (group) group.list.push(entry);
    else groups.set(id, { key, list: [entry] });
  }
  const ordered = [...groups.values()].sort(
    (a, b) =>
      compare(a.key[0], b.key[0]) || compare(a.key[1], b.key[1]) || compare(a.key[2], b.key[2]) || a.key[3] - b.key[3],
  );
  const lines = ordered.map(({ key, list }) => {
    const sorted = [...list].sort((a, b) => compare(a.date, b.date) || compare(a.id, b.id));
    const hours = sorted.reduce((sum, entry) => sum + Number(entry.hours), 0);
    const quantity = Number(trimmed(hours, 4));
    const unitPrice = key[3] / 100;
    return {
      first: sorted[0]!.date,
      line: {
        projectId: key[1],
        projectName: key[0],
        description: lineDescription(sorted, grouping, locale),
        quantity,
        unitPrice,
        amount: Math.round(quantity * unitPrice * 100) / 100,
        entryIds: sorted.map((entry) => entry.id),
      } satisfies PreviewLine,
    };
  });
  // Projects stay together in the order the groups come; inside one, oldest first.
  const position = new Map<string, number>();
  for (const { line } of lines) if (!position.has(line.projectId)) position.set(line.projectId, position.size);
  return lines
    .map((item, index) => ({ ...item, index }))
    .sort(
      (a, b) =>
        position.get(a.line.projectId)! - position.get(b.line.projectId)! || compare(a.first, b.first) || a.index - b.index,
    )
    .map((item) => item.line);
}

export interface TimeTotals {
  hours: number;
  amount: number;
}

/** Hours and value of the lines, which is what the invoice will hold before VAT. */
export function previewTotals(lines: readonly PreviewLine[]): TimeTotals {
  return {
    hours: Number(trimmed(lines.reduce((sum, line) => sum + line.quantity, 0), 4)),
    amount: Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100,
  };
}

/** Whether any entry will be invoiced at zero for want of a rate. */
export function hasUnratedEntries(entries: readonly TimedEntry[]): boolean {
  return entries.some((entry) => entry.rateSource === 'none');
}

/** The locale the line texts are written in (the server writes the entity's: `nl` or English). */
export function lineLocale(language: string | undefined): 'en' | 'nl' {
  return language === 'nl' ? 'nl' : 'en';
}
