/**
 * The made-up world every WeldPanel sample answer draws from, so the screens
 * agree with each other: one marketing site and one product, the same pages,
 * events, people and companies, and traffic that follows the same daily
 * shape. Numbers are deterministic (seeded by a key), so a reload shows the
 * same data; dates are relative to today, so "Last 30 days" is always full.
 */

import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import type { PanelDateRange, PanelInterval, PanelResolvedRange } from '@weldsuite/app-api-client/schemas/weldpanel-query';

// ---------------------------------------------------------------------------
// Randomness and time
// ---------------------------------------------------------------------------

export const DAY_MS = 86_400_000;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A deterministic random generator (mulberry32) seeded by `key`: the same key gives the same sequence. */
export function rng(key: string): () => number {
  let a = hash(key);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random integer in [min, max] from `random`. */
export function between(random: () => number, min: number, max: number): number {
  return Math.floor(min + random() * (max - min + 1));
}

/** One item of `items` from `random`, optionally weighted. */
export function pick<T>(random: () => number, items: readonly T[], weights?: readonly number[]): T {
  if (!weights) return items[Math.floor(random() * items.length)]!;
  const total = weights.reduce((sum, w) => sum + w, 0);
  let roll = random() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i]!;
    if (roll <= 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

/** Today at local midnight. */
export function today(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** `YYYY-MM-DD` of a date in local time. */
export function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Local midnight `n` days before today. */
export function daysAgo(n: number): Date {
  return new Date(today().getTime() - n * DAY_MS);
}

/** An ISO instant `minutesAgo` minutes before now. */
export function isoMinutesAgo(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

/** An ISO instant `n` days before today, at `hour` local time. */
export function isoDaysAgo(n: number, hour = 10, minute = 0): string {
  const d = daysAgo(n);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

/** Every day from `from` to `to` (YYYY-MM-DD, both inclusive). */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T12:00:00`);
  for (let d = new Date(`${from}T12:00:00`); d <= end; d = new Date(d.getTime() + DAY_MS)) out.push(ymd(d));
  return out;
}

export interface SampleRange {
  from: string;
  to: string;
  /** Every day in the range. */
  days: string[];
  /** The same number of days right before it, for "compare with previous period". */
  previousFrom: string;
  previousTo: string;
}

/** A spec's date range as concrete days; missing or unknown ranges are the last 30 days. */
export function resolveRange(range: PanelDateRange | undefined): SampleRange {
  let from: string;
  let to = ymd(today());
  if (range && 'from' in range) {
    from = range.from;
    to = range.to;
  } else {
    const preset = range?.preset ?? '30d';
    const back = { today: 0, '7d': 6, '30d': 29, '90d': 89, '12m': 364 }[preset] ?? 29;
    from = ymd(daysAgo(back));
  }
  const days = daysBetween(from, to);
  const previousTo = ymd(new Date(new Date(`${from}T12:00:00`).getTime() - DAY_MS));
  const previousFrom = ymd(new Date(new Date(`${previousTo}T12:00:00`).getTime() - (days.length - 1) * DAY_MS));
  return { from, to, days, previousFrom, previousTo };
}

/** `PanelResolvedRange` for a sample range, with the previous period when `compare` is on. */
export function resolvedRange(range: SampleRange, compare = false, timezone = 'Europe/Amsterdam'): PanelResolvedRange {
  return {
    from: new Date(`${range.from}T00:00:00`).toISOString(),
    to: new Date(`${range.to}T23:59:59`).toISOString(),
    timezone,
    clampedToRetention: false,
    previousFrom: compare ? new Date(`${range.previousFrom}T00:00:00`).toISOString() : null,
    previousTo: compare ? new Date(`${range.previousTo}T23:59:59`).toISOString() : null,
  };
}

/**
 * The buckets a time series has over `range` at `interval`: ISO instants of
 * each bucket start. Hourly series cover the last day of the range.
 */
export function bucketsFor(range: SampleRange, interval: PanelInterval = 'day'): string[] {
  if (interval === 'hour') {
    const start = new Date(`${range.to}T00:00:00`);
    return Array.from({ length: 24 }, (_, h) => new Date(start.getTime() + h * 3_600_000).toISOString());
  }
  if (interval === 'day') return range.days.map((d) => new Date(`${d}T00:00:00`).toISOString());
  const out: string[] = [];
  const seen = new Set<string>();
  for (const day of range.days) {
    const d = new Date(`${day}T00:00:00`);
    if (interval === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    else d.setDate(1);
    const key = d.toISOString();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/**
 * A believable traffic curve: `base` per day with a slow upward trend,
 * quieter weekends, a launch spike two weeks ago and some noise. The same
 * `key` and day always give the same value.
 */
export function dailyValue(key: string, day: string, base: number): number {
  const date = new Date(`${day}T12:00:00`);
  const age = Math.round((today().getTime() - date.getTime()) / DAY_MS);
  const weekend = date.getDay() === 0 || date.getDay() === 6 ? 0.62 : 1;
  const trend = 1 + Math.max(-0.4, -age * 0.0016);
  const spike = age >= 13 && age <= 15 ? 1.45 - Math.abs(age - 14) * 0.15 : 1;
  const noise = 0.88 + rng(`${key}|${day}`)() * 0.24;
  return Math.max(0, Math.round(base * weekend * trend * spike * noise));
}

/** `dailyValue` summed per bucket of `interval` (hourly splits the day along a working-day curve). */
export function seriesValues(key: string, range: SampleRange, base: number, interval: PanelInterval = 'day'): number[] {
  if (interval === 'hour') {
    const day = range.to;
    const total = dailyValue(key, day, base);
    const shape = [1, 0.6, 0.4, 0.3, 0.3, 0.5, 1.2, 2.4, 4.2, 5.6, 6, 5.8, 5.2, 5.6, 5.9, 5.5, 4.8, 4, 3.4, 3.1, 2.9, 2.6, 2, 1.4];
    const sum = shape.reduce((a, b) => a + b, 0);
    return shape.map((s, h) => Math.round(((total * s) / sum) * (0.85 + rng(`${key}|${day}|${h}`)() * 0.3)));
  }
  const buckets = bucketsFor(range, interval);
  if (interval === 'day') return range.days.map((day) => dailyValue(key, day, base));
  return buckets.map((start, i) => {
    const next = buckets[i + 1] ? new Date(buckets[i + 1]!) : new Date(`${range.to}T23:59:59`);
    return range.days
      .filter((day) => {
        const d = new Date(`${day}T00:00:00`);
        return d >= new Date(start) && d <= next && (buckets[i + 1] ? d < next : true);
      })
      .reduce((sum, day) => sum + dailyValue(key, day, base), 0);
  });
}

/** Sum of a key's daily values over a range. */
export function rangeTotal(key: string, range: SampleRange, base: number): number {
  return range.days.reduce((sum, day) => sum + dailyValue(key, day, base), 0);
}

/** Total over the previous period of the same length, a little lower so comparisons show growth. */
export function previousTotal(key: string, range: SampleRange, base: number): number {
  const previous = daysBetween(range.previousFrom, range.previousTo);
  return Math.round(previous.reduce((sum, day) => sum + dailyValue(key, day, base), 0) * 0.91);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const WEBSITE_PROJECT_ID = 'pnp_sample_website';
export const APP_PROJECT_ID = 'pnp_sample_app';

export const PROJECTS: PanelProjectDto[] = [
  {
    id: WEBSITE_PROJECT_ID,
    name: 'weldsuite.com',
    kind: 'website',
    status: 'active',
    token: 'wpk_sample_site_7f3a91',
    allowedDomains: ['weldsuite.com', 'www.weldsuite.com'],
    settings: {
      autocapture: true,
      maskingLevel: 'balanced',
      consentMode: 'required',
      recordingSampleRate: 0.5,
      excludedUrls: ['/admin/*'],
      ipFilters: [],
      aiEnabled: true,
    },
    createdByUserId: 'user_sample_1',
    createdAt: isoDaysAgo(240),
    updatedAt: isoDaysAgo(6),
  },
  {
    id: APP_PROJECT_ID,
    name: 'WeldSuite app',
    kind: 'app',
    status: 'active',
    token: 'wpk_sample_app_2c81de',
    allowedDomains: ['app.weldsuite.org'],
    settings: {
      autocapture: true,
      maskingLevel: 'strict',
      consentMode: 'none',
      recordingSampleRate: 0.2,
      excludedUrls: [],
      ipFilters: [],
      aiEnabled: true,
    },
    createdByUserId: 'user_sample_1',
    createdAt: isoDaysAgo(180),
    updatedAt: isoDaysAgo(2),
  },
];

/** The project a request is about; unknown ids get the website. */
export function projectFor(id: string | null | undefined): PanelProjectDto {
  return PROJECTS.find((p) => p.id === id) ?? PROJECTS[0]!;
}

// ---------------------------------------------------------------------------
// Site, traffic sources and audience
// ---------------------------------------------------------------------------

/** Pages of the marketing site with their share of pageviews and a title. */
export const PAGES: ReadonlyArray<{ path: string; title: string; weight: number }> = [
  { path: '/', title: 'WeldSuite: one platform for your whole business', weight: 30 },
  { path: '/pricing', title: 'Pricing · WeldSuite', weight: 14 },
  { path: '/features/crm', title: 'CRM · WeldSuite', weight: 8 },
  { path: '/features/helpdesk', title: 'Helpdesk · WeldSuite', weight: 6.5 },
  { path: '/features/mail', title: 'Mail · WeldSuite', weight: 5 },
  { path: '/features/accounting', title: 'Accounting · WeldSuite', weight: 4.2 },
  { path: '/features/analytics', title: 'Analytics · WeldSuite', weight: 3.6 },
  { path: '/signup', title: 'Create your account · WeldSuite', weight: 7 },
  { path: '/login', title: 'Sign in · WeldSuite', weight: 6 },
  { path: '/blog', title: 'Blog · WeldSuite', weight: 3.4 },
  { path: '/blog/replacing-ten-tools-with-one', title: 'How we replaced ten tools with one', weight: 2.8 },
  { path: '/blog/eu-data-residency', title: 'Your data stays in the EU', weight: 2.2 },
  { path: '/customers', title: 'Customers · WeldSuite', weight: 2.1 },
  { path: '/docs/getting-started', title: 'Getting started · Docs', weight: 2.6 },
  { path: '/contact', title: 'Contact sales · WeldSuite', weight: 1.6 },
  { path: '/about', title: 'About us · WeldSuite', weight: 1.2 },
];

/** Product screens, for the app project. */
export const APP_SCREENS: ReadonlyArray<{ path: string; title: string; weight: number }> = [
  { path: '/home', title: 'Home', weight: 24 },
  { path: '/weldcrm/companies', title: 'Companies', weight: 14 },
  { path: '/welddesk/tickets', title: 'Tickets', weight: 13 },
  { path: '/weldmail/inbox', title: 'Inbox', weight: 12 },
  { path: '/weldflow/projects', title: 'Projects', weight: 9 },
  { path: '/weldbooks/invoices', title: 'Invoices', weight: 7 },
  { path: '/weldcalendar', title: 'Calendar', weight: 6 },
  { path: '/settings/members', title: 'Members', weight: 3 },
  { path: '/settings/billing', title: 'Billing', weight: 2 },
];

export const REFERRERS: ReadonlyArray<{ host: string; channel: string; weight: number }> = [
  { host: '(direct)', channel: 'Direct', weight: 31 },
  { host: 'google.com', channel: 'Organic search', weight: 34 },
  { host: 'linkedin.com', channel: 'Organic social', weight: 9 },
  { host: 'bing.com', channel: 'Organic search', weight: 4 },
  { host: 'duckduckgo.com', channel: 'Organic search', weight: 3 },
  { host: 'x.com', channel: 'Organic social', weight: 3.5 },
  { host: 'news.ycombinator.com', channel: 'Referral', weight: 3 },
  { host: 'producthunt.com', channel: 'Referral', weight: 2.4 },
  { host: 'github.com', channel: 'Referral', weight: 2 },
  { host: 'newsletter', channel: 'Email', weight: 4.5 },
  { host: 'google ads', channel: 'Paid search', weight: 3.6 },
];

export const UTM_CAMPAIGNS: ReadonlyArray<{ campaign: string; source: string; medium: string; weight: number }> = [
  { campaign: 'november-newsletter', source: 'newsletter', medium: 'email', weight: 34 },
  { campaign: 'crm-launch', source: 'linkedin', medium: 'social', weight: 26 },
  { campaign: 'brand-search', source: 'google', medium: 'cpc', weight: 22 },
  { campaign: 'product-hunt', source: 'producthunt', medium: 'referral', weight: 11 },
  { campaign: 'webinar-eu-data', source: 'newsletter', medium: 'email', weight: 7 },
];

export const COUNTRIES: ReadonlyArray<{ code: string; name: string; weight: number; cities: string[] }> = [
  { code: 'NL', name: 'Netherlands', weight: 34, cities: ['Amsterdam', 'Rotterdam', 'Utrecht', 'Eindhoven', 'Groningen'] },
  { code: 'US', name: 'United States', weight: 17, cities: ['New York', 'San Francisco', 'Austin', 'Chicago'] },
  { code: 'DE', name: 'Germany', weight: 12, cities: ['Berlin', 'Munich', 'Hamburg', 'Cologne'] },
  { code: 'BE', name: 'Belgium', weight: 9, cities: ['Antwerp', 'Brussels', 'Ghent'] },
  { code: 'GB', name: 'United Kingdom', weight: 8, cities: ['London', 'Manchester', 'Bristol'] },
  { code: 'FR', name: 'France', weight: 5, cities: ['Paris', 'Lyon'] },
  { code: 'ES', name: 'Spain', weight: 3.5, cities: ['Madrid', 'Barcelona'] },
  { code: 'IN', name: 'India', weight: 3.5, cities: ['Bengaluru', 'Mumbai'] },
  { code: 'BR', name: 'Brazil', weight: 2.5, cities: ['São Paulo'] },
  { code: 'CA', name: 'Canada', weight: 2.2, cities: ['Toronto', 'Vancouver'] },
  { code: 'AU', name: 'Australia', weight: 1.6, cities: ['Sydney'] },
  { code: 'SE', name: 'Sweden', weight: 1.7, cities: ['Stockholm'] },
];

export const BROWSERS = [
  { name: 'Chrome', weight: 58 },
  { name: 'Safari', weight: 22 },
  { name: 'Edge', weight: 8 },
  { name: 'Firefox', weight: 7 },
  { name: 'Samsung Internet', weight: 2.5 },
  { name: 'Opera', weight: 1.5 },
] as const;

export const OPERATING_SYSTEMS = [
  { name: 'macOS', weight: 36 },
  { name: 'Windows', weight: 31 },
  { name: 'iOS', weight: 17 },
  { name: 'Android', weight: 11 },
  { name: 'Linux', weight: 4 },
  { name: 'ChromeOS', weight: 1 },
] as const;

export const DEVICES = [
  { name: 'desktop', weight: 66 },
  { name: 'mobile', weight: 29 },
  { name: 'tablet', weight: 5 },
] as const;

/** Custom and standard events, with roughly how often they happen per day on the website (`site`) and in the app (`app`). */
export const EVENTS: ReadonlyArray<{ name: string; description: string; perDay: { site: number; app: number } }> = [
  { name: '$pageview', description: 'A page was viewed', perDay: { site: 4200, app: 9800 } },
  { name: '$autocapture', description: 'A click, change or submit, captured automatically', perDay: { site: 6100, app: 15400 } },
  { name: '$pageleave', description: 'A page was left', perDay: { site: 3600, app: 7200 } },
  { name: 'signup_started', description: 'Opened the sign-up form', perDay: { site: 210, app: 0 } },
  { name: 'signup_completed', description: 'Created an account', perDay: { site: 84, app: 0 } },
  { name: 'trial_started', description: 'Started a free trial', perDay: { site: 61, app: 12 } },
  { name: 'demo_requested', description: 'Asked sales for a demo', perDay: { site: 17, app: 0 } },
  { name: 'newsletter_subscribed', description: 'Subscribed to the newsletter', perDay: { site: 46, app: 0 } },
  { name: 'workspace_created', description: 'Created a workspace', perDay: { site: 0, app: 58 } },
  { name: 'member_invited', description: 'Invited a teammate', perDay: { site: 0, app: 140 } },
  { name: 'module_installed', description: 'Installed a module from the App Store', perDay: { site: 0, app: 96 } },
  { name: 'ticket_created', description: 'Created a helpdesk ticket', perDay: { site: 0, app: 620 } },
  { name: 'email_sent', description: 'Sent an email from WeldMail', perDay: { site: 0, app: 1850 } },
  { name: 'invoice_sent', description: 'Sent an invoice', perDay: { site: 0, app: 230 } },
  { name: 'plan_upgraded', description: 'Moved to a paid plan', perDay: { site: 0, app: 9 } },
  { name: 'checkout_completed', description: 'Paid for a subscription', perDay: { site: 0, app: 11 } },
];

/** Event names a spec may refer to that aren't in `EVENTS` still get a small, steady volume. */
export function eventPerDay(name: string, projectId: string): number {
  const event = EVENTS.find((e) => e.name === name);
  const volume = projectId === APP_PROJECT_ID ? event?.perDay.app : event?.perDay.site;
  const perDay = volume ?? 0;
  return perDay > 0 ? perDay : 20 + (rng(name)() * 60);
}

// ---------------------------------------------------------------------------
// People and companies
// ---------------------------------------------------------------------------

export interface SamplePerson {
  distinctId: string;
  name: string;
  email: string;
  company: string;
  country: string;
  city: string;
  browser: string;
  os: string;
  device: string;
  plan: 'free' | 'trial' | 'starter' | 'business' | 'enterprise';
  role: string;
  firstSeen: string;
  lastSeen: string;
  sessions: number;
  pageviews: number;
}

export interface SampleCompany {
  key: string;
  name: string;
  domain: string;
  industry: string;
  employees: number;
  plan: SamplePerson['plan'];
  country: string;
  mrr: number;
}

export const COMPANIES: SampleCompany[] = [
  { key: 'grt', name: 'Groenteman Installatietechniek', domain: 'groenteman.nl', industry: 'Construction', employees: 48, plan: 'business', country: 'NL', mrr: 890 },
  { key: 'nrd', name: 'Nordwind Logistik', domain: 'nordwind-logistik.de', industry: 'Logistics', employees: 212, plan: 'enterprise', country: 'DE', mrr: 4200 },
  { key: 'lmn', name: 'Lumen Coffee Roasters', domain: 'lumencoffee.com', industry: 'Retail', employees: 26, plan: 'starter', country: 'US', mrr: 290 },
  { key: 'vdb', name: 'Van den Berg Advocaten', domain: 'vdbadvocaten.nl', industry: 'Legal', employees: 34, plan: 'business', country: 'NL', mrr: 640 },
  { key: 'atl', name: 'Atlas Property Group', domain: 'atlasproperty.co.uk', industry: 'Real estate', employees: 95, plan: 'business', country: 'GB', mrr: 1450 },
  { key: 'kwk', name: 'Kwekerij De Linde', domain: 'kwekerijdelinde.nl', industry: 'Agriculture', employees: 18, plan: 'starter', country: 'NL', mrr: 180 },
  { key: 'brx', name: 'Brixton Studio', domain: 'brixtonstudio.io', industry: 'Design agency', employees: 12, plan: 'trial', country: 'GB', mrr: 0 },
  { key: 'stl', name: 'Stellar Fitness', domain: 'stellarfitness.be', industry: 'Health and fitness', employees: 67, plan: 'business', country: 'BE', mrr: 980 },
  { key: 'mrc', name: 'Mercator Shipping', domain: 'mercatorshipping.be', industry: 'Logistics', employees: 340, plan: 'enterprise', country: 'BE', mrr: 6100 },
  { key: 'hlx', name: 'Helix Biotech', domain: 'helixbio.com', industry: 'Life sciences', employees: 150, plan: 'enterprise', country: 'US', mrr: 3800 },
  { key: 'pmr', name: 'Pommeraie Boulangerie', domain: 'pommeraie.fr', industry: 'Food and drink', employees: 22, plan: 'starter', country: 'FR', mrr: 210 },
  { key: 'snd', name: 'Sundial Solar', domain: 'sundialsolar.es', industry: 'Energy', employees: 58, plan: 'business', country: 'ES', mrr: 760 },
  { key: 'fjd', name: 'Fjord Digital', domain: 'fjorddigital.se', industry: 'Software', employees: 31, plan: 'trial', country: 'SE', mrr: 0 },
  { key: 'tgr', name: 'Tiger Tutoring', domain: 'tigertutoring.in', industry: 'Education', employees: 44, plan: 'free', country: 'IN', mrr: 0 },
  { key: 'bkm', name: 'Bakker & Meijer Accountants', domain: 'bakkermeijer.nl', industry: 'Accounting', employees: 29, plan: 'business', country: 'NL', mrr: 520 },
];

const FIRST_NAMES = ['Sanne', 'Daan', 'Emma', 'Lucas', 'Julia', 'Noah', 'Fleur', 'Milan', 'Lotte', 'Sem', 'Anna', 'Jonas', 'Sophie', 'Lena', 'Max', 'Olivia', 'Liam', 'Mia', 'Ethan', 'Chloé', 'Mateo', 'Priya', 'Arjun', 'Freya', 'Oscar', 'Isabel', 'Tom', 'Eva', 'Ruben', 'Nina'];
const LAST_NAMES = ['de Vries', 'Jansen', 'Bakker', 'Visser', 'Smit', 'Meijer', 'Müller', 'Schmidt', 'Peeters', 'Janssens', 'Taylor', 'Brown', 'Martin', 'Dubois', 'García', 'Sharma', 'Lindqvist', 'Mulder', 'de Boer', 'Dekker', 'Hendriks', 'Wright', 'Becker', 'Fischer', 'Kowalski'];
const ROLES = ['Founder', 'Operations manager', 'Head of sales', 'Office manager', 'Customer support lead', 'Finance', 'Marketing lead', 'Developer', 'Account manager', 'CEO'];

/** 60 people across the companies, plus anonymous visitors handled by the areas themselves. */
export const PEOPLE: SamplePerson[] = Array.from({ length: 60 }, (_, i) => {
  const random = rng(`person-${i}`);
  const company = COMPANIES[i % COMPANIES.length]!;
  const country = COUNTRIES.find((c) => c.code === company.country) ?? COUNTRIES[0]!;
  const first = FIRST_NAMES[i % FIRST_NAMES.length]!;
  const last = LAST_NAMES[(i * 7) % LAST_NAMES.length]!;
  const firstSeenDays = between(random, 3, 220);
  const lastSeenDays = Math.min(firstSeenDays, between(random, 0, i < 20 ? 2 : 40));
  const email = `${first.toLowerCase().replace(/[^a-z]/g, '')}.${last.toLowerCase().replace(/[^a-z]/g, '')}@${company.domain}`;
  return {
    distinctId: `usr_${(hash(email) % 1e9).toString(36)}${i}`,
    name: `${first} ${last}`,
    email,
    company: company.name,
    country: country.code,
    city: pick(random, country.cities),
    browser: pick(random, BROWSERS.map((b) => b.name), BROWSERS.map((b) => b.weight)),
    os: pick(random, OPERATING_SYSTEMS.map((o) => o.name), OPERATING_SYSTEMS.map((o) => o.weight)),
    device: pick(random, DEVICES.map((d) => d.name), DEVICES.map((d) => d.weight)),
    plan: company.plan,
    role: ROLES[(i * 3) % ROLES.length]!,
    firstSeen: isoDaysAgo(firstSeenDays, between(random, 8, 18), between(random, 0, 59)),
    lastSeen: lastSeenDays === 0 ? isoMinutesAgo(between(random, 2, 300)) : isoDaysAgo(lastSeenDays, between(random, 8, 20), between(random, 0, 59)),
    sessions: between(random, 2, 140),
    pageviews: between(random, 8, 900),
  };
});

export function personById(distinctId: string): SamplePerson | undefined {
  return PEOPLE.find((p) => p.distinctId === distinctId);
}

/** Workspace members who own reports, dashboards, comments and alerts. */
export const MEMBERS = [
  { userId: 'user_sample_1', name: 'Daniel S', email: 'daniel@example.com' },
  { userId: 'user_sample_2', name: 'Sanne de Vries', email: 'sanne@example.com' },
  { userId: 'user_sample_3', name: 'Lucas Jansen', email: 'lucas@example.com' },
  { userId: 'user_sample_4', name: 'Priya Sharma', email: 'priya@example.com' },
] as const;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** `{ data }` */
export function data<T>(value: T): { data: T } {
  return { data: value };
}

/** `{ data, pagination }` for a full list. */
export function list<T>(items: T[]): { data: T[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } } {
  return { data: items, pagination: { totalCount: items.length, hasMore: false, cursor: null } };
}

/** A random number from 0 up to (not including) 1, for the things that should differ on every call. */
export function randomFraction(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
}

/** A random lower-case letters and digits string of `length` characters, for tokens and keys. */
export function randomToken(length: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => (byte % 36).toString(36)).join('');
}

/** A new sample id, e.g. `pnrv_k3j2h9x1`. */
export function sampleId(prefix: string): string {
  return `${prefix}_${randomToken(8)}`;
}

// ---------------------------------------------------------------------------
// Shared object ids, so areas point at the same reports, dashboards, cohorts
// and recordings (an alert watches a sample report, a recording row opens the
// session that has a detail, and so on).
// ---------------------------------------------------------------------------

export const REPORT_REFS = [
  { id: 'rep_sample_signups', name: 'Sign-ups per day', kind: 'trends', projectId: WEBSITE_PROJECT_ID },
  { id: 'rep_sample_trial_funnel', name: 'Visit to paid customer', kind: 'funnel', projectId: WEBSITE_PROJECT_ID },
  { id: 'rep_sample_retention', name: 'Weekly retention', kind: 'retention', projectId: APP_PROJECT_ID },
  { id: 'rep_sample_pricing_paths', name: 'Where people go after pricing', kind: 'flows', projectId: WEBSITE_PROJECT_ID },
  { id: 'rep_sample_module_usage', name: 'Module usage', kind: 'trends', projectId: APP_PROJECT_ID },
  { id: 'rep_sample_stickiness', name: 'How often teams come back', kind: 'stickiness', projectId: APP_PROJECT_ID },
  { id: 'rep_sample_lifecycle', name: 'New, returning and dormant users', kind: 'lifecycle', projectId: APP_PROJECT_ID },
  { id: 'rep_sample_vitals', name: 'Core web vitals', kind: 'vitals', projectId: WEBSITE_PROJECT_ID },
  { id: 'rep_sample_campaigns', name: 'Sign-ups by campaign', kind: 'trends', projectId: WEBSITE_PROJECT_ID },
  { id: 'rep_sample_checkout_funnel', name: 'Checkout funnel', kind: 'funnel', projectId: APP_PROJECT_ID },
] as const;

export const DASHBOARD_REFS = [
  { id: 'dash_sample_growth', name: 'Growth', projectId: WEBSITE_PROJECT_ID },
  { id: 'dash_sample_product', name: 'Product health', projectId: APP_PROJECT_ID },
  { id: 'dash_sample_marketing', name: 'Marketing site', projectId: WEBSITE_PROJECT_ID },
] as const;

export const COHORT_REFS = [
  { id: 'coh_sample_power', name: 'Power users', size: 412 },
  { id: 'coh_sample_trials', name: 'Trials started this month', size: 1186 },
  { id: 'coh_sample_at_risk', name: 'At risk of churning', size: 97 },
  { id: 'coh_sample_nl_smb', name: 'Dutch small businesses', size: 2304 },
] as const;

export interface SampleSession {
  sessionId: string;
  /** A known person, or null for an anonymous visitor. */
  distinctId: string | null;
  anonymousId: string;
  startedAt: string;
  durationSeconds: number;
  activeSeconds: number;
  pageviews: number;
  events: number;
  entryPath: string;
  exitPath: string;
  country: string;
  city: string;
  browser: string;
  os: string;
  device: string;
  referrerHost: string;
  rageClicks: number;
  deadClicks: number;
  errors: number;
  /** The pages visited, in order. */
  pages: string[];
}

/** 48 recorded sessions over the last two weeks, newest first. */
export const SESSIONS: SampleSession[] = Array.from({ length: 48 }, (_, i) => {
  const random = rng(`session-${i}`);
  const anonKey = `anon-${i}`;
  const person = i % 3 === 2 ? null : PEOPLE[(i * 5) % PEOPLE.length]!;
  const country = person ? (COUNTRIES.find((c) => c.code === person.country) ?? COUNTRIES[0]!) : pick(random, COUNTRIES, COUNTRIES.map((c) => c.weight));
  const pageCount = between(random, 1, 9);
  const pages = Array.from({ length: pageCount }, (_, p) => (p === 0 ? pick(random, PAGES.map((x) => x.path), PAGES.map((x) => x.weight)) : pick(random, PAGES.map((x) => x.path))));
  const durationSeconds = pageCount === 1 ? between(random, 8, 70) : between(random, 60, 1400);
  const minutesAgo = Math.round(i * 410 + random() * 300 + 4);
  return {
    sessionId: `ses_sample_${String(i + 1).padStart(3, '0')}`,
    distinctId: person?.distinctId ?? null,
    anonymousId: `anon_${(hash(anonKey) % 1e8).toString(36)}`,
    startedAt: isoMinutesAgo(minutesAgo),
    durationSeconds,
    activeSeconds: Math.round(durationSeconds * (0.45 + random() * 0.45)),
    pageviews: pageCount,
    events: pageCount * between(random, 3, 14),
    entryPath: pages[0]!,
    exitPath: pages[pages.length - 1]!,
    country: country.code,
    city: person?.city ?? pick(random, country.cities),
    browser: person?.browser ?? pick(random, BROWSERS.map((b) => b.name), BROWSERS.map((b) => b.weight)),
    os: person?.os ?? pick(random, OPERATING_SYSTEMS.map((o) => o.name), OPERATING_SYSTEMS.map((o) => o.weight)),
    device: person?.device ?? pick(random, DEVICES.map((d) => d.name), DEVICES.map((d) => d.weight)),
    referrerHost: pick(random, REFERRERS.map((r) => r.host), REFERRERS.map((r) => r.weight)),
    rageClicks: i % 7 === 3 ? between(random, 1, 4) : 0,
    deadClicks: i % 5 === 1 ? between(random, 1, 6) : 0,
    errors: i % 9 === 4 ? between(random, 1, 3) : 0,
    pages,
  };
});

export function sessionById(sessionId: string): SampleSession {
  return SESSIONS.find((s) => s.sessionId === sessionId) ?? SESSIONS[0]!;
}
