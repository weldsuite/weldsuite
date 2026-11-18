/**
 * WeldPanel response schemas of panel-api's visitor routes: people (and
 * erasure), groups, sessions and recordings, heatmap page groups and the live
 * view. The DTOs are interfaces in `@weldsuite/app-api-client`
 * (`weldpanel-objects.ts`, `weldpanel-groups.ts`, `weldpanel-query.ts`);
 * these are their strict Zod twins. Spread into ROUTES by
 * conformance-schemas.ts.
 */
import { z } from 'zod';
import type { RouteSchema } from './conformance-schemas';

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const properties = z.record(z.string(), scalar);
const instant = z.string().datetime();
const deviceType = z.enum(['desktop', 'tablet', 'mobile']);

/** `PanelPersonDto`. */
const personSchema = z
  .object({
    userId: z.string(),
    email: z.string().nullable(),
    name: z.string().nullable(),
    properties,
    anonIds: z.array(z.string()),
    firstSeen: z.string(),
    lastSeen: z.string(),
  })
  .strict();

/** `PanelActivityEvent`. */
const activityEventSchema = z
  .object({
    eventId: z.string(),
    name: z.string(),
    ts: instant,
    path: z.string().nullable(),
    url: z.string().nullable(),
    title: z.string().nullable(),
    sessionId: z.string().nullable(),
    detail: z.string().nullable(),
    properties,
  })
  .strict();

/** `PanelSessionRow`. */
const sessionRowSchema = z
  .object({
    sessionId: z.string(),
    startedAt: z.string(),
    endedAt: z.string(),
    durationSeconds: z.number(),
    pageviews: z.number(),
    clicks: z.number(),
    events: z.number(),
    rageClicks: z.number(),
    deadClicks: z.number(),
    quickBacks: z.number(),
    excessiveScrolls: z.number(),
    errors: z.number(),
    entryPage: z.string().nullable(),
    exitPage: z.string().nullable(),
    deviceType: deviceType.nullable(),
    browser: z.string().nullable(),
    os: z.string().nullable(),
    country: z.string().nullable(),
    distinctId: z.string(),
    userId: z.string().nullable(),
    hasRecording: z.boolean(),
    chunkCount: z.number(),
    favorite: z.boolean(),
  })
  .strict();

/** `PanelPersonProfile`. */
const personProfileSchema = z
  .object({
    projectId: z.string(),
    person: personSchema,
    recentEvents: z.array(activityEventSchema),
    sessions: z.array(sessionRowSchema),
    eventCount90d: z.number().int().min(0),
  })
  .strict();

/** `PanelPeopleByEmailDto`. */
const peopleByEmailSchema = z
  .object({
    people: z.array(
      z
        .object({
          projectId: z.string(),
          projectName: z.string(),
          person: personSchema,
          recentEvents: z.array(activityEventSchema),
          sessions: z.array(sessionRowSchema),
        })
        .strict(),
    ),
  })
  .strict();

/** `PanelErasureResult`. */
const erasureResultSchema = z
  .object({
    userId: z.string().nullable(),
    erasedIdCount: z.number().int().min(0),
    recordingChunksDeleted: z.number().int().min(0),
  })
  .strict();

/** `PanelFavoriteDto`. */
const favoriteSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    sessionId: z.string(),
    note: z.string().nullable(),
    favoritedByUserId: z.string(),
    createdAt: instant,
  })
  .strict();

/** `PanelSessionSummaryDto`. */
const sessionSummarySchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    sessionId: z.string(),
    summary: z.record(z.string(), z.unknown()),
    modelId: z.string(),
    creditsCharged: z.number(),
    createdAt: instant,
  })
  .strict();

/** `PanelSessionDetail`. */
const sessionDetailSchema = z
  .object({
    projectId: z.string(),
    session: sessionRowSchema,
    person: personSchema.nullable(),
    chunks: z.array(
      z
        .object({ seq: z.number(), tsStart: z.string(), tsEnd: z.string(), bytes: z.number(), hasFullSnapshot: z.boolean() })
        .strict(),
    ),
    events: z.array(activityEventSchema),
    favorite: favoriteSchema.nullable(),
    summary: sessionSummarySchema.nullable(),
    otherSessions: z.array(sessionRowSchema),
  })
  .strict();

/** `PanelGroupDto`. */
const groupSchema = z
  .object({
    groupType: z.string(),
    groupKey: z.string(),
    name: z.string().nullable(),
    properties,
    firstSeen: z.string(),
    lastSeen: z.string(),
  })
  .strict();

/** `PanelGroupProfileDto`. */
const groupProfileSchema = z
  .object({
    projectId: z.string(),
    group: groupSchema,
    hasProfile: z.boolean(),
    days: z.number().int().min(7).max(365),
    recentEvents: z.array(activityEventSchema),
    eventCount: z.number().int().min(0),
    members: z.array(z.object({ distinctId: z.string(), lastSeen: z.string(), eventCount: z.number() }).strict()),
    memberCount: z.number().int().min(0),
    crmCompany: z.object({ id: z.string(), name: z.string(), domain: z.string().nullable() }).strict().nullable(),
  })
  .strict();

/** `PanelHeatmapPageDto`. */
const heatmapPageSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    urlPattern: z.string(),
    createdByUserId: z.string(),
    createdAt: instant,
    updatedAt: instant,
  })
  .strict();

/** `PanelLiveDto`. */
const liveSchema = z
  .object({
    projectId: z.string(),
    visitors: z.number().int().min(0),
    sessions: z.array(
      z
        .object({
          sessionId: z.string(),
          distinctId: z.string(),
          path: z.string(),
          title: z.string().nullable(),
          country: z.string().nullable(),
          deviceType: deviceType.nullable(),
          ts: z.string(),
          startedAt: z.string(),
          pageviews: z.number().int().min(0),
        })
        .strict(),
    ),
  })
  .strict();

export const PANEL_VISITOR_ROUTES: RouteSchema[] = [
  { method: 'GET', route: '/api/panel/people', envelope: 'list', data: personSchema },
  { method: 'GET', route: '/api/panel/people/by-email', envelope: 'single', data: peopleByEmailSchema },
  { method: 'GET', route: '/api/panel/people/:distinctId', envelope: 'single', data: personProfileSchema },
  { method: 'DELETE', route: '/api/panel/people/:distinctId', envelope: 'single', data: erasureResultSchema },
  { method: 'GET', route: '/api/panel/groups', envelope: 'list', data: groupSchema },
  { method: 'GET', route: '/api/panel/groups/:type/:key', envelope: 'single', data: groupProfileSchema },
  { method: 'GET', route: '/api/panel/sessions/:id', envelope: 'single', data: sessionDetailSchema },
  { method: 'PUT', route: '/api/panel/sessions/:id/favorite', envelope: 'single', data: favoriteSchema },
  { method: 'GET', route: '/api/panel/sessions/:id/summary', envelope: 'single', data: sessionSummarySchema.nullable() },
  { method: 'GET', route: '/api/panel/heatmaps/pages', envelope: 'list', data: heatmapPageSchema },
  { method: 'POST', route: '/api/panel/heatmaps/pages', envelope: 'single', data: heatmapPageSchema },
  { method: 'PATCH', route: '/api/panel/heatmaps/pages/:id', envelope: 'single', data: heatmapPageSchema },
  { method: 'GET', route: '/api/panel/live', envelope: 'single', data: liveSchema },
];
