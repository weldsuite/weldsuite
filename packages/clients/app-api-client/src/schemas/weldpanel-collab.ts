/**
 * WeldPanel definitions, collaboration and sharing: custom events, computed
 * properties, path rules, annotations, comments, report versions, metric
 * trees, dashboard templates and public share links. Zod v3 inputs, plain
 * interfaces for outputs. Shapes match the tables in
 * `packages/core/db/src/schema/weldpanel.ts` (and the master
 * `panel_share_registry` in weldpanel-registry.ts).
 *
 * Routes (all under `/api/panel` unless noted; Clerk session):
 *
 *   GET|POST /custom-events?projectId · GET|PATCH|DELETE /custom-events/:id
 *   GET|POST /computed-properties?projectId · GET|PATCH|DELETE /computed-properties/:id
 *   GET|PUT  /path-rules?projectId · POST /path-rules/test
 *   GET|POST /annotations?projectId&from&to&reportId · PATCH|DELETE /annotations/:id
 *   GET|POST /comments?targetType&targetId · PATCH|DELETE /comments/:id
 *   GET  /reports/:id/versions · GET /reports/:id/versions/:version · POST /reports/:id/versions/:version/restore
 *   GET  /dashboards/templates?locale · POST /dashboards/from-template
 *   GET|POST /metric-trees?projectId · GET|PATCH|DELETE /metric-trees/:id
 *   GET|POST /share-links?targetType&targetId · DELETE /share-links/:id
 *
 * Public (no session, rate limited per address; 404 for anything wrong):
 *
 *   GET  /public/panel/share/:token          → PanelPublicShareDto
 *   POST /public/panel/share/:token/results  → PanelQueryResponse (weldpanel-query.ts)
 *
 * A custom event is referred to in a query spec as `@<id>` wherever the spec
 * takes an event name, a computed property as `@<id>` wherever it takes an
 * event property key (section "Query spec contracts" of the WeldPanel plan).
 */

import { z } from 'zod';
import {
  PANEL_DATE_PRESETS,
  PANEL_FILTER_COLUMNS,
  panelEventNameSchema,
  panelFilterSchema,
  panelPropertyKeySchema,
  trendsSpecSchema,
  type PanelDatePreset,
  type PanelFilterColumn,
} from './weldpanel-query';
import { PANEL_VISIBILITIES, type PanelVisibility } from './weldpanel-objects';

const projectId = z.string().min(1).max(30);
const objectId = z.string().min(1).max(30);
const name = z.string().trim().min(1).max(255);
const description = z.string().max(2000);
const isoDateTime = z.string().datetime({ offset: true });

const nothingToUpdate = { message: 'Nothing to update' };

// ---------------------------------------------------------------------------
// Custom events
// ---------------------------------------------------------------------------

/** One event (with its own filters) that counts as the custom event. */
export const panelCustomEventMatchSchema = z.object({
  /** A tracked event name; never another custom event (`@pnce_…`). */
  event: panelEventNameSchema.refine((v) => !v.startsWith('@'), { message: 'A custom event cannot include another custom event' }),
  filters: z.array(panelFilterSchema).max(20).default([]),
});

/** `{ match: [{ event, filters }] }`: any of these events (with their filters) counts. */
export const panelCustomEventDefinitionSchema = z.object({
  match: z.array(panelCustomEventMatchSchema).min(1).max(10),
});
export type PanelCustomEventDefinition = z.input<typeof panelCustomEventDefinitionSchema>;
export type ParsedPanelCustomEventDefinition = z.output<typeof panelCustomEventDefinitionSchema>;

export const createPanelCustomEventSchema = z.object({
  projectId,
  name,
  description: description.nullish(),
  definition: panelCustomEventDefinitionSchema,
});
export type CreatePanelCustomEventInput = z.input<typeof createPanelCustomEventSchema>;

export const updatePanelCustomEventSchema = z
  .object({ name, description: description.nullable(), definition: panelCustomEventDefinitionSchema })
  .partial()
  .refine((v) => Object.keys(v).length > 0, nothingToUpdate);
