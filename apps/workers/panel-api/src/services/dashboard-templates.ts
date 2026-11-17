/**
 * Built-in dashboards: `GET /dashboards/templates` lists them and
 * `POST /dashboards/from-template` creates the dashboard with a new report per
 * report tile. Names and texts come in English and Dutch, picked by the
 * request's locale.
 *
 * A template report may list more than one spec: the first that the current
 * query schema accepts is used, so a template can prefer a richer report kind
 * and still work where the schema does not have it. A test checks every
 * template yields specs that parse.
 */

import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { PanelDashboard, PanelDashboardTile, PanelReport, PanelTileLayout, PanelVisibility } from '@weldsuite/db/schema';
import { panelReportSpecSchema, type PanelReportSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import {
  PANEL_TEMPLATE_LOCALES,
  type PanelDashboardTemplateDto,
  type PanelDashboardTemplateId,
  type PanelTemplateLocale,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';

const { panelDashboards, panelDashboardTiles, panelReports } = schema;

type Localized = Record<PanelTemplateLocale, string>;

interface TemplateReport {
  name: Localized;
  /** In order of preference; the first the query schema accepts is used. */
  specs: ((projectId: string) => Record<string, unknown>)[];
}

type TemplateTile =
  | { kind: 'report'; report: TemplateReport; layout: PanelTileLayout }
  | { kind: 'text'; text: Localized; layout: PanelTileLayout };

export interface DashboardTemplate {
  id: PanelDashboardTemplateId;
  name: Localized;
  description: Localized;
  tiles: TemplateTile[];
}

// ---------------------------------------------------------------------------
// Spec builders
// ---------------------------------------------------------------------------

const PAGEVIEW = '$pageview';
const range30 = { preset: '30d' } as const;
const range90 = { preset: '90d' } as const;

function trends(series: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return (projectId: string) => ({ kind: 'trends', projectId, dateRange: range30, interval: 'day', series, ...extra });
}

function byColumn(field: string, display: 'bar' | 'table' = 'bar', limit = 10) {
  return trends([{ event: PAGEVIEW, math: 'unique_users', label: 'Visitors' }], { breakdown: { source: 'column', field, limit }, display });
}

/** The p75 of a web vital from the `vitals` kind, else its average from the `$webvitals` events. */
function vital(metric: 'lcp' | 'inp' | 'cls' | 'fcp' | 'ttfb', label: string) {
  return [
    (projectId: string) => ({ kind: 'vitals', projectId, dateRange: range30, metric, percentile: 'p75', interval: 'day' }),
    trends([{ event: '$webvitals', math: 'avg', property: `$${metric}`, label }], { display: 'line' }),
  ];
}

const layout = (x: number, y: number, w: number, h: number): PanelTileLayout => ({ x, y, w, h });

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const DASHBOARD_TEMPLATES: readonly DashboardTemplate[] = [
  {
    id: 'website-overview',
    name: { en: 'Website overview', nl: 'Website-overzicht' },
    description: {
      en: 'Visitors, pageviews, top pages, sources and the paths people take through the site.',
      nl: 'Bezoekers, paginaweergaven, toppagina’s, bronnen en de routes die mensen over de site nemen.',
    },
    tiles: [
      {
        kind: 'text',
        text: {
          en: '## Website overview\nThe last 30 days compared with the 30 before. Change the period with the dashboard filters.',
          nl: '## Website-overzicht\nDe afgelopen 30 dagen vergeleken met de 30 daarvoor. Kies een andere periode met de dashboardfilters.',
        },
        layout: layout(0, 0, 24, 2),
      },
      {
        kind: 'report',
        report: {
          name: { en: 'Web analytics', nl: 'Webanalyse' },
          specs: [(projectId) => ({ kind: 'web', projectId, dateRange: range30, compare: true, limit: 10 })],
        },
        layout: layout(0, 2, 24, 10),
      },
      {
        kind: 'report',
        report: {
          name: { en: 'Visitors and pageviews', nl: 'Bezoekers en paginaweergaven' },
          specs: [
            trends(
              [
                { event: PAGEVIEW, math: 'unique_users', label: 'Visitors' },
                { event: PAGEVIEW, math: 'total', label: 'Pageviews' },
              ],
              { display: 'line', compare: true },
            ),
          ],
        },
        layout: layout(0, 12, 12, 6),
      },
      {
        kind: 'report',
        report: {
          name: { en: 'Visits', nl: 'Bezoeken' },
          specs: [trends([{ event: PAGEVIEW, math: 'sessions', label: 'Visits' }], { display: 'line', compare: true })],
        },
        layout: layout(12, 12, 12, 6),
      },
      {
        kind: 'report',
        report: {
          name: { en: 'Paths from the first page', nl: 'Routes vanaf de eerste pagina' },
          specs: [(projectId) => ({ kind: 'flows', projectId, dateRange: range30, anchor: { event: PAGEVIEW }, direction: 'after', depth: 3, scope: 'pageviews', limit: 20 })],
        },
        layout: layout(0, 18, 24, 8),
      },
    ],
  },
  {
    id: 'acquisition',
    name: { en: 'Acquisition', nl: 'Acquisitie' },
    description: {
      en: 'Where visitors come from: referrers, campaigns and countries.',
      nl: 'Waar bezoekers vandaan komen: verwijzers, campagnes en landen.',
    },
    tiles: [
      {
        kind: 'text',
        text: {
          en: '## Acquisition\nUnique visitors per source over the last 30 days. Tag links with `utm_source`, `utm_medium` and `utm_campaign` to see campaigns here.',
          nl: '## Acquisitie\nUnieke bezoekers per bron over de afgelopen 30 dagen. Voorzie links van `utm_source`, `utm_medium` en `utm_campaign` om campagnes hier te zien.',
        },
        layout: layout(0, 0, 24, 2),
      },
      {
        kind: 'report',
        report: { name: { en: 'Visitors by referrer', nl: 'Bezoekers per verwijzer' }, specs: [byColumn('referrer_host')] },
        layout: layout(0, 2, 12, 7),
      },
      {
        kind: 'report',
        report: { name: { en: 'Visitors by UTM source', nl: 'Bezoekers per UTM-bron' }, specs: [byColumn('utm_source')] },
        layout: layout(12, 2, 12, 7),
      },
      {
        kind: 'report',
        report: { name: { en: 'Visitors by campaign', nl: 'Bezoekers per campagne' }, specs: [byColumn('utm_campaign', 'table')] },
        layout: layout(0, 9, 12, 7),
      },
      {
        kind: 'report',
        report: { name: { en: 'Visitors by country', nl: 'Bezoekers per land' }, specs: [byColumn('country', 'table')] },
        layout: layout(12, 9, 12, 7),
      },
    ],
  },
  {
    id: 'product-health',
    name: { en: 'Product health', nl: 'Productgezondheid' },
    description: {
      en: 'Daily and weekly active users, retention, errors and frustration.',
      nl: 'Dagelijks en wekelijks actieve gebruikers, retentie, fouten en frustratie.',
    },
    tiles: [
      {
        kind: 'report',
        report: {
          name: { en: 'Daily active users', nl: 'Dagelijks actieve gebruikers' },
          specs: [trends([{ event: PAGEVIEW, math: 'unique_users', label: 'DAU' }], { display: 'line' })],
        },
        layout: layout(0, 0, 12, 6),
      },
      {
        kind: 'report',
        report: {
          name: { en: 'Weekly active users', nl: 'Wekelijks actieve gebruikers' },
          specs: [
            (projectId) => ({
              kind: 'trends',
              projectId,
              dateRange: range90,
              interval: 'week',
              series: [{ event: PAGEVIEW, math: 'unique_users', label: 'WAU' }],
              display: 'line',
            }),
          ],
        },
        layout: layout(12, 0, 12, 6),
      },
      {
        kind: 'report',
        report: {
          name: { en: 'Weekly retention', nl: 'Wekelijkse retentie' },
          specs: [(projectId) => ({ kind: 'retention', projectId, dateRange: range90, firstEvent: PAGEVIEW, interval: 'week', periods: 8 })],
        },
        layout: layout(0, 6, 24, 8),
      },
      {
        kind: 'report',
        report: {
          name: { en: 'Errors', nl: 'Fouten' },
          specs: [trends([{ event: '$exception', math: 'total', label: 'Errors' }], { display: 'bar' })],
        },
        layout: layout(0, 14, 12, 6),
      },
      {
        kind: 'report',
        report: {
          name: { en: 'Rage and dead clicks', nl: 'Woedende en dode klikken' },
          specs: [
            trends(
              [
                { event: '$rageclick', math: 'total', label: 'Rage clicks' },
                { event: '$deadclick', math: 'total', label: 'Dead clicks' },
              ],
              { display: 'line' },
            ),
          ],
        },
        layout: layout(12, 14, 12, 6),
      },
    ],
  },
  {
    id: 'performance',
    name: { en: 'Performance', nl: 'Prestaties' },
    description: {
      en: 'Core Web Vitals from real visits: loading (LCP), responsiveness (INP) and visual stability (CLS).',
      nl: 'Core Web Vitals van echte bezoeken: laden (LCP), reactiesnelheid (INP) en visuele stabiliteit (CLS).',
    },
    tiles: [
      {
        kind: 'text',
        text: {
          en: '## Performance\nGood is LCP under 2.5 s, INP under 200 ms and CLS under 0.1. Measured on real visits by the WeldPanel script.',
          nl: '## Prestaties\nGoed is een LCP onder 2,5 s, een INP onder 200 ms en een CLS onder 0,1. Gemeten bij echte bezoeken door het WeldPanel-script.',
        },
        layout: layout(0, 0, 24, 2),
      },
      {
        kind: 'report',
        report: { name: { en: 'Largest Contentful Paint', nl: 'Largest Contentful Paint' }, specs: vital('lcp', 'LCP (ms)') },
        layout: layout(0, 2, 12, 6),
      },
      {
        kind: 'report',
        report: { name: { en: 'Interaction to Next Paint', nl: 'Interaction to Next Paint' }, specs: vital('inp', 'INP (ms)') },
        layout: layout(12, 2, 12, 6),
      },
      {
        kind: 'report',
        report: { name: { en: 'Cumulative Layout Shift', nl: 'Cumulative Layout Shift' }, specs: vital('cls', 'CLS') },
        layout: layout(0, 8, 12, 6),
      },
      {
        kind: 'report',
        report: { name: { en: 'Time to First Byte', nl: 'Time to First Byte' }, specs: vital('ttfb', 'TTFB (ms)') },
        layout: layout(12, 8, 12, 6),
      },
    ],
  },
  {
    id: 'engagement',
    name: { en: 'Engagement', nl: 'Betrokkenheid' },
    description: {
      en: 'How often people come back: stickiness, the lifecycle of users and retention.',
      nl: 'Hoe vaak mensen terugkomen: terugkeerfrequentie, de levenscyclus van gebruikers en retentie.',
    },
    tiles: [
      {
        kind: 'report',
        report: {
          name: { en: 'Stickiness', nl: 'Terugkeerfrequentie' },
          specs: [
            (projectId) => ({ kind: 'stickiness', projectId, dateRange: range30, event: PAGEVIEW, interval: 'day', measure: 'intervals' }),
            trends([{ event: PAGEVIEW, math: 'avg_per_user', label: 'Pageviews per user' }], { display: 'line' }),
          ],
        },
        layout: layout(0, 0, 12, 7),
      },
      {
        kind: 'report',
        report: {
          name: { en: 'User lifecycle', nl: 'Levenscyclus van gebruikers' },
          specs: [
            (projectId) => ({ kind: 'lifecycle', projectId, dateRange: range90, event: PAGEVIEW, interval: 'week' }),
            (projectId) => ({
              kind: 'trends',
              projectId,
              dateRange: range90,
              interval: 'week',
              series: [{ event: PAGEVIEW, math: 'unique_users', label: 'Weekly users' }],
              display: 'bar',
            }),
          ],
        },
        layout: layout(12, 0, 12, 7),
      },
      {
        kind: 'report',
        report: {
          name: { en: 'Retention', nl: 'Retentie' },
          specs: [(projectId) => ({ kind: 'retention', projectId, dateRange: range90, firstEvent: PAGEVIEW, interval: 'week', periods: 8 })],
        },
        layout: layout(0, 7, 24, 8),
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Use
// ---------------------------------------------------------------------------

/** The locale asked for, else the first of `Accept-Language` there is a text for, else English. */
export function templateLocale(explicit: PanelTemplateLocale | undefined, acceptLanguage: string | undefined): PanelTemplateLocale {
  if (explicit) return explicit;
  for (const part of (acceptLanguage ?? '').split(',')) {
    const base = part.split(';')[0]?.trim().toLowerCase().split('-')[0];
    const match = PANEL_TEMPLATE_LOCALES.find((l) => l === base);
    if (match) return match;
  }
  return 'en';
}

export function findTemplate(id: string): DashboardTemplate | null {
  return DASHBOARD_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** The first of the report's specs the query schema accepts, parsed; null when none does. */
export function templateReportSpec(report: TemplateReport, projectId: string): PanelReportSpec | null {
  for (const build of report.specs) {
    const parsed = panelReportSpecSchema.safeParse(build(projectId));
    if (parsed.success) return parsed.data;
  }
  return null;
}

export function toTemplateDto(template: DashboardTemplate, locale: PanelTemplateLocale): PanelDashboardTemplateDto {
  return {
    id: template.id,
    name: template.name[locale],
    description: template.description[locale],
    tiles: template.tiles.map((tile) => {
      if (tile.kind === 'text') return { kind: 'text', reportName: null, reportKind: null, text: tile.text[locale], layout: tile.layout };
      const spec = templateReportSpec(tile.report, 'pnp_template');
      return { kind: 'report', reportName: tile.report.name[locale], reportKind: spec?.kind ?? null, text: null, layout: tile.layout };
    }),
  };
}

export interface CreatedFromTemplate {
  dashboard: PanelDashboard;
  reports: PanelReport[];
  tiles: PanelDashboardTile[];
}

/**
 * Creates the template's reports, the dashboard and its tiles in one
 * transaction. Every report and the dashboard get `visibility`.
 */
export async function createFromTemplate(
  db: Database,
  template: DashboardTemplate,
  input: { projectId: string; name?: string; visibility: PanelVisibility },
  userId: string,
  locale: PanelTemplateLocale,
): Promise<CreatedFromTemplate> {
  const dashboardId = generateId('pnd');
  const reportRows: (typeof panelReports.$inferInsert)[] = [];
  const tileRows: (typeof panelDashboardTiles.$inferInsert)[] = [];
  // Tiles are listed by creation time: a millisecond apart keeps the template's order.
  const start = Date.now();
  const createdAt = () => new Date(start + tileRows.length);
  for (const tile of template.tiles) {
    if (tile.kind === 'text') {
      tileRows.push({ id: generateId('pnt'), dashboardId, kind: 'text', text: tile.text[locale], layout: tile.layout, createdAt: createdAt() });
      continue;
    }
    const spec = templateReportSpec(tile.report, input.projectId);
    if (!spec) continue;
    const reportId = generateId('pnr');
    reportRows.push({
      id: reportId,
      projectId: input.projectId,
      kind: spec.kind as PanelReport['kind'],
      name: tile.report.name[locale],
      description: null,
      spec: spec as unknown as Record<string, unknown>,
      ownerUserId: userId,
      visibility: input.visibility,
    });
    tileRows.push({ id: generateId('pnt'), dashboardId, kind: 'report', reportId, layout: tile.layout, createdAt: createdAt() });
  }
  const dashboardRow: typeof panelDashboards.$inferInsert = {
    id: dashboardId,
    projectId: input.projectId,
    name: input.name ?? template.name[locale],
    description: template.description[locale],
    ownerUserId: userId,
    visibility: input.visibility,
    template: template.id,
  };

  const results = await atomically(db, (handle) => [
    ...(reportRows.length > 0 ? [handle.insert(panelReports).values(reportRows).returning()] : []),
    handle.insert(panelDashboards).values(dashboardRow).returning(),
    ...(tileRows.length > 0 ? [handle.insert(panelDashboardTiles).values(tileRows).returning()] : []),
  ]);
  const reports = reportRows.length > 0 ? (results[0] as PanelReport[]) : [];
  const dashboard = (results[reportRows.length > 0 ? 1 : 0] as PanelDashboard[])[0] as PanelDashboard;
  const tiles = tileRows.length > 0 ? (results[results.length - 1] as PanelDashboardTile[]) : [];
  return { dashboard, reports, tiles };
}
