/**
 * WeldPanel response schemas of panel-api's analysis routes: root cause
 * (`/api/panel/insights/explain`), AI summaries of one recording and of a set,
 * metric tree values, usage, and the internal read API
 * (`/internal/panel/v1/:workspaceId/*`), which answers with the platform's
 * own DTOs. The DTOs are interfaces in `@weldsuite/app-api-client`
 * (`weldpanel-analysis.ts`, `weldpanel-objects.ts`); these are their strict
 * Zod twins. Spread into ROUTES by conformance-schemas.ts.
 */
import { z } from 'zod';
import type { RouteSchema } from './conformance-schemas';
import { PANEL_ROUTES } from './conformance-schemas-panel';
import { PANEL_VISITOR_ROUTES } from './conformance-schemas-panel-visitors';

const instant = z.string().datetime();
const window = z.object({ from: instant, to: instant }).strict();

/** `PanelExplainResult`. */
const explainResultSchema = z
  .object({
    current: window,
    baseline: window,
    metric: z
      .object({
        label: z.string(),
        current: z.number(),
        baseline: z.number(),
        change: z.number(),
        changePercent: z.number().nullable(),
      })
      .strict(),
    dimensions: z.array(
      z
        .object({
          dimension: z.string(),
          values: z.array(
            z
              .object({
                value: z.string(),
                current: z.number(),
                baseline: z.number(),
                change: z.number(),
                changePercent: z.number().nullable(),
                contributionShare: z.number(),
              })
              .strict(),
          ),
          explained: z.number(),
        })
        .strict(),
    ),
    narrative: z
      .object({ text: z.string(), modelId: z.string(), creditsCharged: z.number(), cached: z.boolean() })
      .strict()
      .nullable(),
    narrativeUnavailable: z.enum(['ai_disabled', 'insufficient_credits', 'ai_unavailable']).optional(),
    dataAsOf: instant,
  })
  .strict();

/** `PanelResolvedRange`. */
const resolvedRangeSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    timezone: z.string(),
    clampedToRetention: z.boolean(),
    previousFrom: z.string().nullable(),
    previousTo: z.string().nullable(),
  })
  .strict();

/** `PanelMetricTreeValues`. */
const metricTreeValuesSchema = z
  .object({
    range: resolvedRangeSchema.nullable(),
    nodes: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          parentId: z.string().nullable(),
          relation: z.string().nullable(),
          value: z.number().nullable(),
          previous: z.number().nullable(),
          changePercent: z.number().nullable(),
          correlationWithParent: z.number().nullable(),
          points: z.array(z.object({ bucket: z.string(), value: z.number() }).strict()),
          error: z.string().nullable(),
        })
        .strict(),
    ),
    dataAsOf: instant,
  })
  .strict();

/** `PanelSessionSummary`. */
const sessionSummarySchema = z
  .object({
    goal: z.string(),
    outcome: z.enum(['succeeded', 'abandoned', 'unclear']),
    frictionPoints: z.array(z.string()),
    narrative: z.string(),
  })
  .strict();

/** `PanelSessionSummaryResponse`. */
const sessionSummaryResponseSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    sessionId: z.string(),
    summary: sessionSummarySchema,
    modelId: z.string(),
    creditsCharged: z.number(),
    createdAt: instant,
    cached: z.boolean(),
  })
  .strict();

/** `PanelSetSummaryResponse`. */
const setSummaryResponseSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    summary: z
      .object({
        overview: z.string(),
        themes: z.array(
          z
            .object({
              title: z.string(),
              description: z.string(),
              sessionIds: z.array(z.string()),
              sessionCount: z.number().int(),
            })
            .strict(),
        ),
        sessionsRead: z.number().int(),
      })
      .strict(),
    modelId: z.string(),
    creditsCharged: z.number(),
    cached: z.boolean(),
    createdAt: instant,
  })
  .strict();

const meter = z
  .object({ used: z.number(), allowance: z.number(), blocksCharged: z.number(), creditsCharged: z.number() })
  .strict();

/** `PanelUsageDto`. */
const usageSchema = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    planSlug: z.string(),
    events: meter,
    recordings: meter,
    quota: z.enum(['ok', 'replay_blocked', 'events_blocked']),
    retention: z.object({ eventsMonths: z.number(), recordingsDays: z.number(), favoritesMonths: z.number() }).strict(),
    projects: z.array(
      z.object({ projectId: z.string(), name: z.string(), events: z.number(), recordings: z.number() }).strict(),
    ),
  })
  .strict();

/** The platform route behind each internal one (`routes/internal-v1`'s allow-list). */
const INTERNAL = '/internal/panel/v1/:workspaceId';
const INTERNAL_READS: Array<[method: string, path: string]> = [
  ['GET', '/projects'],
  ['POST', '/query'],
  ['GET', '/reports'],
  ['GET', '/reports/:id'],
  ['GET', '/dashboards'],
  ['GET', '/dashboards/:id'],
  ['GET', '/cohorts'],
  ['GET', '/lexicon'],
  ['GET', '/people'],
  ['GET', '/people/:distinctId'],
  ['GET', '/groups'],
  ['GET', '/groups/:type/:key'],
];

function platformRoute(method: string, route: string): RouteSchema | undefined {
  return [...PANEL_ROUTES, ...PANEL_VISITOR_ROUTES].find((r) => r.method === method && r.route === route);
}

const INTERNAL_ROUTES: RouteSchema[] = [
  ...INTERNAL_READS.flatMap(([method, path]) => {
    const platform = platformRoute(method, `/api/panel${path}`);
    return platform ? [{ ...platform, route: `${INTERNAL}${path}` }] : [];
  }),
  // A saved report run: the query route's answer.
  ...(() => {
    const query = platformRoute('POST', '/api/panel/query');
    return query ? [{ ...query, method: 'GET', route: `${INTERNAL}/reports/:id/results` }] : [];
  })(),
];

export const PANEL_ANALYSIS_ROUTES: RouteSchema[] = [
  { method: 'POST', route: '/api/panel/insights/explain', envelope: 'single', data: explainResultSchema },
  { method: 'POST', route: '/api/panel/insights/summarise', envelope: 'single', data: setSummaryResponseSchema },
  { method: 'POST', route: '/api/panel/metric-tree-values', envelope: 'single', data: metricTreeValuesSchema },
  { method: 'POST', route: '/api/panel/metric-tree-values/:id', envelope: 'single', data: metricTreeValuesSchema },
  { method: 'POST', route: '/api/panel/sessions/:id/summary', envelope: 'single', data: sessionSummaryResponseSchema },
  { method: 'GET', route: '/api/panel/usage', envelope: 'single', data: usageSchema },
  ...INTERNAL_ROUTES,
];
