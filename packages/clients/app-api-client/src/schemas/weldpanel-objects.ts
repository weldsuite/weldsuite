/**
 * WeldPanel (phases 2-7): saved objects (reports, dashboards, cohorts,
 * lexicon), people, recordings, AI summaries, heatmap pages, live, usage and
 * secret keys. Zod v3 inputs, plain interfaces for outputs.
 *
 * Saved-object shapes match `packages/core/db/src/schema/weldpanel.ts`; the
 * person and live shapes match `@weldsuite/panel-domain/project-object` (a
 * panel-domain test checks they stay assignable, because that package imports
 * this one and cannot be imported back).
 *
 * Routes (all under `/api/panel`, all take the project in the query string or
 * the body unless the id already names one):
 *
 *   POST   /query                                  → PanelQueryResponse (weldpanel-query.ts)
 *   GET|POST /reports · GET|PATCH|DELETE /reports/:id
 *   GET|POST /dashboards · GET|PATCH|DELETE /dashboards/:id
 *   POST   /dashboards/:id/tiles · PATCH|DELETE /dashboards/:id/tiles/:tileId · PUT /dashboards/:id/layout
 *   GET|POST /cohorts · GET|PATCH|DELETE /cohorts/:id
 *   GET    /lexicon?projectId · PATCH /lexicon
 *   GET    /people · GET /people/by-email · GET|DELETE /people/:distinctId
 *   GET    /sessions/:id · GET /sessions/:id/chunks/:seq · PUT|DELETE /sessions/:id/favorite
 *   GET|POST /sessions/:id/summary · POST /insights/summarise
 *   GET|POST /heatmaps/pages · PATCH|DELETE /heatmaps/pages/:id · GET /heatmaps/pages/:id/snapshot
 *   GET    /live · GET /usage
 *   GET|POST /projects/:id/keys · DELETE /projects/:id/keys/:keyId
 */

import { z } from 'zod';
import {
  PANEL_DEVICE_CLASSES,
  panelCohortFilterSchema,
  panelReportSpecSchema,
  sessionsSpecSchema,
  funnelSpecSchema,
  PANEL_REPORT_SPEC_KINDS,
  type PanelSessionRow,
} from './weldpanel-query';

const projectId = z.string().min(1).max(30);

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const PANEL_VISIBILITIES = ['private', 'workspace'] as const;
export type PanelVisibility = (typeof PANEL_VISIBILITIES)[number];

/** `kind` must equal `spec.kind`; checked server-side too. */
export const createPanelReportSchema = z
  .object({
    projectId,
    name: z.string().trim().min(1).max(255),
    description: z.string().max(2000).nullish(),
    visibility: z.enum(PANEL_VISIBILITIES).default('private'),
    spec: panelReportSpecSchema,
  })
  .refine((v) => (PANEL_REPORT_SPEC_KINDS as readonly string[]).includes(v.spec.kind), { path: ['spec'], message: 'Unsupported report kind' });
export type CreatePanelReportInput = z.input<typeof createPanelReportSchema>;

export const updatePanelReportSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().max(2000).nullable(),
    visibility: z.enum(PANEL_VISIBILITIES),
    spec: panelReportSpecSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdatePanelReportInput = z.input<typeof updatePanelReportSchema>;

export interface PanelReportListParams {
  projectId: string;
  kind?: (typeof PANEL_REPORT_SPEC_KINDS)[number];
  /** `all` (default): the caller's own reports and the workspace's shared ones; `mine`: only the caller's own; `shared`: only the shared. */
  scope?: 'all' | 'mine' | 'shared';
}

export interface PanelReportDto {
  id: string;
  projectId: string;
  kind: (typeof PANEL_REPORT_SPEC_KINDS)[number];
  name: string;
  description: string | null;
  /** The stored query spec; send it to `POST /query` to run it. */
  spec: Record<string, unknown>;
  ownerUserId: string;
  visibility: PanelVisibility;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

export const panelTileLayoutSchema = z.object({
  x: z.number().int().min(0).max(23),
  y: z.number().int().min(0).max(1000),
  w: z.number().int().min(1).max(24),
  h: z.number().int().min(1).max(24),
});
export type PanelTileLayoutInput = z.infer<typeof panelTileLayoutSchema>;

export const createPanelDashboardSchema = z.object({
  projectId,
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).nullish(),
  visibility: z.enum(PANEL_VISIBILITIES).default('private'),
});
export type CreatePanelDashboardInput = z.input<typeof createPanelDashboardSchema>;

