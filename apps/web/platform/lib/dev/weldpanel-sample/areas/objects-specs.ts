/**
 * The saved objects of the sample world: reports (each a real, valid query
 * spec), dashboards laid out on the 24-column grid, the dashboard templates
 * and the cohorts. Ids and names come from `REPORT_REFS`, `DASHBOARD_REFS`
 * and `COHORT_REFS`, which other sample areas point at.
 */

import type { PanelDashboardTemplateDto, PanelDashboardTemplateId, PanelTemplateLocale } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelCohortDto, PanelDashboardDto, PanelDashboardTileDto, PanelReportDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelCohortFilter, PanelReportSpec, PanelReportSpecKind } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { APP_PROJECT_ID, COHORT_REFS, DASHBOARD_REFS, MEMBERS, REPORT_REFS, WEBSITE_PROJECT_ID, isoDaysAgo } from '../dataset';

const OWNERS = MEMBERS.map((m) => m.userId);

function owner(index: number): string {
  return OWNERS[index % OWNERS.length]!;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** A sensible spec of `kind`, for reports made from templates and for the extra sample reports. */
export function defaultSpec(kind: PanelReportSpecKind, projectId: string): PanelReportSpec {
  const dateRange = { preset: '30d' } as const;
  const app = projectId === APP_PROJECT_ID;
  switch (kind) {
    case 'web':
      return { kind: 'web', projectId, dateRange, compare: true, limit: 10 };
    case 'trends':
      return {
        kind: 'trends',
        projectId,
        dateRange,
        interval: 'day',
        series: [{ event: '$pageview', label: 'Page views', math: 'total' }, { event: '$pageview', label: 'Visitors', math: 'unique_users' }],
        compare: true,
        display: 'line',
      };
    case 'funnel':
      return {
        kind: 'funnel',
        projectId,
        dateRange,
        steps: app
          ? [{ event: 'workspace_created', label: 'Created a workspace' }, { event: 'member_invited', label: 'Invited a teammate' }, { event: 'trial_started', label: 'Started a trial' }]
          : [{ event: '$pageview', label: 'Visited the site' }, { event: 'signup_started', label: 'Opened sign-up' }, { event: 'signup_completed', label: 'Created an account' }],
        window: { value: 14, unit: 'day' },
      };
    case 'retention':
      return { kind: 'retention', projectId, dateRange: { preset: '90d' }, firstEvent: app ? 'workspace_created' : 'signup_completed', returnEvent: '$pageview', interval: 'week', periods: 8 };
    case 'flows':
      return { kind: 'flows', projectId, dateRange, anchor: { event: '$pageview', filters: [{ source: 'column', field: 'path', operator: 'eq', value: app ? '/home' : '/' }] }, direction: 'after', depth: 3, limit: 20 };
    case 'stickiness':
      return { kind: 'stickiness', projectId, dateRange, event: app ? 'email_sent' : '$pageview', interval: 'day', measure: 'intervals' };
    case 'lifecycle':
      return { kind: 'lifecycle', projectId, dateRange: { preset: '90d' }, event: '$pageview', interval: 'week' };
    case 'vitals':
      return { kind: 'vitals', projectId, dateRange, metric: 'lcp', percentile: 'p75', interval: 'day', limit: 10 };
    case 'impact':
      return {
        kind: 'impact',
        projectId,
        dateRange: { preset: '90d' },
        launchEvent: 'module_installed',
        launchDate: isoDaysAgo(34).slice(0, 10),
        metric: { event: app ? 'invoice_sent' : 'signup_completed', math: 'unique_users' },
        windowDays: 28,
      };
    case 'signal':
      return { kind: 'signal', projectId, dateRange, goal: { event: app ? 'plan_upgraded' : 'trial_started' }, topN: 10, windowDays: 7 };
  }
}

interface ReportSeed {
  id: string;
  projectId: string;
  name: string;
  description: string;
  spec: PanelReportSpec;
  visibility: 'private' | 'workspace';
  ownerIndex: number;
  createdDaysAgo: number;
  updatedDaysAgo: number;
}

function reportSeeds(): ReportSeed[] {
  const ref = (id: string) => REPORT_REFS.find((r) => r.id === id)!;
  const site = WEBSITE_PROJECT_ID;
  const app = APP_PROJECT_ID;
  const seeds: ReportSeed[] = [
    {
      id: 'rep_sample_signups',
      projectId: site,
      name: ref('rep_sample_signups').name,
      description: 'How many people start and finish sign-up each day, and how it moves week over week.',
      visibility: 'workspace',
      ownerIndex: 1,
      createdDaysAgo: 118,
      updatedDaysAgo: 3,
      spec: {
        kind: 'trends',
        projectId: site,
        dateRange: { preset: '30d' },
        interval: 'day',
        series: [{ event: 'signup_started', label: 'Started sign-up', math: 'unique_users' }, { event: 'signup_completed', label: 'Created an account', math: 'unique_users' }],
        compare: true,
        display: 'line',
      },
    },
    {
      id: 'rep_sample_trial_funnel',
      projectId: site,
      name: ref('rep_sample_trial_funnel').name,
      description: 'The path from a first visit to a paying customer, with a two-week window.',
      visibility: 'workspace',
      ownerIndex: 0,
      createdDaysAgo: 140,
      updatedDaysAgo: 5,
      spec: {
        kind: 'funnel',
        projectId: site,
        dateRange: { preset: '30d' },
        steps: [
          { event: '$pageview', label: 'Visited the site' },
          { event: 'signup_started', label: 'Opened sign-up' },
          { event: 'signup_completed', label: 'Created an account' },
          { event: 'trial_started', label: 'Started a trial' },
          { event: 'checkout_completed', label: 'Paid' },
        ],
        window: { value: 14, unit: 'day' },
        order: 'loose',
        breakdown: { source: 'column', field: 'device_type', limit: 3 },
      },
    },
    {
      id: 'rep_sample_retention',
      projectId: app,
      name: ref('rep_sample_retention').name,
      description: 'Of the teams that created a workspace, how many come back each week.',
      visibility: 'workspace',
      ownerIndex: 3,
      createdDaysAgo: 96,
      updatedDaysAgo: 9,
      spec: { kind: 'retention', projectId: app, dateRange: { preset: '90d' }, firstEvent: 'workspace_created', returnEvent: '$pageview', interval: 'week', periods: 8, mode: 'first_time' },
    },
    {
      id: 'rep_sample_pricing_paths',
      projectId: site,
      name: ref('rep_sample_pricing_paths').name,
      description: 'The pages visitors open right after the pricing page.',
      visibility: 'private',
      ownerIndex: 1,
      createdDaysAgo: 41,
      updatedDaysAgo: 12,
      spec: { kind: 'flows', projectId: site, dateRange: { preset: '30d' }, anchor: { event: '$pageview', filters: [{ source: 'column', field: 'path', operator: 'eq', value: '/pricing' }] }, direction: 'after', depth: 3, scope: 'pageviews', limit: 20 },
    },
    {
      id: 'rep_sample_module_usage',
      projectId: app,
      name: ref('rep_sample_module_usage').name,
      description: 'The everyday actions that show which modules teams really use.',
      visibility: 'workspace',
      ownerIndex: 3,
      createdDaysAgo: 74,
      updatedDaysAgo: 2,
      spec: {
        kind: 'trends',
        projectId: app,
        dateRange: { preset: '30d' },
        interval: 'day',
        series: [
          { event: 'ticket_created', label: 'Tickets created', math: 'total' },
          { event: 'email_sent', label: 'Emails sent', math: 'total' },
          { event: 'invoice_sent', label: 'Invoices sent', math: 'total' },
          { event: 'module_installed', label: 'Modules installed', math: 'total' },
        ],
        display: 'area',
      },
    },
    {
      id: 'rep_sample_stickiness',
      projectId: app,
      name: ref('rep_sample_stickiness').name,
      description: 'On how many days of the month people send an email.',
      visibility: 'workspace',
      ownerIndex: 2,
      createdDaysAgo: 63,
      updatedDaysAgo: 20,
      spec: { kind: 'stickiness', projectId: app, dateRange: { preset: '30d' }, event: 'email_sent', interval: 'day', measure: 'intervals' },
    },
    {
      id: 'rep_sample_lifecycle',
      projectId: app,
      name: ref('rep_sample_lifecycle').name,
      description: 'Who is new, who returns, who resurrects and who has gone quiet, per week.',
      visibility: 'private',
      ownerIndex: 0,
      createdDaysAgo: 58,
      updatedDaysAgo: 8,
      spec: { kind: 'lifecycle', projectId: app, dateRange: { preset: '90d' }, event: '$pageview', interval: 'week' },
    },
    {
      id: 'rep_sample_vitals',
      projectId: site,
      name: ref('rep_sample_vitals').name,
      description: 'Loading speed at the 75th percentile, for the slowest pages first.',
      visibility: 'workspace',
      ownerIndex: 2,
      createdDaysAgo: 33,
      updatedDaysAgo: 6,
      spec: { kind: 'vitals', projectId: site, dateRange: { preset: '30d' }, metric: 'lcp', percentile: 'p75', interval: 'day', limit: 10 },
    },
    {
      id: 'rep_sample_campaigns',
      projectId: site,
      name: ref('rep_sample_campaigns').name,
      description: 'Which campaigns bring people who actually finish sign-up.',
      visibility: 'workspace',
      ownerIndex: 1,
      createdDaysAgo: 27,
      updatedDaysAgo: 1,
      spec: {
        kind: 'trends',
        projectId: site,
        dateRange: { preset: '30d' },
        interval: 'week',
        series: [{ event: 'signup_completed', label: 'Sign-ups', math: 'unique_users' }],
        breakdown: { source: 'column', field: 'utm_campaign', limit: 5 },
        display: 'bar',
      },
    },
    {
      id: 'rep_sample_checkout_funnel',
      projectId: app,
      name: ref('rep_sample_checkout_funnel').name,
      description: 'From a new workspace to the first payment.',
      visibility: 'workspace',
      ownerIndex: 3,
      createdDaysAgo: 52,
      updatedDaysAgo: 4,
      spec: {
        kind: 'funnel',
        projectId: app,
        dateRange: { preset: '90d' },
        steps: [
          { event: 'workspace_created', label: 'Created a workspace' },
          { event: 'trial_started', label: 'Started a trial' },
          { event: 'plan_upgraded', label: 'Chose a plan' },
          { event: 'checkout_completed', label: 'Paid' },
        ],
        window: { value: 30, unit: 'day' },
      },
    },
    // Extra reports, so every report kind has something to show.
    {
      id: 'rep_sample_web_overview',
      projectId: site,
      name: 'Marketing site overview',
      description: 'Traffic, sources, countries and devices in one place.',
      visibility: 'workspace',
      ownerIndex: 1,
      createdDaysAgo: 150,
      updatedDaysAgo: 1,
      spec: defaultSpec('web', site),
    },
    {
      id: 'rep_sample_impact',
      projectId: app,
      name: 'Effect of the new App Store',
      description: 'Did sign-ups to invoicing go up after modules became easier to install?',
      visibility: 'private',
      ownerIndex: 3,
      createdDaysAgo: 30,
      updatedDaysAgo: 7,
      spec: defaultSpec('impact', app),
    },
    {
      id: 'rep_sample_signal',
      projectId: app,
      name: 'What predicts a paid upgrade',
      description: 'The actions that most often come before a team moves to a paid plan.',
      visibility: 'workspace',
      ownerIndex: 2,
      createdDaysAgo: 22,
      updatedDaysAgo: 10,
      spec: defaultSpec('signal', app),
    },
  ];
  return seeds;
}

export function seedReports(): PanelReportDto[] {
  return reportSeeds().map((s) => ({
    id: s.id,
    projectId: s.projectId,
    kind: s.spec.kind as PanelReportDto['kind'],
    name: s.name,
    description: s.description,
    spec: { ...s.spec },
    ownerUserId: owner(s.ownerIndex),
    visibility: s.visibility,
    createdAt: isoDaysAgo(s.createdDaysAgo, 11),
    updatedAt: isoDaysAgo(s.updatedDaysAgo, 15),
  }));
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

export interface TileSeed {
  id: string;
  dashboardId: string;
  kind: 'report' | 'text';
  reportId: string | null;
  text: string | null;
  layout: PanelDashboardTileDto['layout'];
}

function tile(dashboardId: string, n: number, reportId: string, layout: PanelDashboardTileDto['layout']): TileSeed {
  return { id: `${dashboardId}_t${n}`, dashboardId, kind: 'report', reportId, text: null, layout };
}

function textTile(dashboardId: string, n: number, text: string, layout: PanelDashboardTileDto['layout']): TileSeed {
  return { id: `${dashboardId}_t${n}`, dashboardId, kind: 'text', reportId: null, text, layout };
}

export function seedDashboards(): { dashboards: PanelDashboardDto[]; tiles: TileSeed[] } {
  const [growth, product, marketing] = DASHBOARD_REFS;
  const dashboards: PanelDashboardDto[] = [
    {
      id: growth.id,
      projectId: growth.projectId,
      name: growth.name,
      description: 'Sign-ups, trials and paying customers, week by week. Reviewed in the Monday growth meeting.',
      ownerUserId: owner(0),
      visibility: 'workspace',
      filters: { dateRange: { preset: '30d' }, filters: [] },
      template: null,
      createdAt: isoDaysAgo(130, 9),
      updatedAt: isoDaysAgo(2, 16),
    },
    {
      id: product.id,
      projectId: product.projectId,
      name: product.name,
      description: 'Whether teams stick around and which modules they use.',
      ownerUserId: owner(3),
      visibility: 'workspace',
      filters: { dateRange: { preset: '90d' }, filters: [] },
      template: 'product-health',
      createdAt: isoDaysAgo(88, 10),
      updatedAt: isoDaysAgo(5, 14),
    },
    {
      id: marketing.id,
      projectId: marketing.projectId,
      name: marketing.name,
      description: 'Traffic, paths and page speed on weldsuite.com.',
      ownerUserId: owner(1),
      visibility: 'private',
      filters: { dateRange: { preset: '7d' }, filters: [] },
      template: null,
      createdAt: isoDaysAgo(45, 13),
      updatedAt: isoDaysAgo(1, 9),
    },
  ];
  const g = growth.id;
  const p = product.id;
  const m = marketing.id;
  const tiles: TileSeed[] = [
    textTile(g, 1, '**Goal this quarter:** 2,500 sign-ups a month and 8% of them on a paid plan.', { x: 0, y: 0, w: 24, h: 2 }),
    tile(g, 2, 'rep_sample_signups', { x: 0, y: 2, w: 14, h: 8 }),
    tile(g, 3, 'rep_sample_campaigns', { x: 14, y: 2, w: 10, h: 8 }),
    tile(g, 4, 'rep_sample_trial_funnel', { x: 0, y: 10, w: 24, h: 9 }),
    tile(p, 1, 'rep_sample_retention', { x: 0, y: 0, w: 12, h: 9 }),
    tile(p, 2, 'rep_sample_stickiness', { x: 12, y: 0, w: 12, h: 9 }),
    tile(p, 3, 'rep_sample_module_usage', { x: 0, y: 9, w: 16, h: 8 }),
    tile(p, 4, 'rep_sample_lifecycle', { x: 16, y: 9, w: 8, h: 8 }),
    tile(p, 5, 'rep_sample_checkout_funnel', { x: 0, y: 17, w: 24, h: 8 }),
    tile(m, 1, 'rep_sample_web_overview', { x: 0, y: 0, w: 24, h: 11 }),
    tile(m, 2, 'rep_sample_vitals', { x: 0, y: 11, w: 12, h: 8 }),
    tile(m, 3, 'rep_sample_pricing_paths', { x: 12, y: 11, w: 12, h: 8 }),
    textTile(m, 4, 'Page speed target: LCP under 2.5 seconds on mobile. Anything slower goes on the board.', { x: 0, y: 19, w: 24, h: 2 }),
  ];
  return { dashboards, tiles };
}

// ---------------------------------------------------------------------------
// Dashboard templates
// ---------------------------------------------------------------------------

interface TemplateSeed {
  id: PanelDashboardTemplateId;
  name: Record<PanelTemplateLocale, string>;
  description: Record<PanelTemplateLocale, string>;
  tiles: Array<{ kind: 'report' | 'text'; name?: Record<PanelTemplateLocale, string>; reportKind?: PanelReportSpecKind; text?: Record<PanelTemplateLocale, string>; layout: PanelDashboardTileDto['layout'] }>;
}

const TEMPLATES: TemplateSeed[] = [
  {
    id: 'website-overview',
    name: { en: 'Website overview', nl: 'Website-overzicht' },
    description: { en: 'Traffic, sources, countries and devices for a marketing site.', nl: 'Verkeer, bronnen, landen en apparaten van een website.' },
    tiles: [
      { kind: 'report', name: { en: 'Traffic overview', nl: 'Verkeersoverzicht' }, reportKind: 'web', layout: { x: 0, y: 0, w: 24, h: 11 } },
      { kind: 'report', name: { en: 'Visitors and page views', nl: 'Bezoekers en paginaweergaven' }, reportKind: 'trends', layout: { x: 0, y: 11, w: 16, h: 8 } },
      { kind: 'report', name: { en: 'Where visitors go next', nl: 'Waar bezoekers heen gaan' }, reportKind: 'flows', layout: { x: 16, y: 11, w: 8, h: 8 } },
    ],
  },
  {
    id: 'acquisition',
    name: { en: 'Acquisition', nl: 'Acquisitie' },
    description: { en: 'Which channels bring people who sign up.', nl: 'Welke kanalen bezoekers laten aanmelden.' },
    tiles: [
      { kind: 'text', text: { en: 'Compare channels before moving budget between them.', nl: 'Vergelijk kanalen voordat je budget verschuift.' }, layout: { x: 0, y: 0, w: 24, h: 2 } },
      { kind: 'report', name: { en: 'Sign-ups per day', nl: 'Aanmeldingen per dag' }, reportKind: 'trends', layout: { x: 0, y: 2, w: 12, h: 8 } },
      { kind: 'report', name: { en: 'Visit to sign-up', nl: 'Bezoek tot aanmelding' }, reportKind: 'funnel', layout: { x: 12, y: 2, w: 12, h: 8 } },
    ],
  },
  {
    id: 'product-health',
    name: { en: 'Product health', nl: 'Productgezondheid' },
    description: { en: 'Retention, stickiness and who is new, returning or gone quiet.', nl: 'Retentie, plakkerigheid en wie nieuw, terugkerend of stil is.' },
    tiles: [
      { kind: 'report', name: { en: 'Weekly retention', nl: 'Wekelijkse retentie' }, reportKind: 'retention', layout: { x: 0, y: 0, w: 12, h: 9 } },
      { kind: 'report', name: { en: 'How often people come back', nl: 'Hoe vaak mensen terugkomen' }, reportKind: 'stickiness', layout: { x: 12, y: 0, w: 12, h: 9 } },
      { kind: 'report', name: { en: 'New, returning and dormant', nl: 'Nieuw, terugkerend en slapend' }, reportKind: 'lifecycle', layout: { x: 0, y: 9, w: 24, h: 8 } },
    ],
  },
  {
    id: 'performance',
    name: { en: 'Performance', nl: 'Prestaties' },
    description: { en: 'Core web vitals for your slowest pages.', nl: 'Core web vitals voor je langzaamste pagina’s.' },
    tiles: [
      { kind: 'report', name: { en: 'Largest contentful paint', nl: 'Largest contentful paint' }, reportKind: 'vitals', layout: { x: 0, y: 0, w: 24, h: 9 } },
      { kind: 'text', text: { en: 'Good is under 2.5 seconds at the 75th percentile.', nl: 'Goed is onder 2,5 seconden bij het 75e percentiel.' }, layout: { x: 0, y: 9, w: 24, h: 2 } },
    ],
  },
  {
    id: 'engagement',
    name: { en: 'Engagement', nl: 'Betrokkenheid' },
    description: { en: 'What drives people to a paid plan.', nl: 'Wat mensen naar een betaald abonnement brengt.' },
    tiles: [
      { kind: 'report', name: { en: 'What predicts an upgrade', nl: 'Wat een upgrade voorspelt' }, reportKind: 'signal', layout: { x: 0, y: 0, w: 12, h: 9 } },
      { kind: 'report', name: { en: 'Effect of a launch', nl: 'Effect van een lancering' }, reportKind: 'impact', layout: { x: 12, y: 0, w: 12, h: 9 } },
    ],
  },
];

export function templateDtos(locale: PanelTemplateLocale): PanelDashboardTemplateDto[] {
  return TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name[locale],
    description: t.description[locale],
    tiles: t.tiles.map((x) => ({
      kind: x.kind,
      reportName: x.name ? x.name[locale] : null,
      reportKind: x.reportKind ?? null,
      text: x.text ? x.text[locale] : null,
      layout: x.layout,
    })),
  }));
}

