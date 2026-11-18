/**
 * WeldPanel (panel-api) response schemas: projects and their secret keys, the
 * install check, queries and the lexicon, saved objects (reports and their
 * versions, dashboards and templates, cohorts), definitions (custom events,
 * computed properties, path rules, group types), annotations, comments,
 * metric trees, share links and the public share routes. Spread into ROUTES
 * by conformance-schemas.ts.
 *
 * The DTOs are TypeScript interfaces in `@weldsuite/app-api-client`
 * (weldpanel-objects.ts, weldpanel-collab.ts, weldpanel-groups.ts); these are
 * their shapes, strict, so a field either backend adds or leaves out fails.
 */
import { z } from 'zod';
import { panelInstallInfoSchema, panelProjectDtoSchema } from '@weldsuite/app-api-client/schemas/weldpanel';
import {
  PANEL_DATE_PRESETS,
  PANEL_QUERY_KINDS,
  PANEL_REPORT_SPEC_KINDS,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { PANEL_TILE_KINDS, PANEL_VISIBILITIES } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import {
  PANEL_DASHBOARD_TEMPLATES,
  PANEL_METRIC_TREE_RELATIONS,
  PANEL_TARGET_TYPES,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { RouteSchema } from './conformance-schemas';

const timestamp = z.string().datetime();
const spec = z.record(z.string(), z.unknown());
const layout = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() }).strict();

/** `PanelQueryResponse`: the kind's result, when the data was read and whether it came from the cache. */
const panelQueryResponseSchema = z
  .object({
    kind: z.enum(PANEL_QUERY_KINDS),
    result: z.record(z.string(), z.unknown()),
    dataAsOf: z.string().datetime(),
    cached: z.boolean(),
  })
  .strict();

/** `PanelLexiconEntry`. */
const panelLexiconEntrySchema = z
  .object({
    name: z.string(),
    seen: z.boolean(),
    count30d: z.number().nullable(),
    description: z.string().nullable(),
    hidden: z.boolean(),
    verified: z.boolean(),
    definitionId: z.string().nullable(),
  })
  .strict();

