/**
 * WeldPanel monitoring and data out: alerts, scheduled reports
 * (subscriptions), raw exports to S3-compatible storage and custom collector
 * domains. Zod v3 inputs, plain interfaces for outputs.
 *
 * Secrets go in and never come out: a Slack webhook URL is stored encrypted
 * and a DTO only says `slack: true`; an export's secret access key is
 * write-only.
 *
 * Routes (panel-api, all under `/api/panel`):
 *
 *   GET|POST /alerts · GET|PATCH|DELETE /alerts/:id
 *   GET  /alerts/:id/events · POST /alerts/:id/test · POST /alerts/:id/snooze
 *   GET|POST /subscriptions · GET|PATCH|DELETE /subscriptions/:id · POST /subscriptions/:id/send-now
 *   GET|POST /exports · GET|PATCH|DELETE /exports/:id · GET /exports/:id/runs
 *   POST /exports/:id/pause · POST /exports/:id/resume · POST /exports/test
 *   GET|POST /projects/:id/domains · POST /projects/:id/domains/:domainId/refresh · DELETE /projects/:id/domains/:domainId
 */

import { z } from 'zod';
import { trendsSpecSchema } from './weldpanel-query';

const projectId = z.string().min(1).max(30);
const objectId = z.string().min(1).max(30);
const name = z.string().trim().min(1).max(255);
const isoDateTime = z.string().datetime({ offset: true });

// ---------------------------------------------------------------------------
// Delivery channels (alerts and subscriptions)
// ---------------------------------------------------------------------------

/** Where a Slack incoming webhook must point. */
export const SLACK_WEBHOOK_PREFIX = 'https://hooks.slack.com/';

export function isSlackWebhookUrl(value: string): boolean {
  if (!value.startsWith(SLACK_WEBHOOK_PREFIX)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'hooks.slack.com' && url.username === '' && url.password === '' && url.pathname.length > 1;
  } catch {
    return false;
  }
}

/** Most members one alert or subscription emails. */
export const PANEL_MAX_EMAIL_RECIPIENTS = 20;

/**
 * Channels as a client sends them. `slackWebhookUrl`: a string sets it, `null`
 * removes it, absent keeps what is stored (on update).
 */
export const panelDeliveryChannelsInputSchema = z.object({
  /** Workspace members (user ids) who get an email. */
  emailUserIds: z
    .array(z.string().min(1).max(255))
    .max(PANEL_MAX_EMAIL_RECIPIENTS)
    .default([])
    .transform((ids) => [...new Set(ids)]),
  /** In-app notification to the email recipients and the owner. */
  inApp: z.boolean().default(false),
  slackWebhookUrl: z
    .string()
    .max(500)
    .refine(isSlackWebhookUrl, { message: 'Use a Slack incoming webhook URL (https://hooks.slack.com/…)' })
    .nullable()
    .optional(),
  /** A WeldChat channel to post into. */
  weldchatChannelId: z.string().min(1).max(30).nullable().optional(),
});
export type PanelDeliveryChannelsInput = z.input<typeof panelDeliveryChannelsInputSchema>;
export type ParsedPanelDeliveryChannels = z.output<typeof panelDeliveryChannelsInputSchema>;

/** Channels as the API shows them: the Slack URL is never returned. */
export interface PanelDeliveryChannelsDto {
  emailUserIds: string[];
  inApp: boolean;
  /** A Slack webhook is set. */
  slack: boolean;
  weldchatChannelId: string | null;
}

export const PANEL_DELIVERY_CHANNELS = ['email', 'in_app', 'slack', 'weldchat'] as const;
export type PanelDeliveryChannel = (typeof PANEL_DELIVERY_CHANNELS)[number];

/** What one channel did with one message. A failing channel never stops the others. */
export interface PanelDeliveryResult {
  channel: PanelDeliveryChannel;
  ok: boolean;
  /** People (email, in-app) or posts (Slack, WeldChat) reached. */
  recipients: number;
  error: string | null;
}