export function templateSeed(id: string): TemplateSeed | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

export function seedCohorts(): PanelCohortDto[] {
  const filters: Record<string, PanelCohortFilter> = {
    coh_sample_power: {
      match: 'all',
      conditions: [
        { type: 'performed', event: 'email_sent', withinDays: 30, minCount: 20, negate: false, filters: [] },
        { type: 'performed', event: 'module_installed', withinDays: 60, minCount: 2, negate: false, filters: [] },
      ],
    },
    coh_sample_trials: {
      match: 'all',
      conditions: [{ type: 'performed', event: 'trial_started', withinDays: 30, minCount: 1, negate: false, filters: [] }],
    },
    coh_sample_at_risk: {
      match: 'all',
      conditions: [
        { type: 'person_property', key: 'plan', operator: 'in', value: ['starter', 'business'] },
        { type: 'performed', event: '$pageview', withinDays: 14, minCount: 1, negate: true, filters: [] },
      ],
    },
    coh_sample_nl_smb: {
      match: 'all',
      conditions: [
        { type: 'person_property', key: 'country', operator: 'eq', value: 'NL' },
        { type: 'person_property', key: 'plan', operator: 'in', value: ['free', 'trial', 'starter'] },
      ],
    },
  };
  const descriptions: Record<string, string> = {
    coh_sample_power: 'Send a lot of email and have installed more than one module.',
    coh_sample_trials: 'Everyone who started a free trial in the last 30 days.',
    coh_sample_at_risk: 'Paying teams that have not opened the app in two weeks.',
    coh_sample_nl_smb: 'Small Dutch companies on a free or entry plan.',
  };
  return COHORT_REFS.map((c, i) => ({
    id: c.id,
    projectId: WEBSITE_PROJECT_ID,
    name: c.name,
    description: descriptions[c.id] ?? null,
    filter: { ...filters[c.id]! },
    ownerUserId: owner(i),
    createdAt: isoDaysAgo(80 - i * 12, 10),
    updatedAt: isoDaysAgo(3 + i * 4, 14),
  }));
}
