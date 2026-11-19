/** Sample answers for the web overview, web vitals, recordings list and heatmaps. */

import type {
  PanelBreakdownRow,
  PanelEntryExitRow,
  PanelHeatmapElement,
  PanelHeatmapPoint,
  PanelHeatmapResult,
  PanelInterval,
  PanelSessionRow,
  PanelSessionsResult,
  PanelSessionsSpec,
  PanelTotals,
  PanelVitalsMetric,
  PanelVitalsRating,
  PanelVitalsResult,
  PanelVitalsRow,
  PanelVitalsSpec,
  PanelWebGoalResult,
  PanelWebPanel,
  PanelWebResult,
  PanelWebSpec,
  PanelHeatmapSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { PANEL_VITALS_THRESHOLDS, PANEL_WEB_DEFAULT_PANELS } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import {
  COUNTRIES,
  SESSIONS,
  bucketsFor,
  personById,
  resolveRange,
  rng,
  seriesValues,
  type SampleRange,
} from '../dataset';
import {
  browserWeights,
  channelWeights,
  clamp,
  countryWeights,
  deviceWeights,
  distribute,
  eventVolume,
  filterFactor,
  hostnameWeights,
  isApp,
  osWeights,
  pageWeights,
  pagesFor,
  previousRangeOf,
  referrerWeights,
  resolved,
  round,
  sum,
  utmWeights,
  type Weighted,
} from './query-common';

// ---------------------------------------------------------------------------
// Web overview
// ---------------------------------------------------------------------------

function webSeries(projectId: string, range: SampleRange, interval: PanelInterval, factor: number): { bucket: string; visitors: number; pageviews: number }[] {
  const pv = seriesValues(`${projectId}|web|pv`, range, eventVolume('$pageview', projectId) * factor, interval);
  const visitorsPerPv = isApp(projectId) ? 0.19 : 0.36;
  const buckets = bucketsFor(range, interval);
  return buckets.map((bucket, i) => ({
    bucket,
    pageviews: pv[i] ?? 0,
    visitors: Math.round((pv[i] ?? 0) * visitorsPerPv * (interval === 'hour' ? 0.9 : 1)),
  }));
}

function webTotals(projectId: string, series: { visitors: number; pageviews: number }[], days: number): PanelTotals {
  const pageviews = sum(series.map((s) => s.pageviews));
  const dailyVisitors = sum(series.map((s) => s.visitors));
  const visitors = Math.round(dailyVisitors * (series.length > 1 ? 0.8 : 1));
  const random = rng(`${projectId}|totals|${days}`);
  const app = isApp(projectId);
  return {
    visitors,
    visits: Math.round(pageviews / (app ? 3.4 : 2.1)),
    pageviews,
    bounceRate: round(app ? 0.21 + random() * 0.04 : 0.46 + random() * 0.05, 3),
    avgVisitDurationSeconds: Math.round(app ? 640 + random() * 90 : 118 + random() * 30),
  };
}

function breakdownRows(items: readonly Weighted[], pageviews: number, visitors: number, key: string, limit: number): PanelBreakdownRow[] {
  const byEvents = distribute(items, pageviews, key, limit);
  const ratio = visitors / Math.max(1, pageviews);
  return byEvents.map((row) => ({ value: row.value, events: row.amount, visitors: Math.max(1, Math.round(row.amount * ratio * (0.94 + rng(`${key}|${row.value}`)() * 0.12))) }));
}

/** How much more (or less) a page is where visits start. */
function entryBias(path: string): number {
  if (path === '/') return 2.2;
  if (path.startsWith('/blog')) return 1.6;
  if (path === '/pricing') return 1.1;
  return path === '/signup' || path === '/login' ? 0.5 : 0.8;
}

/** How much more (or less) a page is where visits end. */
function exitBias(path: string): number {
  if (path === '/signup') return 1.6;
  if (path === '/') return 1.3;
  if (path === '/login') return 1.4;
  return path.startsWith('/blog') ? 1.5 : 0.9;
}

function entryExit(projectId: string, visits: number, limit: number): PanelEntryExitRow[] {
  const random = rng(`${projectId}|entryexit`);
  const pages = pageWeights(projectId);
  const entries = distribute(pages.map((p) => ({ value: p.value, weight: p.weight * entryBias(p.value) })), visits, `${projectId}|entries`, 50);
  const exits = new Map(distribute(pages.map((p) => ({ value: p.value, weight: p.weight * exitBias(p.value) })), visits, `${projectId}|exits`, 50).map((r) => [r.value, r.amount]));
  return entries
    .map((e) => ({ value: e.value, entries: e.amount, exits: Math.max(1, Math.round((exits.get(e.value) ?? e.amount * 0.6) * (0.9 + random() * 0.2))) }))
    .slice(0, limit);
}

const GOAL_RATES: Record<string, number> = { signup_completed: 0.055, trial_started: 0.04, demo_requested: 0.011, newsletter_subscribed: 0.03 };

/** How often a goal is reached: a known rate for known events, a guess for the rest. */
function goalBaseRate(goal: NonNullable<PanelWebSpec['goals']>[number], random: () => number): number {
  if (goal.event) return GOAL_RATES[goal.event] ?? 0.02 + random() * 0.04;
  return goal.pathPattern === '/signup' ? 0.09 : 0.03 + random() * 0.05;
}

function webGoals(spec: PanelWebSpec, visitors: number): PanelWebGoalResult[] {
  return (spec.goals ?? []).map((goal) => {
    const random = rng(`goal|${goal.label}`);
    const base = goalBaseRate(goal, random);
    const rate = clamp(base * filterFactor(goal.filters) ** 0.3 * (0.92 + random() * 0.16), 0.002, 0.6);
    const uniqueConverters = Math.max(1, Math.round(visitors * rate));
    return { label: goal.label, uniqueConverters, conversions: Math.round(uniqueConverters * (1.04 + random() * 0.2)), conversionRate: round(uniqueConverters / Math.max(1, visitors), 4) };
  });
}

export function webResult(spec: PanelWebSpec): PanelWebResult {
  const projectId = spec.projectId;
  const range = resolveRange(spec.dateRange);
  const factor = filterFactor(spec.filters);
  const interval: PanelInterval = range.days.length <= 1 ? 'hour' : 'day';
  const series = webSeries(projectId, range, interval, factor);
  const totals = webTotals(projectId, series, range.days.length);
  const compare = spec.compare === true;
  const previousRange = previousRangeOf(range);
  const previousSeriesRaw = compare ? webSeries(projectId, previousRange, interval, factor * 0.91) : null;
  const previousTotals = previousSeriesRaw ? webTotals(`${projectId}|prev`, previousSeriesRaw, range.days.length) : null;
  const limit = spec.limit ?? 10;
  const panels = new Set<PanelWebPanel>(spec.panels ?? PANEL_WEB_DEFAULT_PANELS);
  const { pageviews, visitors, visits } = totals;
  const rows = (items: readonly Weighted[], key: string, scale = 1): PanelBreakdownRow[] => breakdownRows(items, Math.round(pageviews * scale), Math.round(visitors * scale), `${projectId}|${key}`, limit);

  const utmShare = 0.17;
  const result: PanelWebResult = {
    range: resolved(range, compare, spec.timezone),
    interval,
    totals,
    previousTotals,
    series,
    previousSeries: previousSeriesRaw,
    topPages: rows(pageWeights(projectId), 'pages'),
    entryExitPages: entryExit(projectId, visits, limit),
    sources: rows(referrerWeights(projectId), 'sources'),
    utmSources: rows(utmWeights('source'), 'utm-source', utmShare),
    utmMediums: rows(utmWeights('medium'), 'utm-medium', utmShare),
    utmCampaigns: rows(utmWeights('campaign'), 'utm-campaign', utmShare),
    countries: rows(countryWeights(), 'countries'),
    devices: rows(deviceWeights(), 'devices'),
    browsers: rows(browserWeights(), 'browsers'),
    operatingSystems: rows(osWeights(), 'os'),
  };
  if (panels.has('channels')) result.channels = rows(channelWeights(projectId), 'channels');
  if (panels.has('hostnames')) result.hostnames = rows(hostnameWeights(projectId), 'hostnames');
  if (panels.has('regions')) result.regions = rows(regionWeights(), 'regions');
  if (panels.has('cities')) result.cities = rows(cityWeights(), 'cities');
  if (panels.has('screenSizes')) {
    result.screenSizes = rows(
      [
        { value: 'laptop', weight: 31 },
        { value: 'desktop', weight: 27 },
        { value: 'mobile', weight: 27 },
        { value: 'wide', weight: 9 },
        { value: 'tablet', weight: 5 },
        { value: '(unknown)', weight: 1 },
      ],
      'screens',
    );
  }
  if (spec.goals && spec.goals.length > 0) result.goals = webGoals(spec, visitors);
  return result;
}

function regionWeights(): Weighted[] {
  const out: Weighted[] = [];
  const regionsByCountry: Record<string, string[]> = {
    NL: ['Noord-Holland', 'Zuid-Holland', 'Utrecht', 'Noord-Brabant', 'Groningen'],
    US: ['California', 'New York', 'Texas', 'Illinois'],
    DE: ['Berlin', 'Bavaria', 'Hamburg', 'North Rhine-Westphalia'],
    BE: ['Flanders', 'Brussels', 'Wallonia'],
    GB: ['England', 'Scotland'],
    FR: ['Île-de-France', 'Auvergne-Rhône-Alpes'],
    ES: ['Madrid', 'Catalonia'],
    IN: ['Karnataka', 'Maharashtra'],
  };
  for (const country of COUNTRIES) {
    const regions = regionsByCountry[country.code];
    if (!regions) continue;
    const total = (regions.length * (regions.length + 1)) / 2;
    regions.forEach((name, i) => out.push({ value: `${country.code} / ${name}`, weight: (country.weight * (regions.length - i)) / total }));
  }
  return out;
}

function cityWeights(): Weighted[] {
  const out: Weighted[] = [];
  for (const country of COUNTRIES) {
    const total = (country.cities.length * (country.cities.length + 1)) / 2;
    country.cities.forEach((name, i) => out.push({ value: `${country.code} / ${name}`, weight: (country.weight * (country.cities.length - i)) / total }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Web vitals
// ---------------------------------------------------------------------------

const VITALS_BASE: Record<PanelVitalsMetric, number> = { lcp: 2280, inp: 168, cls: 0.071, fcp: 1480, ttfb: 590 };
const PERCENTILE_FACTOR = { p75: 1, p90: 1.55, p95: 1.9, p99: 2.7 } as const;

function rating(metric: PanelVitalsMetric, value: number): PanelVitalsRating {
  const t = PANEL_VITALS_THRESHOLDS[metric];
  if (value <= t.good) return 'good';
  return value > t.poor ? 'poor' : 'needs_improvement';
}

function vitalsValue(metric: PanelVitalsMetric, value: number): number {
  return metric === 'cls' ? round(value, 3) : Math.round(value);
}

function vitalsScore(metric: PanelVitalsMetric, value: number): number {
  const t = PANEL_VITALS_THRESHOLDS[metric];
  if (value <= t.good) return Math.round(100 - 10 * (value / t.good));
  if (value <= t.poor) return Math.round(90 - 40 * ((value - t.good) / (t.poor - t.good)));
  return Math.max(0, Math.round(50 - 40 * ((value - t.poor) / t.poor)));
}

const PATH_MULTIPLIER: Record<string, number> = { '/': 1.05, '/pricing': 0.92, '/blog': 1.12, '/customers': 1.3, '/signup': 0.85, '/login': 0.8 };
const COUNTRY_MULTIPLIER: Record<string, number> = { NL: 0.82, DE: 0.9, BE: 0.88, GB: 0.95, FR: 0.98, US: 1.18, ES: 1.1, IN: 1.62, BR: 1.5, CA: 1.2, AU: 1.4, SE: 0.95 };
const DEVICE_MULTIPLIER: Record<string, number> = { desktop: 0.82, tablet: 1.08, mobile: 1.4 };
const VITALS_ELEMENTS: Record<string, Weighted[]> = {
  lcp: [
    { value: 'img.hero-image', weight: 36 },
    { value: 'h1.hero-title', weight: 22 },
    { value: 'video.product-demo', weight: 14 },
    { value: '.pricing-table', weight: 12 },
    { value: 'img.customer-logo', weight: 9 },
  ],
  inp: [
    { value: 'button.menu-toggle', weight: 28 },
    { value: 'a#hero-cta', weight: 22 },
    { value: '.pricing-toggle input', weight: 18 },
    { value: 'form#signup-form input[type="email"]', weight: 16 },
    { value: 'nav a[href="/features"]', weight: 9 },
  ],
  cls: [
    { value: 'img.blog-cover', weight: 30 },
    { value: '.cookie-banner', weight: 26 },
    { value: 'iframe.embedded-video', weight: 18 },
    { value: 'div.announcement-bar', weight: 12 },
    { value: 'img.hero-image', weight: 9 },
  ],
};

export function vitalsResult(spec: PanelVitalsSpec): PanelVitalsResult {
  const metric = spec.metric ?? 'lcp';
  const percentile = spec.percentile ?? 'p75';
  const projectId = spec.projectId;
  const range = resolveRange(spec.dateRange);
  const interval: PanelInterval = spec.interval ?? 'day';
  const limit = spec.limit ?? 10;
  const thresholds = PANEL_VITALS_THRESHOLDS[metric];
  const base = VITALS_BASE[metric] * PERCENTILE_FACTOR[percentile] * (isApp(projectId) ? 1.12 : 1);
  const value = vitalsValue(metric, base);
  const buckets = bucketsFor(range, interval);
  const sampleSeries = seriesValues(`${projectId}|vitals`, range, eventVolume('$pageview', projectId) * 0.6, interval);
  const series = buckets.map((bucket, i) => {
    const random = rng(`${projectId}|vitals|${metric}|${bucket}`);
    return { bucket, value: vitalsValue(metric, base * (0.9 + random() * 0.2 - i * 0.0008)), samples: sampleSeries[i] ?? 0 };
  });
  const samples = sum(series.map((s) => s.samples));
  const goodShare = clamp(0.97 - 0.24 * (VITALS_BASE[metric] / thresholds.good), 0.3, 0.92);
  const poorShare = (1 - goodShare) * 0.32;
  const shares = { good: round(goodShare, 3), needsImprovement: round(1 - goodShare - poorShare, 3), poor: round(poorShare, 3) };

  const row = (name: string, multiplier: number, weight: number, key: string): PanelVitalsRow => {
    const random = rng(key);
    const rowValue = vitalsValue(metric, base * multiplier * (0.94 + random() * 0.12));
    return { value: name, metric: rowValue, samples: Math.max(20, Math.round((samples * weight) / 100)), rating: rating(metric, rowValue) };
  };
  const totalPageWeight = sum(pageWeights(projectId).map((p) => p.weight));
  const paths = pagesFor(projectId)
    .slice(0, limit)
    .map((p) => row(p.path, PATH_MULTIPLIER[p.path] ?? 0.9 + rng(`${projectId}|pm|${p.path}`)() * 0.4, (p.weight / totalPageWeight) * 100, `${projectId}|vp|${metric}|${p.path}`));
  const elementList = VITALS_ELEMENTS[metric] ?? [];
  const elementTotal = sum(elementList.map((e) => e.weight));
  const elements = elementList.slice(0, limit).map((e, i) => row(e.value, 1.25 - i * 0.1, (e.weight / elementTotal) * 100, `${projectId}|ve|${metric}|${e.value}`));
  const countries = COUNTRIES.slice(0, limit).map((c) => row(c.code, COUNTRY_MULTIPLIER[c.code] ?? 1, c.weight, `${projectId}|vc|${metric}|${c.code}`));
  const devices = deviceWeights().map((d) => row(d.value, DEVICE_MULTIPLIER[d.value] ?? 1, d.weight, `${projectId}|vd|${metric}|${d.value}`));

  return {
    range: resolved(range, false, spec.timezone),
    interval,
    metric,
    percentile,
    unit: metric === 'cls' ? 'unitless' : 'ms',
    thresholds,
    value,
    rating: rating(metric, value),
    samples,
    shares,
    score: vitalsScore(metric, value),
    series,
    paths: paths.sort((a, b) => (b.samples ?? 0) - (a.samples ?? 0)),
    elements,
    countries,
    devices,
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function containsAll(session: (typeof SESSIONS)[number], needles: readonly string[]): boolean {
  return needles.every((n) => session.pages.some((p) => p.includes(n)));
}

function sessionRow(session: (typeof SESSIONS)[number], index: number): PanelSessionRow {
  const random = rng(`row|${session.sessionId}`);
  const person = session.distinctId ? personById(session.distinctId) : undefined;
  const startedMs = new Date(session.startedAt).getTime();
  const quickBacks = index % 6 === 0 ? 1 + Math.floor(random() * 2) : 0;
  const excessiveScrolls = index % 8 === 5 ? 1 : 0;
  const device = session.device === 'mobile' || session.device === 'tablet' ? session.device : 'desktop';
  return {
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    endedAt: new Date(startedMs + session.durationSeconds * 1000).toISOString(),
    durationSeconds: session.durationSeconds,
    pageviews: session.pageviews,
    clicks: Math.max(1, Math.round(session.events * (0.35 + random() * 0.15))),
    events: session.events,
    rageClicks: session.rageClicks,
    deadClicks: session.deadClicks,
    quickBacks,
    excessiveScrolls,
    errors: session.errors,
    entryPage: session.entryPath,
    exitPage: session.exitPath,
    deviceType: device,
    browser: session.browser,
    os: session.os,
    country: session.country,
    distinctId: session.distinctId ?? session.anonymousId,
    userId: person ? person.distinctId : null,
    hasRecording: true,
    chunkCount: Math.max(1, Math.ceil(session.durationSeconds / 30)),
    favorite: index % 7 === 0,
  };
}

function frustrationScore(row: PanelSessionRow): number {
  return row.rageClicks * 3 + row.deadClicks + row.quickBacks * 2 + row.excessiveScrolls;
}

type SessionItem = { session: (typeof SESSIONS)[number]; row: PanelSessionRow };

/** One check each: a session stays in the list when every one of them is true. */
const SESSION_CHECKS: Array<(spec: PanelSessionsSpec, { session, row }: SessionItem) => boolean> = [
  (spec, { session }) => !spec.sessionIds || spec.sessionIds.length === 0 || spec.sessionIds.includes(session.sessionId),
  (spec, { session, row }) => !spec.distinctId || row.distinctId === spec.distinctId || session.anonymousId === spec.distinctId,
  (spec, { session }) => spec.minDurationSeconds === undefined || session.durationSeconds >= spec.minDurationSeconds,
  (spec, { session }) => spec.maxDurationSeconds === undefined || session.durationSeconds <= spec.maxDurationSeconds,
  (spec, { session }) => !spec.pagesVisited || spec.pagesVisited.length === 0 || containsAll(session, spec.pagesVisited),
  (spec, { session }) => !spec.entryPage || session.entryPath.includes(spec.entryPage),
  (spec, { session }) => !spec.exitPage || session.exitPath.includes(spec.exitPage),
  (spec, { session }) => !spec.countries || spec.countries.length === 0 || spec.countries.includes(session.country),
  (spec, { row }) => !spec.devices || spec.devices.length === 0 || spec.devices.some((d) => d === row.deviceType),
  (spec, { session }) => !spec.browsers || spec.browsers.length === 0 || spec.browsers.includes(session.browser),
  (spec, { row }) => !spec.hasErrors || row.errors > 0,
  (spec, { row }) => !spec.favoritesOnly || row.favorite,
  (spec, { row }) => {
    if (!spec.frustration || spec.frustration.length === 0) return true;
    const has = { rage: row.rageClicks, dead: row.deadClicks, quickback: row.quickBacks, excessive_scroll: row.excessiveScrolls };
    return spec.frustration.every((f) => has[f] > 0);
  },
];

function compareSessions(sort: string, a: SessionItem, b: SessionItem): number {
  switch (sort) {
    case 'duration_desc':
      return b.row.durationSeconds - a.row.durationSeconds;
    case 'pages_desc':
      return b.row.pageviews - a.row.pageviews;
    case 'frustration_desc':
      return frustrationScore(b.row) - frustrationScore(a.row) || b.row.startedAt.localeCompare(a.row.startedAt);
    case 'errors_desc':
      return b.row.errors - a.row.errors || b.row.startedAt.localeCompare(a.row.startedAt);
    default:
      return b.row.startedAt.localeCompare(a.row.startedAt);
  }
}

export function sessionsResult(spec: PanelSessionsSpec): PanelSessionsResult {
  const range = resolveRange(spec.dateRange);
  const rows: SessionItem[] = SESSIONS.map((s, i) => ({ session: s, row: sessionRow(s, i) }));
  const fromMs = new Date(`${range.from}T00:00:00`).getTime();
  const toMs = new Date(`${range.to}T23:59:59`).getTime();
  const inRange = (item: SessionItem): boolean => {
    const t = new Date(item.session.startedAt).getTime();
    return t >= fromMs && t <= toMs;
  };
  const filtered = rows.filter((item) => SESSION_CHECKS.every((check) => check(spec, item)));
  const dated = filtered.filter(inRange);
  const sort = spec.sort ?? 'started_desc';
  const pool = [...(dated.length > 0 ? dated : filtered)].sort((a, b) => compareSessions(sort, a, b));
  const limit = spec.limit ?? 25;
  const offset = Math.max(0, Number.parseInt(spec.cursor ?? '0', 10) || 0);
  const page = pool.slice(offset, offset + limit);
  const hasMore = offset + limit < pool.length;
  return {
    range: resolved(range, false, spec.timezone),
    sessions: page.map((p) => p.row),
    hasMore,
    nextCursor: hasMore ? String(offset + limit) : null,
  };
}

// ---------------------------------------------------------------------------
// Heatmaps
// ---------------------------------------------------------------------------

interface HeatTemplate {
  /** Share of the project's pageviews this page group takes. */
  pageShare: number;
  elements: { selector: string; text: string | null; weight: number; relX: number; relY: number }[];
  /** How far down people scroll: share reaching 50% of the page. */
  scroll50: number;
}

// Selectors are element ids in the sample page snapshots (`HEATMAP_ELEMENTS` in
// objects-pages.ts), so every click lands on an element the heatmap can draw.
const HOME: HeatTemplate = {
  pageShare: 0.3,
  scroll50: 0.58,
  elements: [
    { selector: '#hero-cta', text: 'Start your free trial', weight: 24, relX: 0.5, relY: 0.5 },
    { selector: '#nav-pricing', text: 'Pricing', weight: 15, relX: 0.45, relY: 0.55 },
    { selector: '#nav-login', text: 'Log in', weight: 12, relX: 0.5, relY: 0.5 },
    { selector: '#hero-secondary', text: 'Book a demo', weight: 9, relX: 0.5, relY: 0.5 },
    { selector: '#feature-crm', text: 'CRM', weight: 7, relX: 0.4, relY: 0.4 },
    { selector: '#feature-helpdesk', text: 'Helpdesk', weight: 6, relX: 0.5, relY: 0.5 },
    { selector: '#feature-mail', text: 'Mail', weight: 5, relX: 0.5, relY: 0.5 },
    { selector: '#nav-features', text: 'Features', weight: 6, relX: 0.5, relY: 0.5 },
    { selector: '#cta-trial', text: 'Start free trial', weight: 5, relX: 0.5, relY: 0.5 },
    { selector: '#footer-contact', text: 'Contact sales', weight: 3, relX: 0.5, relY: 0.5 },
  ],
};

const PRICING: HeatTemplate = {
  pageShare: 0.14,
  scroll50: 0.66,
  elements: [
    { selector: '#plan-business-cta', text: 'Choose Business', weight: 26, relX: 0.5, relY: 0.5 },
    { selector: '#plan-starter-cta', text: 'Choose Starter', weight: 17, relX: 0.5, relY: 0.5 },
    { selector: '#plan-enterprise-cta', text: 'Talk to sales', weight: 8, relX: 0.5, relY: 0.5 },
    { selector: '#cta-trial', text: 'Start free trial', weight: 9, relX: 0.5, relY: 0.5 },
    { selector: '#nav-login', text: 'Log in', weight: 6, relX: 0.5, relY: 0.5 },
    { selector: '#nav-features', text: 'Features', weight: 5, relX: 0.5, relY: 0.5 },
    { selector: '#footer-contact', text: 'Contact sales', weight: 4, relX: 0.5, relY: 0.5 },
  ],
};

const FEATURES: HeatTemplate = {
  pageShare: 0.27,
  scroll50: 0.52,
  elements: [
    { selector: '#hero-cta', text: 'Start your free trial', weight: 20, relX: 0.5, relY: 0.5 },
    { selector: '#nav-pricing', text: 'Pricing', weight: 14, relX: 0.5, relY: 0.5 },
    { selector: '#hero-secondary', text: 'Book a demo', weight: 10, relX: 0.5, relY: 0.5 },
    { selector: '#cta-trial', text: 'Start free trial', weight: 8, relX: 0.5, relY: 0.5 },
    { selector: '#nav-login', text: 'Log in', weight: 6, relX: 0.5, relY: 0.5 },
    { selector: '#nav-blog', text: 'Blog', weight: 4, relX: 0.5, relY: 0.5 },
  ],
};

const BLOG: HeatTemplate = {
  pageShare: 0.08,
  scroll50: 0.44,
  elements: [
    { selector: '#cta-trial', text: 'Start free trial', weight: 12, relX: 0.5, relY: 0.5 },
    { selector: '#nav-pricing', text: 'Pricing', weight: 10, relX: 0.5, relY: 0.5 },
    { selector: '#nav-blog', text: 'Blog', weight: 8, relX: 0.5, relY: 0.5 },
    { selector: '#nav-features', text: 'Features', weight: 6, relX: 0.5, relY: 0.5 },
    { selector: '#footer-contact', text: 'Contact sales', weight: 4, relX: 0.5, relY: 0.5 },
  ],
};

const APP_HOME: HeatTemplate = {
  pageShare: 0.24,
  scroll50: 0.7,
  elements: [
    { selector: '#side-companies', text: 'Companies', weight: 18, relX: 0.4, relY: 0.5 },
    { selector: '#side-tickets', text: 'Tickets', weight: 15, relX: 0.4, relY: 0.5 },
    { selector: '#side-inbox', text: 'Inbox', weight: 11, relX: 0.4, relY: 0.5 },
    { selector: '#row-1', text: null, weight: 10, relX: 0.3, relY: 0.5 },
    { selector: '#side-projects', text: 'Projects', weight: 8, relX: 0.4, relY: 0.5 },
    { selector: '#row-2', text: null, weight: 7, relX: 0.3, relY: 0.5 },
    { selector: '#side-invoices', text: 'Invoices', weight: 6, relX: 0.4, relY: 0.5 },
    { selector: '#side-calendar', text: 'Calendar', weight: 4, relX: 0.4, relY: 0.5 },
  ],
};

function heatTemplate(pattern: string, projectId: string): HeatTemplate {
  if (isApp(projectId)) return APP_HOME;
  if (pattern.startsWith('/pricing')) return PRICING;
  if (pattern.startsWith('/features')) return FEATURES;
  if (pattern.startsWith('/blog')) return BLOG;
  return HOME;
}

const DEVICE_SHARE = { desktop: 0.66, tablet: 0.05, mobile: 0.29 } as const;

export function heatmapResult(spec: PanelHeatmapSpec): PanelHeatmapResult {
  const projectId = spec.projectId;
  const range = resolveRange(spec.dateRange);
  const urlPattern = spec.urlPattern ?? '/';
  const template = heatTemplate(urlPattern, projectId);
  const device = spec.deviceClass;
  const dailyPageviews = eventVolume('$pageview', projectId) * template.pageShare * DEVICE_SHARE[device];
  const pageviews = Math.round(range.days.length * dailyPageviews * 0.93);
  const clicks = Math.round(pageviews * (device === 'desktop' ? 0.74 : 0.52));
  const weightTotal = sum(template.elements.map((e) => e.weight));
  const mapped = 0.88;

  const elements: PanelHeatmapElement[] = template.elements
    .map((e) => {
      const count = Math.max(1, Math.round((clicks * mapped * e.weight) / weightTotal));
      return {
        selector: e.selector,
        text: e.text,
        clicks: count,
        share: round(count / Math.max(1, clicks), 4),
        relX: e.relX,
        relY: e.relY,
      };
    })
    .sort((a, b) => b.clicks - a.clicks);

  const points: PanelHeatmapPoint[] = [];
  for (const element of elements) {
    const template2 = template.elements.find((e) => e.selector === element.selector)!;
    const random = rng(`heat|${projectId}|${element.selector}`);
    const spots = [
      [template2.relX, template2.relY, 0.5],
      [template2.relX - 0.1, template2.relY, 0.22],
      [template2.relX + 0.1, template2.relY, 0.2],
      [template2.relX, template2.relY + 0.1, 0.08],
    ] as const;
    let left = element.clicks;
    spots.forEach(([x, y, share], i) => {
      const count = i === spots.length - 1 ? left : Math.round(element.clicks * share * (0.9 + random() * 0.2));
      left -= count;
      if (count > 0) points.push({ selector: element.selector, relX: round(clamp(x, 0, 1), 1), relY: round(clamp(y, 0, 1), 1), count });
    });
  }

  const leaves = Math.round(pageviews * 0.94);
  const depths = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const decay = Math.log(template.scroll50) / Math.log(0.5);
  const deviceFactor = device === 'mobile' ? 0.93 : 1;
  const buckets = depths.map((depth) => ({
    depth,
    reachedShare: depth === 0 ? 1 : round(clamp((1 - depth / 100) ** (decay * 0.9) * deviceFactor, 0.02, 0.995), 3),
  }));
  for (let i = 1; i < buckets.length; i++) buckets[i]!.reachedShare = Math.min(buckets[i]!.reachedShare, buckets[i - 1]!.reachedShare);

  return {
    range: resolved(range, false, spec.timezone),
    type: spec.type,
    deviceClass: device,
    urlPattern,
    pageviews,
    clicks,
    elements,
    points,
    scroll: { leaves, buckets },
  };
}