export type UpdatePanelCustomEventInput = z.input<typeof updatePanelCustomEventSchema>;

export interface PanelCustomEventDto {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  definition: ParsedPanelCustomEventDefinition;
  /** What a query spec puts where it takes an event name: `@<id>`. */
  ref: string;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Computed properties
// ---------------------------------------------------------------------------

/** One input of a `coalesce`: an event property, or a standard event column. */
export const panelComputedPropertySourceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('event'), key: panelPropertyKeySchema }),
  z.object({ source: z.literal('column'), field: z.enum(PANEL_FILTER_COLUMNS) }),
]);
export type PanelComputedPropertySource =
  | { source: 'event'; key: string }
  | { source: 'column'; field: PanelFilterColumn };

/**
 * `formula`: arithmetic over numeric event properties (`price * quantity`,
 * `+ - * /` and parentheses; identifiers are event property keys, `$`-keys
 * included). The server checks it with the shared expression parser
 * (`@weldsuite/panel-domain/expression`); division by zero is null.
 * `coalesce`: the first of 2-5 inputs that is set.
 */
export const panelComputedPropertyDefinitionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('formula'), expression: z.string().trim().min(1).max(500) }),
  z.object({ kind: z.literal('coalesce'), keys: z.array(panelComputedPropertySourceSchema).min(2).max(5) }),
]);
export type PanelComputedPropertyDefinition = z.input<typeof panelComputedPropertyDefinitionSchema>;
export type ParsedPanelComputedPropertyDefinition = z.output<typeof panelComputedPropertyDefinitionSchema>;

export const createPanelComputedPropertySchema = z.object({
  projectId,
  name,
  description: description.nullish(),
  definition: panelComputedPropertyDefinitionSchema,
});
export type CreatePanelComputedPropertyInput = z.input<typeof createPanelComputedPropertySchema>;

export const updatePanelComputedPropertySchema = z
  .object({ name, description: description.nullable(), definition: panelComputedPropertyDefinitionSchema })
  .partial()
  .refine((v) => Object.keys(v).length > 0, nothingToUpdate);
export type UpdatePanelComputedPropertyInput = z.input<typeof updatePanelComputedPropertySchema>;