/** `PanelLexiconDto`. */
const panelLexiconSchema = z
  .object({
    events: z.array(panelLexiconEntrySchema),
    properties: z.array(panelLexiconEntrySchema),
    scannedAt: z.string().datetime(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Saved objects
// ---------------------------------------------------------------------------

/** `PanelReportDto`. */
const panelReportSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    kind: z.enum(PANEL_REPORT_SPEC_KINDS),
    name: z.string(),
    description: z.string().nullable(),
    spec,
    ownerUserId: z.string(),
    visibility: z.enum(PANEL_VISIBILITIES),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

/** `PanelReportVersionDto`: without the spec. */
const panelReportVersionSchema = z
  .object({
    id: z.string(),
    reportId: z.string(),
    version: z.number().int().min(1),
    name: z.string(),
    description: z.string().nullable(),
    kind: z.string(),
    createdByUserId: z.string(),
    createdAt: timestamp,
  })
  .strict();

/** `PanelReportVersionDetailDto`. */
const panelReportVersionDetailSchema = panelReportVersionSchema.extend({ spec }).strict();

/** `PanelDashboardDto`. */
const panelDashboardSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    ownerUserId: z.string(),
    visibility: z.enum(PANEL_VISIBILITIES),
    filters: z.record(z.string(), z.unknown()).nullable(),
    template: z.string().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

/** `PanelDashboardTileDto`. */
const panelDashboardTileSchema = z
  .object({
    id: z.string(),
    dashboardId: z.string(),
    kind: z.enum(PANEL_TILE_KINDS),
    reportId: z.string().nullable(),
    text: z.string().nullable(),
    layout,
    createdAt: timestamp,
  })
  .strict();

/** `PanelDashboardDetailDto`: the tiles with the spec each report tile runs, and the visible reports. */
const panelDashboardDetailSchema = panelDashboardSchema
  .extend({
    tiles: z.array(panelDashboardTileSchema.extend({ spec: spec.nullable() }).strict()),
    reports: z.array(panelReportSchema),
  })
  .strict();

/** `PanelDashboardTemplateDto`. */
const panelDashboardTemplateSchema = z
  .object({
    id: z.enum(PANEL_DASHBOARD_TEMPLATES),
    name: z.string(),
    description: z.string(),
    tiles: z.array(
      z
        .object({
          kind: z.enum(PANEL_TILE_KINDS),
          reportName: z.string().nullable(),
          reportKind: z.string().nullable(),
          text: z.string().nullable(),
          layout,
        })
        .strict(),
    ),
  })
  .strict();

/** `PanelCohortDto`. */
const panelCohortSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    filter: z.record(z.string(), z.unknown()),
    ownerUserId: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/** `PanelCustomEventDto` and `PanelComputedPropertyDto`. */
const panelDefinitionSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    definition: z.record(z.string(), z.unknown()),
    ref: z.string().regex(/^@/),
    ownerUserId: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

/** `PanelPathRuleDto`. */
const panelPathRuleSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    position: z.number().int().min(0),
    pattern: z.string(),
    replacement: z.string(),
    description: z.string().nullable(),
    createdByUserId: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

/** `{ results: PanelPathRuleTestResult[] }`. */
const panelPathRuleTestSchema = z
  .object({
    results: z.array(z.object({ path: z.string(), cleaned: z.string(), matched: z.array(z.number().int()) }).strict()),
  })
  .strict();

/** `PanelGroupTypeDto`: a configured row, or a collected type without one. */
const panelGroupTypeSchema = z
  .object({
    id: z.string().nullable(),
    projectId: z.string(),
    groupType: z.string(),
    nameSingular: z.string(),
    namePlural: z.string(),
    crmMatchProperty: z.string().nullable(),
    configured: z.boolean(),
    collecting: z.boolean(),
    createdAt: timestamp.nullable(),
    updatedAt: timestamp.nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Collaboration
// ---------------------------------------------------------------------------

/** `PanelAnnotationDto`. */
const panelAnnotationSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    reportId: z.string().nullable(),
    occurredAt: timestamp,
    label: z.string(),
    description: z.string().nullable(),
    createdByUserId: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

/** `PanelCommentDto`. */
const panelCommentSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    targetType: z.enum(PANEL_TARGET_TYPES),
    targetId: z.string(),
    body: z.string(),
    authorUserId: z.string(),
    edited: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

/** `PanelMetricTreeDto`. */
const panelMetricTreeSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    nodes: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          parentId: z.string().nullable(),
          relation: z.enum(PANEL_METRIC_TREE_RELATIONS).nullable(),
          metric: z.union([z.object({ reportId: z.string() }).strict(), z.object({ spec }).strict()]),
        })
        .strict(),
    ),
    ownerUserId: z.string(),
    visibility: z.enum(PANEL_VISIBILITIES),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

// ---------------------------------------------------------------------------
// Secret keys and share links
// ---------------------------------------------------------------------------

/** `PanelKeyDto`: never the key itself. */
const panelKeySchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    prefix: z.string().regex(/^wps_[0-9a-f]{4}…$/),
    createdByUserId: z.string(),
    createdAt: timestamp,
    lastUsedAt: timestamp.nullable(),
    revokedAt: timestamp.nullable(),
  })
  .strict();

/** `PanelCreatedKeyDto`: the whole key, once. */
const panelCreatedKeySchema = panelKeySchema.extend({ key: z.string().regex(/^wps_[0-9a-f]{32}$/) }).strict();

/** `PanelShareLinkDto`: never the token. */
const panelShareLinkSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    targetType: z.enum(PANEL_TARGET_TYPES),
    targetId: z.string(),
    prefix: z.string().regex(/^wpsh_[A-Za-z0-9]{4}…$/),
    allowEmbed: z.boolean(),
    allowDateChange: z.boolean(),
    expiresAt: timestamp.nullable(),
    revokedAt: timestamp.nullable(),
    lastViewedAt: timestamp.nullable(),
    viewCount: z.number().int().min(0),
    createdByUserId: z.string(),
    createdAt: timestamp,
  })
  .strict();

