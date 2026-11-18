/**
 * WeldPanel monitoring and data out response schemas: alerts, scheduled
 * reports (subscriptions), raw exports and custom collector domains
 * (panel-api's routes/alerts, subscriptions, exports and domains). Spread into
 * ROUTES by conformance-schemas.ts.
 *
 * The DTOs are TypeScript interfaces in `@weldsuite/app-api-client`
 * (weldpanel-monitor.ts); these are their shapes, strict, so a field either
 * backend adds or leaves out fails. Secrets never appear: a DTO says
 * `slack: true`, and an export's destination has no secret key.
 */
import { z } from 'zod';
import {
  PANEL_ALERT_EVENT_KINDS,
  PANEL_ALERT_STATES,
  PANEL_CHECK_INTERVALS,
  PANEL_DELIVERY_CHANNELS,
  PANEL_DOMAIN_STATUSES,
  PANEL_EXPORT_FREQUENCIES,
  PANEL_EXPORT_PROVIDERS,
  PANEL_EXPORT_RUN_STATUSES,
  PANEL_EXPORT_STATUSES,
  PANEL_EXPORT_TABLES,
  PANEL_SUBSCRIPTION_FREQUENCIES,
  PANEL_SUBSCRIPTION_TARGETS,
} from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import type { RouteSchema } from './conformance-schemas';

const timestamp = z.string().datetime();

/** `PanelAlertCondition` (`panelAlertConditionSchema`'s output). */
const conditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('threshold'), operator: z.enum(['above', 'below']), value: z.number() }).strict(),
  z.object({ type: z.literal('change'), direction: z.enum(['increase', 'decrease', 'any']), percent: z.number() }).strict(),
  z.object({ type: z.literal('anomaly'), sensitivity: z.enum(['low', 'medium', 'high']) }).strict(),
]);

/** `PanelDeliveryChannelsDto`: the Slack URL is never returned. */
const channelsSchema = z
  .object({
    emailUserIds: z.array(z.string()),
    inApp: z.boolean(),
    slack: z.boolean(),
    weldchatChannelId: z.string().nullable(),
  })
  .strict();