/** `POST /alerts/:id/test` and `POST /subscriptions/:id/send-now`. */
export interface PanelDeliveryReportDto {
  delivered: PanelDeliveryResult[];
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export const PANEL_CHECK_INTERVALS = ['hourly', 'daily', 'weekly'] as const;
export type PanelCheckInterval = (typeof PANEL_CHECK_INTERVALS)[number];

export const PANEL_ALERT_STATES = ['pending', 'ok', 'firing', 'error'] as const;
export type PanelAlertState = (typeof PANEL_ALERT_STATES)[number];

export const PANEL_ALERT_EVENT_KINDS = ['fired', 'resolved', 'error'] as const;
export type PanelAlertEventKind = (typeof PANEL_ALERT_EVENT_KINDS)[number];

export const PANEL_ANOMALY_SENSITIVITIES = ['low', 'medium', 'high'] as const;
export type PanelAnomalySensitivity = (typeof PANEL_ANOMALY_SENSITIVITIES)[number];

/**
 * When an alert fires, judged on the last complete interval (the last full
 * hour, yesterday, or the last full week, in the spec's timezone):
 *
 * - `threshold`: the value is above or below a number;
 * - `change`: the value moved by at least `percent` against the interval before;
 * - `anomaly`: the value left the band median ± k·1.4826·MAD of the previous 28
 *   intervals (hourly: the same hour on the previous 14 days); k is 4, 3 or 2
 *   for low, medium and high sensitivity. Fewer than 7 baseline points: skipped.
 */
export const panelAlertConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('threshold'), operator: z.enum(['above', 'below']), value: z.number().finite() }),
  z.object({ type: z.literal('change'), direction: z.enum(['increase', 'decrease', 'any']), percent: z.number().positive().max(100_000) }),
  z.object({ type: z.literal('anomaly'), sensitivity: z.enum(PANEL_ANOMALY_SENSITIVITIES) }),
]);
export type PanelAlertCondition = z.infer<typeof panelAlertConditionSchema>;

const alertTarget = {
  /** A saved trends report to watch… */
  reportId: objectId.nullable().optional(),
  /** …or a trends spec of the alert's own. */
  spec: trendsSpecSchema.nullable().optional(),
  /** Which series of the trends query (0-based). */
  seriesIndex: z.number().int().min(0).max(4),
};

export const createPanelAlertSchema = z
  .object({
    projectId,
    name,
    ...alertTarget,
    seriesIndex: alertTarget.seriesIndex.default(0),
    condition: panelAlertConditionSchema,
    checkInterval: z.enum(PANEL_CHECK_INTERVALS).default('daily'),
    channels: panelDeliveryChannelsInputSchema,
    enabled: z.boolean().default(true),
  })
  .refine((v) => Boolean(v.reportId) !== Boolean(v.spec), { message: 'Give either a report or a spec', path: ['reportId'] });
export type CreatePanelAlertInput = z.input<typeof createPanelAlertSchema>;
export type ParsedCreatePanelAlert = z.output<typeof createPanelAlertSchema>;