export interface PanelComputedPropertyDto {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  definition: ParsedPanelComputedPropertyDefinition;
  /** What a query spec puts where it takes an event property key: `@<id>`. */
  ref: string;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Path rules
// ---------------------------------------------------------------------------

/** Rules a project may hold; applied in order. */
export const PANEL_MAX_PATH_RULES = 30;
export const PANEL_MAX_PATH_RULE_LENGTH = 500;

/**
 * Lookarounds and backreferences: valid in JavaScript, refused by the query
 * engine's regular expressions (Rust's `regex` crate in Basin SQL), so a rule
 * using them would break every report that cleans paths.
 */
const UNSUPPORTED_REGEX = /\(\?<?[=!]|\\[1-9]|\\k</;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Why `pattern` cannot be a path rule, or null when it can. The query engine
 * (`pathRuleProblem` in `@weldsuite/panel-domain/query`) uses the same checks,
 * so a rule the UI accepts also runs in SQL.
 */
export function panelPathPatternProblem(pattern: string): string | null {
  if (pattern.length === 0) return 'Enter a pattern';
  if (pattern.length > PANEL_MAX_PATH_RULE_LENGTH) return `Use at most ${PANEL_MAX_PATH_RULE_LENGTH} characters`;
  if (CONTROL_CHARACTERS.test(pattern)) return 'Control characters are not allowed';
  if (UNSUPPORTED_REGEX.test(pattern)) return 'Lookarounds and backreferences are not supported';
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return 'Not a valid regular expression';
  }
  if (regex.test('')) return 'The pattern must not match an empty path';
  return null;
}

/** Why `replacement` cannot be a path rule's replacement, or null when it can. */
export function panelPathReplacementProblem(replacement: string): string | null {
  if (replacement.length > PANEL_MAX_PATH_RULE_LENGTH) return `Use at most ${PANEL_MAX_PATH_RULE_LENGTH} characters`;
  if (CONTROL_CHARACTERS.test(replacement)) return 'Control characters are not allowed';
  if (/\$[&`']/.test(replacement)) return 'Use $1 or ${name} in the replacement, not $& or $` or $\'';
  return null;
}

export const panelPathRuleInputSchema = z.object({
  /** A regular expression on the URL path (`^/users/\d+`). */
  pattern: z.string().superRefine((v, ctx) => {
    const problem = panelPathPatternProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  }),
  /** What a match becomes (`/users/:id`); `$1` refers to a group. */
  replacement: z.string().superRefine((v, ctx) => {
    const problem = panelPathReplacementProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  }),
  description: z.string().max(PANEL_MAX_PATH_RULE_LENGTH).nullish(),
});
export type PanelPathRuleInput = z.input<typeof panelPathRuleInputSchema>;

/** `PUT /path-rules?projectId=`: the project's whole ordered list (replaces what is there). */
export const setPanelPathRulesSchema = z.object({
  rules: z.array(panelPathRuleInputSchema).max(PANEL_MAX_PATH_RULES),
});
export type SetPanelPathRulesInput = z.input<typeof setPanelPathRulesSchema>;

/** `POST /path-rules/test`: these rules (or the project's saved ones) applied to sample paths. */
export const testPanelPathRulesSchema = z
  .object({
    projectId: projectId.optional(),
    rules: z.array(panelPathRuleInputSchema).max(PANEL_MAX_PATH_RULES).optional(),
    paths: z.array(z.string().max(2048)).min(1).max(50),
  })
  .refine((v) => v.rules !== undefined || v.projectId !== undefined, { path: ['rules'], message: 'Send rules or a project' });
export type TestPanelPathRulesInput = z.input<typeof testPanelPathRulesSchema>;

export interface PanelPathRuleDto {
  id: string;
  projectId: string;
  /** 0-based place in the list; rules apply in this order. */
  position: number;
  pattern: string;
  replacement: string;
  description: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PanelPathRuleTestResult {
  path: string;
  cleaned: string;
  /** Positions of the rules that changed the path. */
  matched: number[];
}

/**
 * Applies `rules` in order (each replaces every match) to `path`. The same
 * thing the query engine does in SQL, for previews; an invalid pattern is
 * skipped.
 */
export function applyPanelPathRules(path: string, rules: readonly { pattern: string; replacement: string }[]): { cleaned: string; matched: number[] } {
  let cleaned = path;
  const matched: number[] = [];
  rules.forEach((rule, index) => {
    if (panelPathPatternProblem(rule.pattern) || panelPathReplacementProblem(rule.replacement)) return;
    const next = cleaned.replace(new RegExp(rule.pattern, 'g'), rule.replacement);
    if (next !== cleaned) matched.push(index);
    cleaned = next;
  });
  return { cleaned, matched };
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

export const createPanelAnnotationSchema = z.object({
  projectId,
  /** Null or left out: shown on every time chart of the project. */
  reportId: objectId.nullish(),
  occurredAt: isoDateTime,
  label: z.string().trim().min(1).max(200),
  description: description.nullish(),
});
export type CreatePanelAnnotationInput = z.input<typeof createPanelAnnotationSchema>;

export const updatePanelAnnotationSchema = z
  .object({
    reportId: objectId.nullable(),
    occurredAt: isoDateTime,
    label: z.string().trim().min(1).max(200),
    description: description.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, nothingToUpdate);
export type UpdatePanelAnnotationInput = z.input<typeof updatePanelAnnotationSchema>;

const dayOrDateTime = z.union([isoDateTime, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')]);

export const panelAnnotationListQuerySchema = z.object({
  projectId,
  /** From this moment (ISO) or day (`YYYY-MM-DD`, from its start, UTC). */
  from: dayOrDateTime.optional(),
  /** Up to this moment (ISO) or day (to its end, UTC). */
  to: dayOrDateTime.optional(),
  /** Also this report's own annotations (the project-wide ones always come). */
  reportId: objectId.optional(),
});

export interface PanelAnnotationListParams {
  projectId: string;
  from?: string;
  to?: string;
  reportId?: string;
}

export interface PanelAnnotationDto {
  id: string;
  projectId: string;
  reportId: string | null;
  occurredAt: string;
  label: string;
  description: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export const PANEL_TARGET_TYPES = ['report', 'dashboard'] as const;
export type PanelTargetType = (typeof PANEL_TARGET_TYPES)[number];

export const createPanelCommentSchema = z.object({
  targetType: z.enum(PANEL_TARGET_TYPES),
  targetId: objectId,
  body: z.string().trim().min(1).max(5000),
});
export type CreatePanelCommentInput = z.input<typeof createPanelCommentSchema>;

export const updatePanelCommentSchema = z.object({ body: z.string().trim().min(1).max(5000) });
export type UpdatePanelCommentInput = z.input<typeof updatePanelCommentSchema>;

export const panelTargetQuerySchema = z.object({ targetType: z.enum(PANEL_TARGET_TYPES), targetId: objectId });

export interface PanelTargetParams {
  targetType: PanelTargetType;
  targetId: string;
}

export interface PanelCommentDto {
  id: string;
  projectId: string;
  targetType: PanelTargetType;
  targetId: string;
  /** Plain text (Markdown allowed). */
  body: string;
  authorUserId: string;
  /** Changed after it was posted. */
  edited: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Report versions
// ---------------------------------------------------------------------------

/** A report as it was before a change. `version` counts from 1 per report. */
export interface PanelReportVersionDto {
  id: string;
  reportId: string;
  version: number;
  name: string;
  description: string | null;
  /** The report kind of that version's spec. */
  kind: string;
  /** Who made the change that replaced this version. */
  createdByUserId: string;
  createdAt: string;
}

/** `GET /reports/:id/versions/:version`: the version with its spec. */
export interface PanelReportVersionDetailDto extends PanelReportVersionDto {
  spec: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Dashboards: templates
// ---------------------------------------------------------------------------

/** The built-in dashboards `POST /dashboards/from-template` creates (`panel_dashboards.template`). */
export const PANEL_DASHBOARD_TEMPLATES = ['website-overview', 'acquisition', 'product-health', 'performance', 'engagement'] as const;
export type PanelDashboardTemplateId = (typeof PANEL_DASHBOARD_TEMPLATES)[number];

/** Languages template names and texts come in. */
export const PANEL_TEMPLATE_LOCALES = ['en', 'nl'] as const;
export type PanelTemplateLocale = (typeof PANEL_TEMPLATE_LOCALES)[number];

export const createPanelDashboardFromTemplateSchema = z.object({
  projectId,
  template: z.enum(PANEL_DASHBOARD_TEMPLATES),
  /** Defaults to the template's name. */
  name: name.optional(),
  /** Of the dashboard and every report it creates. */
  visibility: z.enum(PANEL_VISIBILITIES).default('private'),
  /** Language of the names and texts; defaults to the request's `Accept-Language`, else English. */
  locale: z.enum(PANEL_TEMPLATE_LOCALES).optional(),
});
export type CreatePanelDashboardFromTemplateInput = z.input<typeof createPanelDashboardFromTemplateSchema>;

export interface PanelDashboardTemplateTileDto {
  kind: 'report' | 'text';
  /** The report the tile gets (report tiles). */
  reportName: string | null;
  reportKind: string | null;
  /** Markdown (text tiles). */
  text: string | null;
  layout: { x: number; y: number; w: number; h: number };
}

export interface PanelDashboardTemplateDto {
  id: PanelDashboardTemplateId;
  name: string;
  description: string;
  tiles: PanelDashboardTemplateTileDto[];
}

// ---------------------------------------------------------------------------
// Metric trees
// ---------------------------------------------------------------------------

/** How a node drives its parent: adds up to it, multiplies into it, or only influences it (correlation). */
export const PANEL_METRIC_TREE_RELATIONS = ['sum', 'product', 'influence'] as const;
export type PanelMetricTreeRelation = (typeof PANEL_METRIC_TREE_RELATIONS)[number];

export const PANEL_MAX_METRIC_TREE_NODES = 25;

/** A trends spec with exactly one series: what a metric tree node measures inline. */
export const panelSingleSeriesTrendsSpecSchema = trendsSpecSchema.refine((s) => s.series.length === 1, {
  path: ['series'],
  message: 'A metric is one series',
});

export const panelMetricTreeMetricSchema = z.union([
  /** A saved trends report (its first series). */
  z.object({ reportId: objectId }),
  z.object({ spec: panelSingleSeriesTrendsSpecSchema }),
]);

export const panelMetricTreeNodeSchema = z.object({
  /** Client-chosen, unique within the tree. */
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Use letters, digits, - and _'),
  label: z.string().trim().min(1).max(100),
  /** Null for the root (exactly one). */
  parentId: z.string().max(40).nullable(),
  /** Null for the root; how a child drives its parent otherwise (null = not said). */
  relation: z.enum(PANEL_METRIC_TREE_RELATIONS).nullable(),
  metric: panelMetricTreeMetricSchema,
});
export type PanelMetricTreeNode = z.input<typeof panelMetricTreeNodeSchema>;
export type ParsedPanelMetricTreeNode = z.output<typeof panelMetricTreeNodeSchema>;

/** Why `nodes` is not a tree (unique ids, one root, parents that exist, no cycles), or null. */
export function panelMetricTreeProblem(nodes: readonly { id: string; parentId: string | null; relation: string | null }[]): string | null {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) return `Two nodes have the id "${node.id}"`;
    ids.add(node.id);
  }
  const roots = nodes.filter((n) => n.parentId === null);
  if (roots.length !== 1) return 'A tree has exactly one root';
  if (roots[0]?.relation !== null) return 'The root has no relation';
  const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]));
  for (const node of nodes) {
    if (node.parentId !== null && !ids.has(node.parentId)) return `Node "${node.id}" has an unknown parent`;
    const seen = new Set<string>();
    let at: string | null = node.id;
    while (at !== null) {
      if (seen.has(at)) return 'The nodes form a cycle';
      seen.add(at);
      at = parentOf.get(at) ?? null;
    }
  }
  return null;
}

export const panelMetricTreeNodesSchema = z
  .array(panelMetricTreeNodeSchema)
  .min(1)
  .max(PANEL_MAX_METRIC_TREE_NODES)
  .superRefine((nodes, ctx) => {
    const problem = panelMetricTreeProblem(nodes);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

export const createPanelMetricTreeSchema = z.object({
  projectId,
  name,
  description: description.nullish(),
  visibility: z.enum(PANEL_VISIBILITIES).default('private'),
  nodes: panelMetricTreeNodesSchema,
});
export type CreatePanelMetricTreeInput = z.input<typeof createPanelMetricTreeSchema>;

export const updatePanelMetricTreeSchema = z
  .object({ name, description: description.nullable(), visibility: z.enum(PANEL_VISIBILITIES), nodes: panelMetricTreeNodesSchema })
  .partial()
  .refine((v) => Object.keys(v).length > 0, nothingToUpdate);
export type UpdatePanelMetricTreeInput = z.input<typeof updatePanelMetricTreeSchema>;

export interface PanelMetricTreeListParams {
  projectId: string;
  scope?: 'all' | 'mine' | 'shared';
}

export interface PanelMetricTreeDto {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  nodes: ParsedPanelMetricTreeNode[];
  ownerUserId: string;
  visibility: PanelVisibility;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

/** `wpsh_` and 32 letters and digits. */
export const PANEL_SHARE_TOKEN = /^wpsh_[A-Za-z0-9]{32}$/;

/**
 * Report kinds a public link may show: aggregates only. People lists,
 * recordings, heatmaps and anything per person never leave through a link.
 */
export const PANEL_SHAREABLE_KINDS = ['web', 'trends', 'funnel', 'retention', 'flows', 'stickiness', 'lifecycle', 'vitals'] as const;

/** Event columns a shared report may not break down by (free text and full URLs can carry personal data). */
export const PANEL_UNSHAREABLE_COLUMNS: readonly string[] = ['el_text', 'url'];

export const createPanelShareLinkSchema = z.object({
  targetType: z.enum(PANEL_TARGET_TYPES),
  targetId: objectId,
  /** The page may be shown in an iframe on other sites. */
  allowEmbed: z.boolean().default(false),
  /** Viewers may pick another date preset. */
  allowDateChange: z.boolean().default(false),
  /** Null or left out: never expires. Must be in the future. */
  expiresAt: isoDateTime.nullish(),
});
export type CreatePanelShareLinkInput = z.input<typeof createPanelShareLinkSchema>;

export interface PanelShareLinkDto {
  id: string;
  projectId: string;
  targetType: PanelTargetType;
  targetId: string;
  /** The token's start, `wpsh_ab12…`, to tell links apart. Never the whole token. */
  prefix: string;
  allowEmbed: boolean;
  allowDateChange: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  createdByUserId: string;
  createdAt: string;
}

/** The only time the token and the link are shown: only a hash is kept. */
export interface PanelCreatedShareLinkDto extends PanelShareLinkDto {
  token: string;
  /** `${PLATFORM_URL}/s/panel/<token>`. */
  url: string;
}

/** Why a report cannot be shared (`422 NOT_SHAREABLE`, `details.reasons`). */
export type PanelShareRefusal = 'kind' | 'person_breakdown' | 'column_breakdown';

export interface PanelNotShareableDetails {
  reasons: { reportId: string; reason: PanelShareRefusal }[];
}

/** The public page of a link: `/s/panel/<token>` on the platform. */
export function panelShareUrl(platformUrl: string, token: string): string {
  return `${withoutTrailingSlash(platformUrl)}/s/panel/${token}`;
}

/** `url` without the slashes it ends with. */
export function withoutTrailingSlash(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end -= 1;
  return url.slice(0, end);
}

/** `POST /public/panel/share/:token/results`. */
export const panelPublicResultsSchema = z.object({
  /** The report tile to run (dashboards); left out for a shared report. */
  tileId: objectId.optional(),
  /** Another preset; used only when the link allows date changes. */
  dateRange: z.object({ preset: z.enum(PANEL_DATE_PRESETS) }).optional(),
});
export type PanelPublicResultsInput = z.input<typeof panelPublicResultsSchema>;

/** A report as a public link shows it: filter values, cohort ids and the project id taken out of the spec. */
export interface PanelPublicReport {
  name: string;
  description: string | null;
  kind: string;
  spec: Record<string, unknown>;
}

export interface PanelPublicTile {
  id: string;
  kind: 'report' | 'text';
  layout: { x: number; y: number; w: number; h: number };
  /** Markdown of a text tile. */
  text: string | null;
  /** The report of a report tile. */
  report: PanelPublicReport | null;
}

/** `GET /public/panel/share/:token`. */
export interface PanelPublicShareDto {
  targetType: PanelTargetType;
  name: string;
  description: string | null;
  projectName: string;
  allowEmbed: boolean;
  allowDateChange: boolean;
  /** The presets a viewer may pick (empty unless `allowDateChange`). */
  datePresets: PanelDatePreset[];
  expiresAt: string | null;
  /** The shared report (`targetType: 'report'`). */
  report: PanelPublicReport | null;
  /** The dashboard's tiles (`targetType: 'dashboard'`); report tiles that cannot be shown are left out. */
  tiles: PanelPublicTile[];
}