/** `PanelDeliveryReportDto`. */
const deliveryReportSchema = z
  .object({
    delivered: z.array(
      z
        .object({
          channel: z.enum(PANEL_DELIVERY_CHANNELS),
          ok: z.boolean(),
          recipients: z.number().int().min(0),
          error: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

/** `PanelAlertDto`. */
const alertSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    reportId: z.string().nullable(),
    spec: z.record(z.string(), z.unknown()).nullable(),
    seriesIndex: z.number().int(),
    condition: conditionSchema,
    checkInterval: z.enum(PANEL_CHECK_INTERVALS),
    channels: channelsSchema,
    enabled: z.boolean(),
    state: z.enum(PANEL_ALERT_STATES),
    lastValue: z.number().nullable(),
    lastCheckedAt: timestamp.nullable(),
    lastFiredAt: timestamp.nullable(),
    lastError: z.string().nullable(),
    snoozedUntil: timestamp.nullable(),
    nextCheckAt: timestamp.nullable(),
    ownerUserId: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

/** `PanelAlertEventDto`. */
const alertEventSchema = z
  .object({
    id: z.string(),
    alertId: z.string(),
    kind: z.enum(PANEL_ALERT_EVENT_KINDS),
    value: z.number().nullable(),
    bound: z.number().nullable(),
    message: z.string().nullable(),
    createdAt: timestamp,
  })
  .strict();

/** `PanelSubscriptionDto`. */
const subscriptionSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    targetType: z.enum(PANEL_SUBSCRIPTION_TARGETS),
    targetId: z.string(),
    schedule: z
      .object({
        frequency: z.enum(PANEL_SUBSCRIPTION_FREQUENCIES),
        hour: z.number().int(),
        weekday: z.number().int().optional(),
        monthDay: z.number().int().optional(),
        timezone: z.string(),
      })
      .strict(),
    channels: channelsSchema,
    enabled: z.boolean(),
    nextRunAt: timestamp.nullable(),
    lastRunAt: timestamp.nullable(),
    lastError: z.string().nullable(),
    ownerUserId: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

/** `PanelExportDto`: the destination without its secret key. */
const exportSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    destination: z
      .object({
        provider: z.enum(PANEL_EXPORT_PROVIDERS),
        endpoint: z.string().nullable(),
        region: z.string(),
        bucket: z.string(),
        prefix: z.string(),
        accessKeyId: z.string(),
        pathStyle: z.boolean(),
      })
      .strict(),
    tables: z.array(z.enum(PANEL_EXPORT_TABLES)),
    frequency: z.enum(PANEL_EXPORT_FREQUENCIES),
    startAt: timestamp,
    exportedUntil: timestamp.nullable(),
    status: z.enum(PANEL_EXPORT_STATUSES),
    lastRunAt: timestamp.nullable(),
    lastError: z.string().nullable(),
    nextRunAt: timestamp.nullable(),
    createdByUserId: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

/** `PanelExportRunDto`. */
const exportRunSchema = z
  .object({
    id: z.string(),
    exportId: z.string(),
    table: z.enum(PANEL_EXPORT_TABLES),
    windowFrom: timestamp,
    windowTo: timestamp,
    status: z.enum(PANEL_EXPORT_RUN_STATUSES),
    rows: z.number().int(),
    bytes: z.number().int(),
    files: z.number().int(),
    error: z.string().nullable(),
    startedAt: timestamp,
    finishedAt: timestamp.nullable(),
  })
  .strict();

/** `PanelExportTestDto`. */
const exportTestSchema = z
  .object({ ok: z.boolean(), wrote: z.boolean(), deleted: z.boolean(), error: z.string().nullable() })
  .strict();

/** `PanelDomainDto`. */
const domainSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    hostname: z.string(),
    status: z.enum(PANEL_DOMAIN_STATUSES),
    sslStatus: z.string().nullable(),
    records: z.array(
      z
        .object({
          type: z.enum(['CNAME', 'TXT']),
          name: z.string(),
          value: z.string(),
          purpose: z.enum(['routing', 'ownership', 'certificate']),
        })
        .strict(),
    ),
    lastError: z.string().nullable(),
    lastCheckedAt: timestamp.nullable(),
    scriptUrl: z.string().nullable(),
    snippet: z.string().nullable(),
    createdAt: timestamp,
  })
  .strict();

const ALERTS = '/api/panel/alerts';
const SUBSCRIPTIONS = '/api/panel/subscriptions';
const EXPORTS = '/api/panel/exports';
const DOMAINS = '/api/panel/projects/:id/domains';

export const PANEL_MONITOR_ROUTES: RouteSchema[] = [
  // alerts
  { method: 'GET', route: ALERTS, envelope: 'list', data: alertSchema },
  { method: 'POST', route: ALERTS, envelope: 'single', data: alertSchema },
  { method: 'GET', route: `${ALERTS}/:id`, envelope: 'single', data: alertSchema },
  { method: 'PATCH', route: `${ALERTS}/:id`, envelope: 'single', data: alertSchema },
  { method: 'GET', route: `${ALERTS}/:id/events`, envelope: 'list', data: alertEventSchema },
  { method: 'POST', route: `${ALERTS}/:id/test`, envelope: 'single', data: deliveryReportSchema },
  { method: 'POST', route: `${ALERTS}/:id/snooze`, envelope: 'single', data: alertSchema },
  // scheduled reports
  { method: 'GET', route: SUBSCRIPTIONS, envelope: 'list', data: subscriptionSchema },
  { method: 'POST', route: SUBSCRIPTIONS, envelope: 'single', data: subscriptionSchema },
  { method: 'GET', route: `${SUBSCRIPTIONS}/:id`, envelope: 'single', data: subscriptionSchema },
  { method: 'PATCH', route: `${SUBSCRIPTIONS}/:id`, envelope: 'single', data: subscriptionSchema },
  { method: 'POST', route: `${SUBSCRIPTIONS}/:id/send-now`, envelope: 'single', data: deliveryReportSchema },
  // raw exports
  { method: 'GET', route: EXPORTS, envelope: 'list', data: exportSchema },
  { method: 'POST', route: EXPORTS, envelope: 'single', data: exportSchema },
  { method: 'POST', route: `${EXPORTS}/test`, envelope: 'single', data: exportTestSchema },
  { method: 'GET', route: `${EXPORTS}/:id`, envelope: 'single', data: exportSchema },
  { method: 'PATCH', route: `${EXPORTS}/:id`, envelope: 'single', data: exportSchema },
  { method: 'GET', route: `${EXPORTS}/:id/runs`, envelope: 'list', data: exportRunSchema },
  { method: 'POST', route: `${EXPORTS}/:id/pause`, envelope: 'single', data: exportSchema },
  { method: 'POST', route: `${EXPORTS}/:id/resume`, envelope: 'single', data: exportSchema },
  // custom collector domains
  { method: 'GET', route: DOMAINS, envelope: 'list', data: domainSchema },
  { method: 'POST', route: DOMAINS, envelope: 'single', data: domainSchema },
  { method: 'POST', route: `${DOMAINS}/:domainId/refresh`, envelope: 'single', data: domainSchema },
];