export const updatePanelDashboardSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().max(2000).nullable(),
    visibility: z.enum(PANEL_VISIBILITIES),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdatePanelDashboardInput = z.input<typeof updatePanelDashboardSchema>;

export const addPanelDashboardTileSchema = z.object({ reportId: z.string().min(1).max(30), layout: panelTileLayoutSchema });
export type AddPanelDashboardTileInput = z.input<typeof addPanelDashboardTileSchema>;

export const updatePanelDashboardTileSchema = z.object({ layout: panelTileLayoutSchema });
export type UpdatePanelDashboardTileInput = z.input<typeof updatePanelDashboardTileSchema>;

/** Replaces every tile's place at once (drag and resize end). */
export const setPanelDashboardLayoutSchema = z.object({
  tiles: z.array(z.object({ id: z.string().min(1).max(30), layout: panelTileLayoutSchema })).max(100),
});
export type SetPanelDashboardLayoutInput = z.input<typeof setPanelDashboardLayoutSchema>;

export interface PanelDashboardListParams {
  projectId: string;
  scope?: 'all' | 'mine' | 'shared';
}

export interface PanelDashboardTileDto {
  id: string;
  dashboardId: string;
  reportId: string;
  layout: { x: number; y: number; w: number; h: number };
  createdAt: string;
}

export interface PanelDashboardDto {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  ownerUserId: string;
  visibility: PanelVisibility;
  createdAt: string;
  updatedAt: string;
}

/** `GET /dashboards/:id`: the dashboard, its tiles and the reports on them (a report the caller may not see is left out with its tile). */
export interface PanelDashboardDetailDto extends PanelDashboardDto {
  tiles: PanelDashboardTileDto[];
  reports: PanelReportDto[];
}

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

export const createPanelCohortSchema = z.object({
  projectId,
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).nullish(),
  filter: panelCohortFilterSchema,
});
export type CreatePanelCohortInput = z.input<typeof createPanelCohortSchema>;

export const updatePanelCohortSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().max(2000).nullable(),
    filter: panelCohortFilterSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdatePanelCohortInput = z.input<typeof updatePanelCohortSchema>;

