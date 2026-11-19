/** Shared helpers for the sample query answers: volumes, labels, breakdown values and splits. */

import type {
  PanelResolvedRange,
  PanelTrendsSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import {
  APP_PROJECT_ID,
  APP_SCREENS,
  BROWSERS,
  COMPANIES,
  COUNTRIES,
  DAY_MS,
  DEVICES,
  EVENTS,
  OPERATING_SYSTEMS,
  PAGES,
  REFERRERS,
  UTM_CAMPAIGNS,
  between,
  daysBetween,
  dailyValue,
  eventPerDay,
  projectFor,
  resolvedRange,
  rng,
  ymd,
  type SampleRange,
} from '../dataset';

/** A breakdown as a client sends it (defaults not yet filled in). */
export type BreakdownInput = NonNullable<PanelTrendsSpec['breakdown']>;

/** The breakdowns of a spec: `breakdowns`, else `[breakdown]`, else none. */
export function breakdownsOf(spec: { breakdown?: BreakdownInput; breakdowns?: BreakdownInput[] }): BreakdownInput[] {
  if (spec.breakdowns && spec.breakdowns.length > 0) return spec.breakdowns;
  return spec.breakdown ? [spec.breakdown] : [];
}

export function isApp(projectId: string): boolean {
  return projectFor(projectId).id === APP_PROJECT_ID;
}

export function pagesFor(projectId: string): ReadonlyArray<{ path: string; title: string; weight: number }> {
  return isApp(projectId) ? APP_SCREENS : PAGES;
}

/** Scale for a spec's filters: each one narrows the data. */
export function filterFactor(filters: ReadonlyArray<{ source: string }> | undefined): number {
  const n = filters?.length ?? 0;
  if (n === 0) return 1;
  return Math.max(0.12, 0.55 ** Math.min(n, 3));
}

export function round(value: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolved(range: SampleRange, compare: boolean, timezone?: string): PanelResolvedRange {
  return resolvedRange(range, compare, timezone);
}

/** The previous period as a range of its own, so the same series functions can run over it. */
export function previousRangeOf(range: SampleRange): SampleRange {
  const days = daysBetween(range.previousFrom, range.previousTo);
  const length = days.length;
  const previousTo = ymd(new Date(new Date(`${range.previousFrom}T12:00:00`).getTime() - DAY_MS));
  const previousFrom = ymd(new Date(new Date(`${previousTo}T12:00:00`).getTime() - (length - 1) * DAY_MS));
  return { from: range.previousFrom, to: range.previousTo, days, previousFrom, previousTo };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const FRUSTRATION_VOLUME: Record<string, { site: number; app: number }> = {
  $rageclick: { site: 38, app: 120 },
  $deadclick: { site: 96, app: 260 },
  $quickback: { site: 52, app: 40 },
  $excessivescroll: { site: 24, app: 18 },
  $exception: { site: 31, app: 150 },
};

const EVENT_LABELS: Record<string, string> = {
  $pageview: 'Pageviews',
  $autocapture: 'Autocaptured events',
  $pageleave: 'Page leaves',
  $webvitals: 'Web vitals',
  $rageclick: 'Rage clicks',
  $deadclick: 'Dead clicks',
  $quickback: 'Quick backs',
  $excessivescroll: 'Excessive scrolls',
  $exception: 'Errors',
};

export function eventLabel(ref: string): string {
  const known = EVENT_LABELS[ref];
  if (known) return known;
  if (ref.startsWith('@')) {
    const customs = ['Checkout started', 'Pricing viewed', 'Invoice paid', 'Trial converted', 'Plan compared'];
    return customs[Math.floor(rng(ref)() * customs.length)]!;
  }
  const words = ref.replace(/^\$/, '').replace(/[_.:/-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Events per day of an event name (or custom event ref) in a project. */
export function eventVolume(ref: string, projectId: string): number {
  const frustration = FRUSTRATION_VOLUME[ref];
  if (frustration) return isApp(projectId) ? frustration.app : frustration.site;
  if (ref.startsWith('@')) return 40 + rng(ref)() * 120;
  const known = EVENTS.find((e) => e.name === ref);
  const volume = known ? eventPerDay(ref, projectId) : 30 + rng(ref)() * 90;
  return volume;
}

/** A rough count of people doing an event per day. */
export function uniquePerDay(ref: string, projectId: string): number {
  const volume = eventVolume(ref, projectId);
  if (ref === '$pageview') return volume * (isApp(projectId) ? 0.19 : 0.36);
  return volume * 0.55;
}

/** People who did something over `days` days: each day brings fewer new ones. */
export function uniqueOver(perDayUnique: number, days: number): number {
  return Math.round(perDayUnique * days ** 0.74);
}

export function rangeSeed(projectId: string, name: string): string {
  return `${projectId}|${name}`;
}

export function dayTotal(key: string, days: readonly string[], base: number): number {
  return days.reduce((s, day) => s + dailyValue(key, day, base), 0);
}

// ---------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------

export interface Weighted {
  value: string;
  weight: number;
}

const PLACES: Record<string, string[]> = {
  NL: ['Noord-Holland', 'Zuid-Holland', 'Utrecht', 'Noord-Brabant', 'Groningen'],
  US: ['California', 'New York', 'Texas', 'Illinois'],
  DE: ['Berlin', 'Bavaria', 'Hamburg', 'North Rhine-Westphalia'],
  BE: ['Flanders', 'Brussels', 'Wallonia'],
  GB: ['England', 'Scotland'],
  FR: ['Île-de-France', 'Auvergne-Rhône-Alpes'],
  ES: ['Madrid', 'Catalonia'],
  IN: ['Karnataka', 'Maharashtra'],
  BR: ['São Paulo'],
  CA: ['Ontario', 'British Columbia'],
  AU: ['New South Wales'],
  SE: ['Stockholm'],
};

function placeWeights(): { regions: Weighted[]; cities: Weighted[] } {
  const regions: Weighted[] = [];
  const cities: Weighted[] = [];
  for (const country of COUNTRIES) {
    const regionNames = PLACES[country.code] ?? [];
    regionNames.forEach((name, i) => regions.push({ value: `${country.code} / ${name}`, weight: (country.weight * (regionNames.length - i)) / ((regionNames.length * (regionNames.length + 1)) / 2) }));
    country.cities.forEach((name, i) => cities.push({ value: `${country.code} / ${name}`, weight: (country.weight * (country.cities.length - i)) / ((country.cities.length * (country.cities.length + 1)) / 2) }));
  }
  return { regions, cities };
}

const PLACE_WEIGHTS = placeWeights();

const CHANNEL_NAMES: Record<string, string> = {
  Direct: 'Direct',
  'Organic search': 'Organic Search',
  'Organic social': 'Organic Social',
  Referral: 'Referral',
  Email: 'Email',
  'Paid search': 'Paid Search',
};

export function channelName(channel: string): string {
  return CHANNEL_NAMES[channel] ?? 'Other';
}

export function referrerWeights(projectId: string): Weighted[] {
  const app = isApp(projectId);
  return REFERRERS.map((r) => {
    const direct = r.host === '(direct)';
    let weight = r.weight;
    if (app) weight = direct ? 72 : r.weight * 0.35;
    return { value: direct ? '' : r.host, weight };
  });
}

export function channelWeights(projectId: string): Weighted[] {
  const totals = new Map<string, number>();
  for (const r of referrerWeights(projectId)) {
    const source = REFERRERS.find((x) => (x.host === '(direct)' ? '' : x.host) === r.value)!;
    const channel = channelName(source.channel);
    totals.set(channel, (totals.get(channel) ?? 0) + r.weight);
  }
  return [...totals.entries()].map(([value, weight]) => ({ value, weight }));
}

export function utmWeights(field: 'campaign' | 'source' | 'medium'): Weighted[] {
  const totals = new Map<string, number>();
  for (const c of UTM_CAMPAIGNS) totals.set(c[field], (totals.get(c[field]) ?? 0) + c.weight);
  return [...totals.entries()].map(([value, weight]) => ({ value, weight }));
}

export function countryWeights(): Weighted[] {
  return COUNTRIES.map((c) => ({ value: c.code, weight: c.weight }));
}

export function deviceWeights(): Weighted[] {
  return DEVICES.map((d) => ({ value: d.name, weight: d.weight }));
}

export function browserWeights(): Weighted[] {
  return BROWSERS.map((b) => ({ value: b.name, weight: b.weight }));
}

export function osWeights(): Weighted[] {
  return OPERATING_SYSTEMS.map((o) => ({ value: o.name, weight: o.weight }));
}

export function pageWeights(projectId: string): Weighted[] {
  return pagesFor(projectId).map((p) => ({ value: p.path, weight: p.weight }));
}

export function hostnameWeights(projectId: string): Weighted[] {
  return isApp(projectId)
    ? [{ value: 'app.weldsuite.org', weight: 100 }]
    : [
        { value: 'weldsuite.com', weight: 78 },
        { value: 'www.weldsuite.com', weight: 22 },
      ];
}

const SELECTORS: Weighted[] = [
  { value: 'a#hero-cta', weight: 22 },
  { value: 'nav a[href="/pricing"]', weight: 16 },
  { value: 'button.start-trial', weight: 14 },
  { value: 'nav a[href="/login"]', weight: 11 },
  { value: '.pricing-card.business a.btn', weight: 10 },
  { value: 'footer a[href="/contact"]', weight: 6 },
  { value: '.feature-grid a.card', weight: 9 },
  { value: 'button.menu-toggle', weight: 7 },
  { value: 'a.logo', weight: 5 },
];

const ELEMENT_TEXTS: Weighted[] = [
  { value: 'Start free trial', weight: 22 },
  { value: 'Pricing', weight: 16 },
  { value: 'Book a demo', weight: 14 },
  { value: 'Sign in', weight: 11 },
  { value: 'Choose Business', weight: 10 },
  { value: 'Contact sales', weight: 8 },
  { value: 'See all features', weight: 9 },
  { value: 'Menu', weight: 6 },
];

const GENERIC_PROPERTY_VALUES: Record<string, Weighted[]> = {
  plan: [
    { value: 'free', weight: 38 },
    { value: 'starter', weight: 27 },
    { value: 'business', weight: 24 },
    { value: 'enterprise', weight: 11 },
  ],
  module: [
    { value: 'WeldCRM', weight: 24 },
    { value: 'WeldDesk', weight: 20 },
    { value: 'WeldMail', weight: 18 },
    { value: 'WeldFlow', weight: 14 },
    { value: 'WeldBooks', weight: 12 },
    { value: 'WeldCalendar', weight: 8 },
    { value: 'WeldDocs', weight: 4 },
  ],
  role: [
    { value: 'Owner', weight: 30 },
    { value: 'Admin', weight: 25 },
    { value: 'Member', weight: 35 },
    { value: 'Guest', weight: 10 },
  ],
  currency: [
    { value: 'EUR', weight: 64 },
    { value: 'USD', weight: 22 },
    { value: 'GBP', weight: 14 },
  ],
  status: [
    { value: 'success', weight: 82 },
    { value: 'failed', weight: 6 },
    { value: 'pending', weight: 12 },
  ],
  source: [
    { value: 'homepage', weight: 36 },
    { value: 'pricing', weight: 28 },
    { value: 'blog', weight: 16 },
    { value: 'docs', weight: 12 },
    { value: 'email', weight: 8 },
  ],
  priority: [
    { value: 'low', weight: 30 },
    { value: 'normal', weight: 44 },
    { value: 'high', weight: 20 },
    { value: 'urgent', weight: 6 },
  ],
  industry: [
    { value: 'Construction', weight: 18 },
    { value: 'Logistics', weight: 16 },
    { value: 'Retail', weight: 14 },
    { value: 'Legal', weight: 12 },
    { value: 'Software', weight: 11 },
    { value: 'Education', weight: 8 },
  ],
  company: COMPANIES.map((c, i) => ({ value: c.name, weight: 18 - i })).slice(0, 8),
};

const FALLBACK_PROPERTY_VALUES: Weighted[] = [
  { value: 'Option A', weight: 40 },
  { value: 'Option B', weight: 28 },
  { value: 'Option C', weight: 18 },
  { value: 'Option D', weight: 9 },
  { value: 'Option E', weight: 5 },
];

function namedValues(key: string): Weighted[] {
  const lower = key.toLowerCase();
  for (const [needle, values] of Object.entries(GENERIC_PROPERTY_VALUES)) if (lower.includes(needle)) return values;
  if (lower.includes('country')) return countryWeights();
  if (lower.includes('device')) return deviceWeights();
  if (lower.includes('browser')) return browserWeights();
  return FALLBACK_PROPERTY_VALUES;
}

function columnWeights(field: string, projectId: string): Weighted[] {
  const site = !isApp(projectId);
  const pages = pagesFor(projectId);
  switch (field) {
    case 'path':
      return pageWeights(projectId);
    case 'url':
      return pages.map((p) => ({ value: `https://${site ? 'weldsuite.com' : 'app.weldsuite.org'}${p.path}`, weight: p.weight }));
    case 'host':
      return hostnameWeights(projectId);
    case 'title':
      return pages.map((p) => ({ value: p.title, weight: p.weight }));
    case 'referrer':
      return referrerWeights(projectId).map((r) => ({ value: r.value ? `https://${r.value}/` : '', weight: r.weight }));
    case 'referrer_host':
      return referrerWeights(projectId);
    case 'utm_source':
      return utmWeights('source');
    case 'utm_medium':
      return utmWeights('medium');
    case 'utm_campaign':
    case 'utm_content':
    case 'utm_term':
      return utmWeights('campaign');
    case 'country':
      return countryWeights();
    case 'region':
      return PLACE_WEIGHTS.regions.map((r) => ({ value: r.value.split(' / ')[1]!, weight: r.weight }));
    case 'city':
      return PLACE_WEIGHTS.cities.map((r) => ({ value: r.value.split(' / ')[1]!, weight: r.weight }));
    case 'device_type':
      return deviceWeights();
    case 'browser':
      return browserWeights();
    case 'os':
      return osWeights();
    case 'el_selector':
      return SELECTORS;
    case 'el_text':
      return ELEMENT_TEXTS;
    default:
      return FALLBACK_PROPERTY_VALUES;
  }
}

function bucketLabels(bucket: NonNullable<Extract<BreakdownInput, { source: 'event' }>['bucket']>): Weighted[] {
  if (bucket.kind === 'custom') {
    const edges = bucket.edges;
    const labels: string[] = [`< ${edges[0]}`];
    for (let i = 0; i < edges.length - 1; i++) labels.push(`${edges[i]} – ${edges[i + 1]}`);
    labels.push(`≥ ${edges[edges.length - 1]}`);
    return labels.map((value, i) => ({ value, weight: 40 / (i + 1) }));
  }
  const count = bucket.count ?? 5;
  return Array.from({ length: count }, (_, i) => ({ value: `${i * 20} – ${(i + 1) * 20}`, weight: 40 / (i + 1) }));
}

/** The values a breakdown has, most common first. */
export function breakdownWeights(breakdown: BreakdownInput, projectId: string): Weighted[] {
  if (breakdown.source === 'column') return columnWeights(breakdown.field, projectId);
  if ('bucket' in breakdown && breakdown.bucket) return bucketLabels(breakdown.bucket);
  const key = breakdown.key;
  if (breakdown.source === 'group') return namedValues(`${breakdown.groupType}${key}`);
  return namedValues(key);
}

export interface SplitValue {
  value: string;
  parts: string[] | null;
  /** Share of the whole, 0-1. */
  share: number;
}

/**
 * The lines a set of breakdowns makes: up to `limit` combinations (at most 8),
 * most common first, and `Other` for the rest when the property has more.
 */
export function splitValues(breakdowns: readonly BreakdownInput[], projectId: string, joiner = ' / '): SplitValue[] {
  if (breakdowns.length === 0) return [];
  const limit = Math.min(8, Math.max(...breakdowns.map((b) => b.limit ?? 10)));
  let combos: { parts: string[]; weight: number }[] = [{ parts: [], weight: 1 }];
  for (const breakdown of breakdowns) {
    const all = breakdownWeights(breakdown, projectId);
    const total = sum(all.map((v) => v.weight));
    const values = all.slice(0, breakdowns.length > 1 ? 4 : all.length);
    combos = combos.flatMap((c) => values.map((v) => ({ parts: [...c.parts, v.value], weight: c.weight * (v.weight / total) })));
  }
  combos.sort((a, b) => b.weight - a.weight);
  const top = combos.slice(0, limit);
  const rows: SplitValue[] = top.map((c) => ({ value: c.parts.map((p) => p || '(none)').join(joiner), parts: c.parts, share: c.weight }));
  const rest = sum(combos.slice(limit).map((c) => c.weight)) + (breakdowns.length > 1 ? 0.04 : 0);
  if (combos.length > limit || breakdowns.length > 1) rows.push({ value: 'Other', parts: null, share: Math.max(0.01, rest) });
  const norm = sum(rows.map((r) => r.share));
  return rows.map((r) => ({ ...r, share: r.share / norm }));
}

/** Rows of a top list: `total` spread over `items` by weight with some noise, biggest first. */
export function distribute(items: readonly Weighted[], total: number, key: string, limit: number): { value: string; amount: number; weight: number }[] {
  const random = rng(key);
  const noisy = items.map((item) => ({ value: item.value, weight: item.weight * (0.92 + random() * 0.16) }));
  const weightTotal = sum(noisy.map((n) => n.weight));
  return noisy
    .map((n) => ({ value: n.value, weight: n.weight / weightTotal, amount: Math.max(1, Math.round((total * n.weight) / weightTotal)) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

/** A believable integer in [min, max] from a key. */
export function intFrom(key: string, min: number, max: number): number {
  return between(rng(key), min, max);
}