/** Every field optional; sending `reportId` or `spec` switches what the alert watches (the other is cleared). */
export const updatePanelAlertSchema = z
  .object({
    name: name.optional(),
    ...alertTarget,
    seriesIndex: alertTarget.seriesIndex.optional(),
    condition: panelAlertConditionSchema.optional(),
    checkInterval: z.enum(PANEL_CHECK_INTERVALS).optional(),
    channels: panelDeliveryChannelsInputSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => !(v.reportId && v.spec), { message: 'Give either a report or a spec', path: ['reportId'] });
export type UpdatePanelAlertInput = z.input<typeof updatePanelAlertSchema>;
export type ParsedUpdatePanelAlert = z.output<typeof updatePanelAlertSchema>;

/** Longest snooze: 90 days. */
export const PANEL_MAX_SNOOZE_DAYS = 90;

/** `until: null` ends a snooze. A snoozed alert is still checked; it just sends nothing. */
export const snoozePanelAlertSchema = z.object({ until: isoDateTime.nullable() });
export type SnoozePanelAlertInput = z.input<typeof snoozePanelAlertSchema>;

export interface PanelAlertListParams {
  projectId?: string;
  /** `mine`: alerts the caller owns; `all` (default): every alert of the project. */
  scope?: 'all' | 'mine';
}

export interface PanelAlertDto {
  id: string;
  projectId: string;
  name: string;
  reportId: string | null;
  spec: Record<string, unknown> | null;
  seriesIndex: number;
  condition: PanelAlertCondition;
  checkInterval: PanelCheckInterval;
  channels: PanelDeliveryChannelsDto;
  enabled: boolean;
  state: PanelAlertState;
  lastValue: number | null;
  lastCheckedAt: string | null;
  lastFiredAt: string | null;
  lastError: string | null;
  snoozedUntil: string | null;
  /** When the cron checks it next (null when disabled). */
  nextCheckAt: string | null;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PanelAlertEventDto {
  id: string;
  alertId: string;
  kind: PanelAlertEventKind;
  value: number | null;
  /** The bound the value crossed (threshold, the previous value's limit, or the anomaly band edge). */
  bound: number | null;
  message: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Subscriptions (scheduled reports)
// ---------------------------------------------------------------------------

export const PANEL_SUBSCRIPTION_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type PanelSubscriptionFrequency = (typeof PANEL_SUBSCRIPTION_FREQUENCIES)[number];

export const PANEL_SUBSCRIPTION_TARGETS = ['report', 'dashboard'] as const;
export type PanelSubscriptionTarget = (typeof PANEL_SUBSCRIPTION_TARGETS)[number];

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * When a scheduled report goes out, in `timezone`: every day, one weekday
 * (0 = Sunday … 6 = Saturday) or one day of the month (1–28), at `hour`:00.
 */
export const panelSubscriptionScheduleSchema = z
  .object({
    frequency: z.enum(PANEL_SUBSCRIPTION_FREQUENCIES),
    hour: z.number().int().min(0).max(23),
    weekday: z.number().int().min(0).max(6).optional(),
    monthDay: z.number().int().min(1).max(28).optional(),
    timezone: z.string().min(1).max(64).refine(isTimeZone, { message: 'Unknown timezone' }).default('UTC'),
  })
  .superRefine((s, ctx) => {
    if (s.frequency === 'weekly' && s.weekday === undefined) ctx.addIssue({ code: 'custom', path: ['weekday'], message: 'Choose a weekday' });
    if (s.frequency === 'monthly' && s.monthDay === undefined) ctx.addIssue({ code: 'custom', path: ['monthDay'], message: 'Choose a day of the month' });
  });
export type PanelSubscriptionSchedule = z.output<typeof panelSubscriptionScheduleSchema>;
export type PanelSubscriptionScheduleInput = z.input<typeof panelSubscriptionScheduleSchema>;

export const createPanelSubscriptionSchema = z.object({
  projectId,
  name,
  targetType: z.enum(PANEL_SUBSCRIPTION_TARGETS),
  targetId: objectId,
  schedule: panelSubscriptionScheduleSchema,
  channels: panelDeliveryChannelsInputSchema,
  enabled: z.boolean().default(true),
});
export type CreatePanelSubscriptionInput = z.input<typeof createPanelSubscriptionSchema>;
export type ParsedCreatePanelSubscription = z.output<typeof createPanelSubscriptionSchema>;

export const updatePanelSubscriptionSchema = z.object({
  name: name.optional(),
  schedule: panelSubscriptionScheduleSchema.optional(),
  channels: panelDeliveryChannelsInputSchema.optional(),
  enabled: z.boolean().optional(),
});
export type UpdatePanelSubscriptionInput = z.input<typeof updatePanelSubscriptionSchema>;
export type ParsedUpdatePanelSubscription = z.output<typeof updatePanelSubscriptionSchema>;

export interface PanelSubscriptionListParams {
  projectId?: string;
  targetType?: PanelSubscriptionTarget;
  targetId?: string;
  scope?: 'all' | 'mine';
}

export interface PanelSubscriptionDto {
  id: string;
  projectId: string;
  name: string;
  targetType: PanelSubscriptionTarget;
  targetId: string;
  schedule: PanelSubscriptionSchedule;
  channels: PanelDeliveryChannelsDto;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Raw exports
// ---------------------------------------------------------------------------

export const PANEL_EXPORT_PROVIDERS = ['s3', 'r2', 'gcs', 'minio', 'other'] as const;
export type PanelExportProvider = (typeof PANEL_EXPORT_PROVIDERS)[number];

export const PANEL_EXPORT_TABLES = ['events', 'people', 'groups', 'identities'] as const;
export type PanelExportTable = (typeof PANEL_EXPORT_TABLES)[number];

export const PANEL_EXPORT_FREQUENCIES = ['hourly', 'daily'] as const;
export type PanelExportFrequency = (typeof PANEL_EXPORT_FREQUENCIES)[number];

export const PANEL_EXPORT_STATUSES = ['active', 'paused', 'failing'] as const;
export type PanelExportStatus = (typeof PANEL_EXPORT_STATUSES)[number];

export const PANEL_EXPORT_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type PanelExportRunStatus = (typeof PANEL_EXPORT_RUN_STATUSES)[number];

/** Endpoint for a store other than AWS S3: an `https://` origin, no path, no credentials. */
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet', '.weldsuite.org'];

/**
 * A host name an outbound request from WeldSuite may go to: a dotted DNS name,
 * not an IP literal, not `localhost` or a private suffix, and none of
 * WeldSuite's own hosts. Customer-supplied endpoints (export buckets) are
 * checked with it on save and again right before each request.
 */
export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === '' || !host.includes('.') || host.startsWith('[') || host.includes(':')) return false;
  if (IPV4_LITERAL.test(host) || host === 'localhost' || host === 'weldsuite.org') return false;
  return !PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function isEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      (url.pathname === '/' || url.pathname === '') &&
      !url.search &&
      !url.hash &&
      isPublicHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

/** `/a/b/` → `a/b`: a prefix is joined with `/` itself. */
function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start += 1;
  while (end > start && value[end - 1] === '/') end -= 1;
  return value.slice(start, end);
}

/** S3 bucket naming (GCS also allows `_`). */
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
/** Object key prefix: safe S3 key characters, slashes between parts. */
const PREFIX = /^[A-Za-z0-9!_.*'()/-]*$/;

/**
 * Where an export writes: any S3-compatible API. AWS S3 needs only the region
 * and bucket; every other provider needs its `endpoint` (R2:
 * `https://<account>.r2.cloudflarestorage.com` with region `auto`; GCS:
 * `https://storage.googleapis.com` with HMAC keys).
 */
export const panelExportDestinationSchema = z
  .object({
    provider: z.enum(PANEL_EXPORT_PROVIDERS),
    endpoint: z
      .string()
      .max(500)
      .refine(isEndpoint, { message: 'Use an https:// origin without a path' })
      .nullable()
      .optional()
      .transform((v) => (v ? v.replace(/\/$/, '') : null)),
    region: z.string().trim().regex(/^[A-Za-z0-9-]{1,64}$/, 'Not a valid region'),
    bucket: z.string().trim().regex(BUCKET, 'Not a valid bucket name'),
    prefix: z
      .string()
      .trim()
      .max(200)
      .regex(PREFIX, 'Use letters, digits and / - _ . ! * \' ( ) only')
      .default('')
      .transform(trimSlashes),
    accessKeyId: z.string().trim().min(1).max(128),
    /** Path-style addressing (`endpoint/bucket/key`), for MinIO and most self-hosted stores. */
    pathStyle: z.boolean().default(false),
  })
  .superRefine((d, ctx) => {
    if (d.provider !== 's3' && !d.endpoint) ctx.addIssue({ code: 'custom', path: ['endpoint'], message: 'This provider needs its endpoint' });
  });
export type PanelExportDestinationInput = z.input<typeof panelExportDestinationSchema>;
export type ParsedPanelExportDestination = z.output<typeof panelExportDestinationSchema>;

const secretAccessKey = z.string().min(1).max(256);
const exportTables = z
  .array(z.enum(PANEL_EXPORT_TABLES))
  .min(1)
  .max(PANEL_EXPORT_TABLES.length)
  .transform((tables) => [...new Set(tables)]);

export const createPanelExportSchema = z.object({
  projectId,
  name,
  destination: panelExportDestinationSchema,
  /** Write-only: stored encrypted, never returned. */
  secretAccessKey,
  tables: exportTables,
  frequency: z.enum(PANEL_EXPORT_FREQUENCIES).default('daily'),
  /** Backfill from here (clamped to the plan's retention). Default: now. */
  startAt: isoDateTime.optional(),
});
export type CreatePanelExportInput = z.input<typeof createPanelExportSchema>;
export type ParsedCreatePanelExport = z.output<typeof createPanelExportSchema>;

export const updatePanelExportSchema = z.object({
  name: name.optional(),
  destination: panelExportDestinationSchema.optional(),
  secretAccessKey: secretAccessKey.optional(),
  tables: exportTables.optional(),
  frequency: z.enum(PANEL_EXPORT_FREQUENCIES).optional(),
});
export type UpdatePanelExportInput = z.input<typeof updatePanelExportSchema>;
export type ParsedUpdatePanelExport = z.output<typeof updatePanelExportSchema>;

/**
 * `POST /exports/test`: writes `_weldpanel_test.txt` under the prefix and
 * deletes it. Either a new destination with its secret, or a saved export
 * (`exportId`), optionally with a changed destination: the stored secret is
 * used unless a new one is sent.
 */
export const testPanelExportSchema = z
  .object({
    exportId: objectId.optional(),
    projectId: projectId.optional(),
    destination: panelExportDestinationSchema.optional(),
    secretAccessKey: secretAccessKey.optional(),
  })
  .refine((v) => Boolean(v.exportId) || Boolean(v.projectId && v.destination && v.secretAccessKey), {
    message: 'Send a saved export, or a project, destination and secret key',
  });
export type TestPanelExportInput = z.input<typeof testPanelExportSchema>;

export interface PanelExportTestDto {
  ok: boolean;
  /** The test file was written. */
  wrote: boolean;
  /** …and deleted again. */
  deleted: boolean;
  /** What the store answered when it refused. */
  error: string | null;
}

/** An export's destination as the API shows it (the secret is never returned). */
export interface PanelExportDestinationDto {
  provider: PanelExportProvider;
  endpoint: string | null;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  pathStyle: boolean;
}

export interface PanelExportDto {
  id: string;
  projectId: string;
  name: string;
  destination: PanelExportDestinationDto;
  tables: PanelExportTable[];
  frequency: PanelExportFrequency;
  startAt: string;
  /** Every row received before this has been written. */
  exportedUntil: string | null;
  status: PanelExportStatus;
  lastRunAt: string | null;
  lastError: string | null;
  nextRunAt: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PanelExportRunDto {
  id: string;
  exportId: string;
  table: PanelExportTable;
  windowFrom: string;
  windowTo: string;
  status: PanelExportRunStatus;
  rows: number;
  bytes: number;
  files: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

// ---------------------------------------------------------------------------
// Custom collector domains
// ---------------------------------------------------------------------------

export const PANEL_DOMAIN_STATUSES = ['pending', 'active', 'failed', 'deleting'] as const;
export type PanelDomainStatus = (typeof PANEL_DOMAIN_STATUSES)[number];

const LABEL = /^[a-z0-9-]{1,63}$/;
const TLD = /^[a-z]{2,63}$/;

/** A DNS host name: two or more labels of letters, digits and inner hyphens, a letters-only top level. */
export function isHostname(value: string): boolean {
  if (value.length < 4 || value.length > 253) return false;
  const labels = value.split('.');
  if (labels.length < 2 || !TLD.test(labels[labels.length - 1]!)) return false;
  return labels.every((label) => LABEL.test(label) && !label.startsWith('-') && !label.endsWith('-'));
}

/** A host name of the customer's own (`stats.example.com`), lower-cased. WeldSuite's own hosts are refused. */
export const createPanelDomainSchema = z.object({
  hostname: z
    .string()
    .trim()
    .toLowerCase()
    .refine(isHostname, { message: 'Enter a host name like stats.example.com' })
    .refine((h) => h !== 'weldsuite.org' && !h.endsWith('.weldsuite.org'), { message: 'Use a host name of your own' }),
});
export type CreatePanelDomainInput = z.input<typeof createPanelDomainSchema>;

/** A DNS record to add at the customer's DNS provider. */
export interface PanelDomainRecordDto {
  type: 'CNAME' | 'TXT';
  name: string;
  value: string;
  /** `routing`: sends the traffic; `ownership` and `certificate`: prove the host is theirs. */
  purpose: 'routing' | 'ownership' | 'certificate';
}

export interface PanelDomainDto {
  id: string;
  projectId: string;
  hostname: string;
  status: PanelDomainStatus;
  /** Cloudflare's certificate status, as reported. */
  sslStatus: string | null;
  records: PanelDomainRecordDto[];
  lastError: string | null;
  lastCheckedAt: string | null;
  /** `https://<hostname>/s.js` once active, else null. */
  scriptUrl: string | null;
  /** The install snippet served from this host, once active. */
  snippet: string | null;
  createdAt: string;
}