export interface PanelCohortDto {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  filter: Record<string, unknown>;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Lexicon
// ---------------------------------------------------------------------------

export const PANEL_DEFINITION_KINDS = ['event', 'property'] as const;
export type PanelDefinitionKind = (typeof PANEL_DEFINITION_KINDS)[number];

/** Create or change what the team says about an event or property name (upserts). */
export const updatePanelLexiconSchema = z
  .object({
    projectId,
    kind: z.enum(PANEL_DEFINITION_KINDS),
    name: z.string().min(1).max(255),
    description: z.string().max(2000).nullable().optional(),
    hidden: z.boolean().optional(),
    verified: z.boolean().optional(),
  })
  .refine((v) => v.description !== undefined || v.hidden !== undefined || v.verified !== undefined, {
    message: 'Nothing to update',
  });
export type UpdatePanelLexiconInput = z.input<typeof updatePanelLexiconSchema>;

export interface PanelLexiconEntry {
  name: string;
  /** Seen in the data in the last 30 days (false: only a definition exists). */
  seen: boolean;
  /** Times seen in the last 30 days (events only; null for properties). */
  count30d: number | null;
  description: string | null;
  hidden: boolean;
  verified: boolean;
  /** Id of the stored definition, null when there is none yet. */
  definitionId: string | null;
}

export interface PanelLexiconDto {
  events: PanelLexiconEntry[];
  properties: PanelLexiconEntry[];
  /** When the names-seen scan ran (cached about an hour). */
  scannedAt: string;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export type PanelPropertyScalar = string | number | boolean | null;

/** Shape of `PanelPerson` in `@weldsuite/panel-domain/project-object`. */
export interface PanelPersonDto {
  userId: string;
  email: string | null;
  name: string | null;
  properties: Record<string, PanelPropertyScalar>;
  anonIds: string[];
  firstSeen: string;
  lastSeen: string;
}

export interface PanelPeopleListParams {
  projectId: string;
  search?: string;
  cursor?: string | null;
  limit?: number;
  /** Only members of this cohort (resolved at query time). */
  cohortId?: string;
}

/** An event in a person's activity feed or a recording's timeline. */
export interface PanelActivityEvent {
  eventId: string;
  name: string;
  ts: string;
  path: string | null;
  url: string | null;
  title: string | null;
  sessionId: string | null;
  /** Clicked element text, error message or similar; already masked. */
  detail: string | null;
  properties: Record<string, PanelPropertyScalar>;
}

/** `GET /people/:distinctId`: profile, recent events and recent sessions. */
export interface PanelPersonProfile {
  projectId: string;
  person: PanelPersonDto;
  recentEvents: PanelActivityEvent[];
  sessions: PanelSessionRow[];
  /** Events in the last 90 days. */
  eventCount90d: number;
}

/** A project's profiles that carry an email: `GET /people/by-email?email=` for the WeldCRM person card. */
export interface PanelPersonByEmail {
  projectId: string;
  projectName: string;
  person: PanelPersonDto;
  recentEvents: PanelActivityEvent[];
  sessions: PanelSessionRow[];
}

export interface PanelPeopleByEmailDto {
  people: PanelPersonByEmail[];
}

export interface PanelErasureResult {
  userId: string | null;
  /** Ids now excluded from every query. */
  erasedIdCount: number;
  /** Recording chunks deleted from storage right away. */
  recordingChunksDeleted: number;
}

// ---------------------------------------------------------------------------
// Sessions (recordings)
// ---------------------------------------------------------------------------

/** One recording chunk: fetch its bytes from `/sessions/:id/chunks/:seq` (gzip of rrweb events JSON). */
export interface PanelChunkManifestEntry {
  seq: number;
  tsStart: string;
  tsEnd: string;
  bytes: number;
  hasFullSnapshot: boolean;
}

export interface PanelSessionDetail {
  projectId: string;
  session: PanelSessionRow;
  person: PanelPersonDto | null;
  /** In order: playback starts from the chunk with `hasFullSnapshot`. */
  chunks: PanelChunkManifestEntry[];
  /** Pages, clicks, frustration, errors and custom events: the player's timeline markers. */
  events: PanelActivityEvent[];
  favorite: PanelFavoriteDto | null;
  /** The cached AI summary, if one was generated. */
  summary: PanelSessionSummaryDto | null;
  /** The person's other sessions, newest first (up to 10). */
  otherSessions: PanelSessionRow[];
}

export const favoritePanelSessionSchema = z.object({
  projectId,
  note: z.string().max(2000).nullish(),
});
export type FavoritePanelSessionInput = z.input<typeof favoritePanelSessionSchema>;

export interface PanelFavoriteDto {
  id: string;
  projectId: string;
  sessionId: string;
  note: string | null;
  favoritedByUserId: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// AI summaries
// ---------------------------------------------------------------------------

export interface PanelSessionSummary {
  /** What the visitor tried to do, in a sentence or two. */
  goal: string;
  outcome: 'succeeded' | 'abandoned' | 'unclear';
  /** Where they got stuck (empty when nowhere). */
  frictionPoints: string[];
  /** The whole story, a short paragraph. */
  narrative: string;
}

export interface PanelSessionSummaryDto {
  id: string;
  projectId: string;
  sessionId: string;
  summary: PanelSessionSummary;
  modelId: string;
  creditsCharged: number;
  createdAt: string;
}

export const generatePanelSessionSummarySchema = z.object({
  projectId,
  /** Summarise again even when one is cached (charged again). */
  regenerate: z.boolean().default(false),
});
export type GeneratePanelSessionSummaryInput = z.input<typeof generatePanelSessionSummarySchema>;

/** `POST /sessions/:id/summary`: `cached` is true (and `creditsCharged` 0) when an earlier summary was returned. */
export interface PanelSessionSummaryResponse extends PanelSessionSummaryDto {
  cached: boolean;
}

/** The sessions to summarise: a recordings filter, or the people who dropped at a funnel step. */
export const panelSetSummarySourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sessions'), spec: sessionsSpecSchema }),
  z.object({
    type: z.literal('funnel_drop_off'),
    spec: funnelSpecSchema,
    /** The step people dropped before (1 to steps - 1). */
    stepIndex: z.number().int().min(1).max(9),
  }),
]);

export const summarisePanelSetSchema = z.object({
  projectId,
  source: panelSetSummarySourceSchema,
  /** Sessions to read, newest first (at most 20). */
  limit: z.number().int().min(1).max(20).default(20),
  regenerate: z.boolean().default(false),
});
export type SummarisePanelSetInput = z.input<typeof summarisePanelSetSchema>;

export interface PanelSetSummaryTheme {
  title: string;
  description: string;
  /** Example sessions to open. */
  sessionIds: string[];
  sessionCount: number;
}

export interface PanelSetSummary {
  overview: string;
  themes: PanelSetSummaryTheme[];
  sessionsRead: number;
}

export interface PanelSetSummaryResponse {
  id: string;
  projectId: string;
  summary: PanelSetSummary;
  modelId: string;
  /** Credits charged for this call, summaries of single sessions included. 0 when everything was cached. */
  creditsCharged: number;
  cached: boolean;
  createdAt: string;
}

/**
 * `402 insufficient_credits`: the wallet could not cover the AI call. The
 * response is the standard error envelope; `details` is this shape.
 */
export interface PanelInsufficientCreditsDetails {
  requiredCredits: number | null;
  availableCredits: number | null;
}

// ---------------------------------------------------------------------------
// Heatmap pages
// ---------------------------------------------------------------------------

export const createPanelHeatmapPageSchema = z.object({
  projectId,
  name: z.string().trim().min(1).max(255),
  /** A path pattern: `/products/*`; `*` matches any characters. */
  urlPattern: z.string().trim().min(1).max(1000).regex(/^\//, 'Start with /'),
});
export type CreatePanelHeatmapPageInput = z.input<typeof createPanelHeatmapPageSchema>;

export const updatePanelHeatmapPageSchema = createPanelHeatmapPageSchema
  .omit({ projectId: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdatePanelHeatmapPageInput = z.input<typeof updatePanelHeatmapPageSchema>;

export interface PanelHeatmapPageDto {
  id: string;
  projectId: string;
  name: string;
  urlPattern: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export const panelSnapshotQuerySchema = z.object({ deviceClass: z.enum(PANEL_DEVICE_CLASSES) });

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

/** Shape of `PanelLiveSession` in `@weldsuite/panel-domain/project-object`. */
export interface PanelLiveSessionDto {
  sessionId: string;
  distinctId: string;
  path: string;
  title: string | null;
  country: string | null;
  deviceType: 'desktop' | 'mobile' | 'tablet' | null;
  ts: string;
  startedAt: string;
  pageviews: number;
}

export interface PanelLiveDto {
  projectId: string;
  /** Visitors with activity in the last five minutes. */
  visitors: number;
  sessions: PanelLiveSessionDto[];
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export type PanelQuotaState = 'ok' | 'replay_blocked' | 'events_blocked';

export interface PanelUsageMeter {
  used: number;
  /** The plan's monthly allowance. */
  allowance: number;
  /** Charged from the wallet beyond the allowance, in blocks (10,000 events, 100 recordings). */
  blocksCharged: number;
  creditsCharged: number;
}

export interface PanelUsageDto {
  /** `YYYY-MM`, UTC. */
  month: string;
  planSlug: string;
  events: PanelUsageMeter;
  recordings: PanelUsageMeter;
  quota: PanelQuotaState;
  retention: {
    eventsMonths: number;
    recordingsDays: number;
    favoritesMonths: number;
  };
  /** Per project this month, biggest first. */
  projects: { projectId: string; name: string; events: number; recordings: number }[];
}

// ---------------------------------------------------------------------------
// Secret keys
// ---------------------------------------------------------------------------

export const createPanelKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
});
export type CreatePanelKeyInput = z.input<typeof createPanelKeySchema>;

export interface PanelKeyDto {
  id: string;
  projectId: string;
  name: string;
  /** The key's start, `wps_ab12…`, to tell keys apart. Never the whole key. */
  prefix: string;
  createdByUserId: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** The only time the full key (`wps_…`) is shown. Store it now: only a hash is kept. */
export interface PanelCreatedKeyDto extends PanelKeyDto {
  key: string;
}