/** `PanelCreatedShareLinkDto`: the token and the link, once. */
const panelCreatedShareLinkSchema = panelShareLinkSchema
  .extend({ token: z.string().regex(/^wpsh_[A-Za-z0-9]{32}$/), url: z.string().url() })
  .strict();

/** `PanelPublicReport`: no filter values, cohort ids or project id. */
const panelPublicReportSchema = z
  .object({ name: z.string(), description: z.string().nullable(), kind: z.string(), spec })
  .strict()
  .refine((report) => !('projectId' in report.spec), { message: 'A public spec carries no project id' });

/** `PanelPublicShareDto`. */
const panelPublicShareSchema = z
  .object({
    targetType: z.enum(PANEL_TARGET_TYPES),
    name: z.string(),
    description: z.string().nullable(),
    projectName: z.string(),
    allowEmbed: z.boolean(),
    allowDateChange: z.boolean(),
    datePresets: z.array(z.enum(PANEL_DATE_PRESETS)),
    expiresAt: timestamp.nullable(),
    report: panelPublicReportSchema.nullable(),
    tiles: z.array(
      z
        .object({
          id: z.string(),
          kind: z.enum(PANEL_TILE_KINDS),
          layout,
          text: z.string().nullable(),
          report: panelPublicReportSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const KEYS = '/api/panel/projects/:id/keys';

export const PANEL_ROUTES: RouteSchema[] = [
  { method: 'GET', route: '/api/panel/projects', envelope: 'list', data: panelProjectDtoSchema },
  { method: 'POST', route: '/api/panel/projects', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'GET', route: '/api/panel/projects/:id', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'PATCH', route: '/api/panel/projects/:id', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'PATCH', route: '/api/panel/projects/:id/settings', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'POST', route: '/api/panel/projects/:id/rotate-token', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'GET', route: '/api/panel/projects/:id/install', envelope: 'single', data: panelInstallInfoSchema },
  { method: 'POST', route: '/api/panel/query', envelope: 'single', data: panelQueryResponseSchema },
  { method: 'GET', route: '/api/panel/lexicon', envelope: 'single', data: panelLexiconSchema },
  { method: 'PATCH', route: '/api/panel/lexicon', envelope: 'single', data: panelLexiconEntrySchema },
  // secret keys
  { method: 'GET', route: KEYS, envelope: 'list', data: panelKeySchema },
  { method: 'POST', route: KEYS, envelope: 'single', data: panelCreatedKeySchema },
  // reports and their versions
  { method: 'GET', route: '/api/panel/reports', envelope: 'list', data: panelReportSchema },
  { method: 'POST', route: '/api/panel/reports', envelope: 'single', data: panelReportSchema },
  { method: 'GET', route: '/api/panel/reports/:id', envelope: 'single', data: panelReportSchema },
  { method: 'PATCH', route: '/api/panel/reports/:id', envelope: 'single', data: panelReportSchema },
  { method: 'GET', route: '/api/panel/reports/:id/versions', envelope: 'list', data: panelReportVersionSchema },
  { method: 'GET', route: '/api/panel/reports/:id/versions/:version', envelope: 'single', data: panelReportVersionDetailSchema },
  { method: 'POST', route: '/api/panel/reports/:id/versions/:version/restore', envelope: 'single', data: panelReportSchema },
  // dashboards, tiles and templates
  { method: 'GET', route: '/api/panel/dashboards', envelope: 'list', data: panelDashboardSchema },
  { method: 'POST', route: '/api/panel/dashboards', envelope: 'single', data: panelDashboardSchema },
  { method: 'GET', route: '/api/panel/dashboards/templates', envelope: 'list', data: panelDashboardTemplateSchema },
  { method: 'POST', route: '/api/panel/dashboards/from-template', envelope: 'single', data: panelDashboardDetailSchema },
  { method: 'GET', route: '/api/panel/dashboards/:id', envelope: 'single', data: panelDashboardDetailSchema },
  { method: 'PATCH', route: '/api/panel/dashboards/:id', envelope: 'single', data: panelDashboardSchema },
  { method: 'POST', route: '/api/panel/dashboards/:id/tiles', envelope: 'single', data: panelDashboardTileSchema },
  { method: 'PATCH', route: '/api/panel/dashboards/:id/tiles/:tileId', envelope: 'single', data: panelDashboardTileSchema },
  { method: 'PUT', route: '/api/panel/dashboards/:id/layout', envelope: 'single', data: panelDashboardDetailSchema },
  // cohorts
  { method: 'GET', route: '/api/panel/cohorts', envelope: 'list', data: panelCohortSchema },
  { method: 'POST', route: '/api/panel/cohorts', envelope: 'single', data: panelCohortSchema },
  { method: 'GET', route: '/api/panel/cohorts/:id', envelope: 'single', data: panelCohortSchema },
  { method: 'PATCH', route: '/api/panel/cohorts/:id', envelope: 'single', data: panelCohortSchema },
  // custom events and computed properties
  ...['/api/panel/custom-events', '/api/panel/computed-properties'].flatMap((base): RouteSchema[] => [
    { method: 'GET', route: base, envelope: 'list', data: panelDefinitionSchema },
    { method: 'POST', route: base, envelope: 'single', data: panelDefinitionSchema },
    { method: 'GET', route: `${base}/:id`, envelope: 'single', data: panelDefinitionSchema },
    { method: 'PATCH', route: `${base}/:id`, envelope: 'single', data: panelDefinitionSchema },
  ]),
  // path rules
  { method: 'GET', route: '/api/panel/path-rules', envelope: 'list', data: panelPathRuleSchema },
  { method: 'PUT', route: '/api/panel/path-rules', envelope: 'list', data: panelPathRuleSchema },
  { method: 'POST', route: '/api/panel/path-rules/test', envelope: 'single', data: panelPathRuleTestSchema },
  // group types
  { method: 'GET', route: '/api/panel/group-types', envelope: 'list', data: panelGroupTypeSchema },
  { method: 'POST', route: '/api/panel/group-types', envelope: 'single', data: panelGroupTypeSchema },
  { method: 'PATCH', route: '/api/panel/group-types/:id', envelope: 'single', data: panelGroupTypeSchema },
  // annotations and comments
  { method: 'GET', route: '/api/panel/annotations', envelope: 'list', data: panelAnnotationSchema },
  { method: 'POST', route: '/api/panel/annotations', envelope: 'single', data: panelAnnotationSchema },
  { method: 'GET', route: '/api/panel/annotations/:id', envelope: 'single', data: panelAnnotationSchema },
  { method: 'PATCH', route: '/api/panel/annotations/:id', envelope: 'single', data: panelAnnotationSchema },
  { method: 'GET', route: '/api/panel/comments', envelope: 'list', data: panelCommentSchema },
  { method: 'POST', route: '/api/panel/comments', envelope: 'single', data: panelCommentSchema },
  { method: 'PATCH', route: '/api/panel/comments/:id', envelope: 'single', data: panelCommentSchema },
  // metric trees
  { method: 'GET', route: '/api/panel/metric-trees', envelope: 'list', data: panelMetricTreeSchema },
  { method: 'POST', route: '/api/panel/metric-trees', envelope: 'single', data: panelMetricTreeSchema },
  { method: 'GET', route: '/api/panel/metric-trees/:id', envelope: 'single', data: panelMetricTreeSchema },
  { method: 'PATCH', route: '/api/panel/metric-trees/:id', envelope: 'single', data: panelMetricTreeSchema },
  // share links and the public routes
  { method: 'GET', route: '/api/panel/share-links', envelope: 'list', data: panelShareLinkSchema },
  { method: 'POST', route: '/api/panel/share-links', envelope: 'single', data: panelCreatedShareLinkSchema },
  { method: 'GET', route: '/public/panel/share/:token', envelope: 'single', data: panelPublicShareSchema },
  { method: 'POST', route: '/public/panel/share/:token/results', envelope: 'single', data: panelQueryResponseSchema },
];
