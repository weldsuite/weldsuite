/**
 * Sample answers for WeldPanel monitoring and data out: alerts (with their
 * history), scheduled reports (subscriptions), raw exports with their runs,
 * and custom collector domains. Module-level state, so changes stick for the
 * session.
 */

import type {
  CreatePanelAlertInput,
  CreatePanelDomainInput,
  CreatePanelExportInput,
  CreatePanelSubscriptionInput,
  PanelAlertCondition,
  PanelAlertDto,
  PanelAlertEventDto,
  PanelAlertEventKind,
  PanelCheckInterval,
  PanelDeliveryChannelsDto,
  PanelDeliveryChannelsInput,
  PanelDeliveryReportDto,
  PanelDeliveryResult,
  PanelDomainDto,
  PanelExportDto,
  PanelExportRunDto,
  PanelExportTable,
  PanelSubscriptionDto,
  PanelSubscriptionSchedule,
  SnoozePanelAlertInput,
  TestPanelExportInput,
  UpdatePanelAlertInput,
  UpdatePanelExportInput,
  UpdatePanelSubscriptionInput,
} from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { UNHANDLED, type SampleAreaHandler, type SampleRequest } from '../request';
import { bodyAs, notFound, removeAt, routeResource, type CollectionContext, type ItemContext, type ResourceRoutes } from './collab-routes';
import { APP_PROJECT_ID, DAY_MS, MEMBERS, WEBSITE_PROJECT_ID, data, isoDaysAgo, isoMinutesAgo, list, rng, sampleId } from '../dataset';

const ME = MEMBERS[0].userId;
const W = WEBSITE_PROJECT_ID;
const A = APP_PROJECT_ID;

function member(index: number): string {
  return MEMBERS[index % MEMBERS.length]!.userId;
}

function inMinutes(minutes: number): string {
  return isoMinutesAgo(-minutes);
}

function channels(emails: number[], opts: { inApp?: boolean; slack?: boolean; weldchat?: string | null } = {}): PanelDeliveryChannelsDto {
  return { emailUserIds: emails.map(member), inApp: opts.inApp ?? false, slack: opts.slack ?? false, weldchatChannelId: opts.weldchat ?? null };
}

function channelsFromInput(input: PanelDeliveryChannelsInput | undefined, previous?: PanelDeliveryChannelsDto): PanelDeliveryChannelsDto {
  if (!input) return previous ?? channels([0], { inApp: true });
  return {
    emailUserIds: [...new Set(input.emailUserIds ?? [])],
    inApp: input.inApp ?? false,
    slack: input.slackWebhookUrl === undefined ? (previous?.slack ?? false) : Boolean(input.slackWebhookUrl),
    weldchatChannelId: input.weldchatChannelId === undefined ? (previous?.weldchatChannelId ?? null) : input.weldchatChannelId,
  };
}

/** What a message to these channels would report, one result per channel. */
function deliveryReport(dto: PanelDeliveryChannelsDto, failing: 'slack' | null = null): PanelDeliveryReportDto {
  const delivered: PanelDeliveryResult[] = [];
  if (dto.emailUserIds.length > 0) delivered.push({ channel: 'email', ok: true, recipients: dto.emailUserIds.length, error: null });
  if (dto.inApp) delivered.push({ channel: 'in_app', ok: true, recipients: Math.max(1, dto.emailUserIds.length), error: null });
  if (dto.slack) {
    delivered.push(
      failing === 'slack'
        ? { channel: 'slack', ok: false, recipients: 0, error: 'Slack answered 404: the webhook no longer exists' }
        : { channel: 'slack', ok: true, recipients: 1, error: null },
    );
  }
  if (dto.weldchatChannelId) delivered.push({ channel: 'weldchat', ok: true, recipients: 1, error: null });
  return { delivered };
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

function trendsSpecFor(projectId: string, event: string, math: string): Record<string, unknown> {
  return { kind: 'trends', projectId, dateRange: { preset: '7d' }, timezone: 'Europe/Amsterdam', series: [{ event, math }], interval: 'day' };
}

const alerts: PanelAlertDto[] = [
  {
    id: 'pnal_sample_signups',
    projectId: W,
    name: 'Sign-ups dropped below 40 a day',
    reportId: 'rep_sample_signups',
    spec: null,
    seriesIndex: 0,
    condition: { type: 'threshold', operator: 'below', value: 40 },
    checkInterval: 'daily',
    channels: channels([0, 1], { inApp: true, slack: true }),
    enabled: true,
    state: 'firing',
    lastValue: 31,
    lastCheckedAt: isoMinutesAgo(95),
    lastFiredAt: isoDaysAgo(0, 6, 5),
    lastError: null,
    snoozedUntil: null,
    nextCheckAt: inMinutes(60 * 22),
    ownerUserId: member(0),
    createdAt: isoDaysAgo(58, 10, 0),
    updatedAt: isoDaysAgo(0, 6, 5),
  },
  {
    id: 'pnal_sample_traffic',
    projectId: W,
    name: 'Unusual traffic on the website',
    reportId: null,
    spec: trendsSpecFor(W, '$pageview', 'total'),
    seriesIndex: 0,
    condition: { type: 'anomaly', sensitivity: 'medium' },
    checkInterval: 'hourly',
    channels: channels([0], { inApp: true }),
    enabled: true,
    state: 'ok',
    lastValue: 187,
    lastCheckedAt: isoMinutesAgo(22),
    lastFiredAt: isoDaysAgo(6, 13, 0),
    lastError: null,
    snoozedUntil: null,
    nextCheckAt: inMinutes(38),
    ownerUserId: member(0),
    createdAt: isoDaysAgo(44, 14, 0),
    updatedAt: isoDaysAgo(6, 14, 10),
  },
  {
    id: 'pnal_sample_trials',
    projectId: W,
    name: 'Trial starts fell by a quarter',
    reportId: 'rep_sample_campaigns',
    spec: null,
    seriesIndex: 1,
    condition: { type: 'change', direction: 'decrease', percent: 25 },
    checkInterval: 'weekly',
    channels: channels([1, 2], { weldchat: 'chn_sample_growth' }),
    enabled: true,
    state: 'ok',
    lastValue: 402,
    lastCheckedAt: isoDaysAgo(1, 7, 0),
    lastFiredAt: isoDaysAgo(23, 7, 0),
    lastError: null,
    snoozedUntil: null,
    nextCheckAt: inMinutes(60 * 24 * 6),
    ownerUserId: member(1),
    createdAt: isoDaysAgo(70, 9, 0),
    updatedAt: isoDaysAgo(23, 9, 0),
  },
  {
    id: 'pnal_sample_checkout',
    projectId: A,
    name: 'Checkouts below 5 a day',
    reportId: 'rep_sample_checkout_funnel',
    spec: null,
    seriesIndex: 0,
    condition: { type: 'threshold', operator: 'below', value: 5 },
    checkInterval: 'daily',
    channels: channels([0, 3], { inApp: true }),
    enabled: true,
    state: 'ok',
    lastValue: 12,
    lastCheckedAt: isoMinutesAgo(380),
    lastFiredAt: isoDaysAgo(11, 6, 0),
    lastError: null,
    snoozedUntil: inMinutes(60 * 30),
    nextCheckAt: inMinutes(60 * 17),
    ownerUserId: member(3),
    createdAt: isoDaysAgo(90, 11, 0),
    updatedAt: isoDaysAgo(1, 9, 30),
  },
  {
    id: 'pnal_sample_tickets',
    projectId: A,
    name: 'Ticket volume looks odd',
    reportId: null,
    spec: trendsSpecFor(A, 'ticket_created', 'total'),
    seriesIndex: 0,
    condition: { type: 'anomaly', sensitivity: 'high' },
    checkInterval: 'hourly',
    channels: channels([2], { slack: true }),
    enabled: true,
    state: 'firing',
    lastValue: 61,
    lastCheckedAt: isoMinutesAgo(14),
    lastFiredAt: isoMinutesAgo(74),
    lastError: null,
    snoozedUntil: null,
    nextCheckAt: inMinutes(46),
    ownerUserId: member(2),
    createdAt: isoDaysAgo(35, 15, 0),
    updatedAt: isoMinutesAgo(74),
  },
  {
    id: 'pnal_sample_installs',
    projectId: A,
    name: 'Module installs spiked',
    reportId: 'rep_sample_module_usage',
    spec: null,
    seriesIndex: 2,
    condition: { type: 'change', direction: 'increase', percent: 50 },
    checkInterval: 'daily',
    channels: channels([1]),
    enabled: false,
    state: 'ok',
    lastValue: 88,
    lastCheckedAt: isoDaysAgo(9, 6, 0),
    lastFiredAt: isoDaysAgo(26, 6, 0),
    lastError: null,
    snoozedUntil: null,
    nextCheckAt: null,
    ownerUserId: member(1),
    createdAt: isoDaysAgo(80, 10, 0),
    updatedAt: isoDaysAgo(9, 8, 0),
  },
  {
    id: 'pnal_sample_demos',
    projectId: W,
    name: 'Demo requests per day',
    reportId: null,
    spec: trendsSpecFor(W, 'demo_requested', 'total'),
    seriesIndex: 0,
    condition: { type: 'threshold', operator: 'below', value: 10 },
    checkInterval: 'daily',
    channels: channels([0], { slack: true }),
    enabled: true,
    state: 'error',
    lastValue: null,
    lastCheckedAt: isoMinutesAgo(300),
    lastFiredAt: null,
    lastError: 'The Slack webhook answered 404, so the alert could not be delivered.',
    snoozedUntil: null,
    nextCheckAt: inMinutes(60 * 19),
    ownerUserId: member(0),
    createdAt: isoDaysAgo(12, 13, 0),
    updatedAt: isoMinutesAgo(300),
  },
  {
    id: 'pnal_sample_new',
    projectId: W,
    name: 'Newsletter sign-ups change',
    reportId: 'rep_sample_signups',
    spec: null,
    seriesIndex: 0,
    condition: { type: 'change', direction: 'any', percent: 40 },
    checkInterval: 'weekly',
    channels: channels([3], { inApp: true }),
    enabled: true,
    state: 'pending',
    lastValue: null,
    lastCheckedAt: null,
    lastFiredAt: null,
    lastError: null,
    snoozedUntil: null,
    nextCheckAt: inMinutes(60 * 3),
    ownerUserId: member(3),
    createdAt: isoMinutesAgo(50),
    updatedAt: isoMinutesAgo(50),
  },
];

function alertEvent(alertId: string, n: number, kind: PanelAlertEventKind, createdAt: string, value: number | null, bound: number | null, message: string | null): PanelAlertEventDto {
  return { id: `pnae_${alertId.slice(-8)}_${n}`, alertId, kind, value, bound, message, createdAt };
}

const alertEvents = new Map<string, PanelAlertEventDto[]>([
  [
    'pnal_sample_signups',
    [
      alertEvent('pnal_sample_signups', 1, 'fired', isoDaysAgo(0, 6, 5), 31, 40, 'Sign-ups per day was 31 yesterday, below your limit of 40.'),
      alertEvent('pnal_sample_signups', 2, 'resolved', isoDaysAgo(3, 6, 5), 66, 40, 'Back above 40: 66 yesterday.'),
      alertEvent('pnal_sample_signups', 3, 'fired', isoDaysAgo(5, 6, 5), 28, 40, 'Sign-ups per day was 28 on Sunday, below your limit of 40.'),
      alertEvent('pnal_sample_signups', 4, 'resolved', isoDaysAgo(6, 6, 5), 52, 40, 'Back above 40: 52 yesterday.'),
      alertEvent('pnal_sample_signups', 5, 'fired', isoDaysAgo(12, 6, 5), 35, 40, 'Sign-ups per day was 35 yesterday, below your limit of 40.'),
      alertEvent('pnal_sample_signups', 6, 'resolved', isoDaysAgo(13, 6, 5), 78, 40, 'Back above 40: 78 yesterday.'),
      alertEvent('pnal_sample_signups', 7, 'error', isoDaysAgo(19, 6, 5), null, null, 'The check could not run: the report took too long to answer.'),
    ],
  ],
  [
    'pnal_sample_traffic',
    [
      alertEvent('pnal_sample_traffic', 1, 'resolved', isoDaysAgo(6, 15, 0), 176, 410, 'Traffic is back within the usual range.'),
      alertEvent('pnal_sample_traffic', 2, 'fired', isoDaysAgo(6, 13, 0), 640, 410, 'Page views in the last hour were 640, above the usual range (up to 410).'),
      alertEvent('pnal_sample_traffic', 3, 'fired', isoDaysAgo(21, 17, 0), 22, 60, 'Page views in the last hour were 22, below the usual range (at least 60).'),
      alertEvent('pnal_sample_traffic', 4, 'resolved', isoDaysAgo(21, 19, 0), 118, 60, 'Traffic is back within the usual range.'),
    ],
  ],
  [
    'pnal_sample_trials',
    [
      alertEvent('pnal_sample_trials', 1, 'resolved', isoDaysAgo(16, 7, 0), 455, 410, 'Trial starts recovered: 455 last week.'),
      alertEvent('pnal_sample_trials', 2, 'fired', isoDaysAgo(23, 7, 0), 301, 410, 'Trial starts fell 27% to 301 last week, from 412.'),
    ],
  ],
  [
    'pnal_sample_checkout',
    [
      alertEvent('pnal_sample_checkout', 1, 'resolved', isoDaysAgo(10, 6, 0), 9, 5, 'Checkouts are back above 5.'),
      alertEvent('pnal_sample_checkout', 2, 'fired', isoDaysAgo(11, 6, 0), 3, 5, 'Checkouts per day was 3 yesterday, below your limit of 5.'),
    ],
  ],
  [
    'pnal_sample_tickets',
    [
      alertEvent('pnal_sample_tickets', 1, 'fired', isoMinutesAgo(74), 61, 38, 'Tickets in the last hour were 61, above the usual range (up to 38).'),
      alertEvent('pnal_sample_tickets', 2, 'resolved', isoDaysAgo(2, 11, 0), 24, 38, 'Ticket volume is back within the usual range.'),
      alertEvent('pnal_sample_tickets', 3, 'fired', isoDaysAgo(2, 9, 0), 52, 38, 'Tickets in the last hour were 52, above the usual range (up to 38).'),
    ],
  ],
  [
    'pnal_sample_installs',
    [
      alertEvent('pnal_sample_installs', 1, 'resolved', isoDaysAgo(25, 6, 0), 61, 90, 'Installs are back to normal.'),
      alertEvent('pnal_sample_installs', 2, 'fired', isoDaysAgo(26, 6, 0), 142, 90, 'Module installs rose 58% to 142 yesterday, from 90.'),
    ],
  ],
  [
    'pnal_sample_demos',
    [alertEvent('pnal_sample_demos', 1, 'error', isoMinutesAgo(300), null, null, 'The Slack webhook answered 404, so the alert could not be delivered.')],
  ],
]);

function nextCheck(interval: PanelCheckInterval): string {
  if (interval === 'hourly') return inMinutes(40);
  if (interval === 'daily') return inMinutes(60 * 14);
  return inMinutes(60 * 24 * 4);
}

function alertFromInput(input: CreatePanelAlertInput): PanelAlertDto {
  const now = new Date().toISOString();
  const interval = input.checkInterval ?? 'daily';
  const enabled = input.enabled ?? true;
  return {
    id: sampleId('pnal'),
    projectId: input.projectId,
    name: input.name,
    reportId: input.reportId ?? null,
    spec: input.spec ?? null,
    seriesIndex: input.seriesIndex ?? 0,
    condition: input.condition,
    checkInterval: interval,
    channels: channelsFromInput(input.channels),
    enabled,
    state: 'pending',
    lastValue: null,
    lastCheckedAt: null,
    lastFiredAt: null,
    lastError: null,
    snoozedUntil: null,
    nextCheckAt: enabled ? nextCheck(interval) : null,
    ownerUserId: ME,
    createdAt: now,
    updatedAt: now,
  };
}

function applyAlertUpdate(current: PanelAlertDto, input: UpdatePanelAlertInput): PanelAlertDto {
  const switchedTarget = input.reportId !== undefined || input.spec !== undefined;
  const enabled = input.enabled ?? current.enabled;
  const interval = input.checkInterval ?? current.checkInterval;
  const condition: PanelAlertCondition = input.condition ?? current.condition;
  return {
    ...current,
    name: input.name ?? current.name,
    reportId: switchedTarget ? (input.reportId ?? null) : current.reportId,
    spec: switchedTarget ? (input.spec ?? null) : current.spec,
    seriesIndex: input.seriesIndex ?? current.seriesIndex,
    condition,
    checkInterval: interval,
    channels: input.channels ? channelsFromInput(input.channels, current.channels) : current.channels,
    enabled,
    nextCheckAt: enabled ? (current.nextCheckAt ?? nextCheck(interval)) : null,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/** The next (`direction` 1) or latest past (-1) occurrence of a schedule, in local time. */
function occurrence(schedule: PanelSubscriptionSchedule, direction: 1 | -1): string {
  const now = Date.now();
  for (let step = 0; step <= 62; step++) {
    const date = new Date(now + direction * step * DAY_MS);
    date.setHours(schedule.hour, 0, 0, 0);
    const matches =
      schedule.frequency === 'daily' ||
      (schedule.frequency === 'weekly' && date.getDay() === schedule.weekday) ||
      (schedule.frequency === 'monthly' && date.getDate() === schedule.monthDay);
    if (matches && (direction === 1 ? date.getTime() > now : date.getTime() <= now)) return date.toISOString();
  }
  return new Date(now + direction * DAY_MS).toISOString();
}

function subscription(
  id: string,
  projectId: string,
  name: string,
  targetType: PanelSubscriptionDto['targetType'],
  targetId: string,
  schedule: PanelSubscriptionSchedule,
  dto: PanelDeliveryChannelsDto,
  extra: { enabled?: boolean; lastError?: string | null; owner?: number; days?: number } = {},
): PanelSubscriptionDto {
  const enabled = extra.enabled ?? true;
  return {
    id,
    projectId,
    name,
    targetType,
    targetId,
    schedule,
    channels: dto,
    enabled,
    nextRunAt: enabled ? occurrence(schedule, 1) : null,
    lastRunAt: occurrence(schedule, -1),
    lastError: extra.lastError ?? null,
    ownerUserId: member(extra.owner ?? 0),
    createdAt: isoDaysAgo(extra.days ?? 40, 10, 0),
    updatedAt: isoDaysAgo(Math.max(0, (extra.days ?? 40) - 14), 10, 0),
  };
}

const subscriptions: PanelSubscriptionDto[] = [
  subscription('pnsb_sample_growth', W, 'Growth dashboard every Monday', 'dashboard', 'dash_sample_growth', { frequency: 'weekly', weekday: 1, hour: 8, timezone: 'Europe/Amsterdam' }, channels([0, 1, 2], { inApp: true }), { days: 64 }),
  subscription('pnsb_sample_signups', W, 'Daily sign-ups', 'report', 'rep_sample_signups', { frequency: 'daily', hour: 7, timezone: 'Europe/Amsterdam' }, channels([0], { slack: true }), { days: 51 }),
  subscription('pnsb_sample_funnel', W, 'Monthly funnel review', 'report', 'rep_sample_trial_funnel', { frequency: 'monthly', monthDay: 1, hour: 9, timezone: 'Europe/Amsterdam' }, channels([0, 1, 3]), { owner: 1, days: 83 }),
  subscription('pnsb_sample_product', A, 'Product health for the team channel', 'dashboard', 'dash_sample_product', { frequency: 'weekly', weekday: 5, hour: 16, timezone: 'Europe/Amsterdam' }, channels([], { weldchat: 'chn_sample_product' }), { owner: 2, days: 30 }),
  subscription('pnsb_sample_retention', A, 'Retention snapshot', 'report', 'rep_sample_retention', { frequency: 'weekly', weekday: 3, hour: 10, timezone: 'America/New_York' }, channels([3], { inApp: true }), { owner: 3, days: 22 }),
  subscription('pnsb_sample_marketing', W, 'Marketing site, board copy', 'dashboard', 'dash_sample_marketing', { frequency: 'monthly', monthDay: 15, hour: 12, timezone: 'Europe/Amsterdam' }, channels([0, 1], { slack: true }), {
    lastError: 'Slack answered 404: the webhook no longer exists. Emails were sent.',
    days: 70,
  }),
  subscription('pnsb_sample_vitals', W, 'Core web vitals (paused)', 'report', 'rep_sample_vitals', { frequency: 'weekly', weekday: 2, hour: 9, timezone: 'Europe/Amsterdam' }, channels([2]), { enabled: false, owner: 2, days: 95 }),
];

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** How far an export has got, by how it is doing: failing and paused ones are behind. */
function exportedUntilOf(status: PanelExportDto['status'], hourly: boolean): string {
  if (status === 'failing') return isoDaysAgo(3, 0, 0);
  if (status === 'paused') return isoDaysAgo(9, 0, 0);
  return hourly ? isoMinutesAgo(75) : isoDaysAgo(1, 0, 0);
}

function lastRunOf(status: PanelExportDto['status'], hourly: boolean): string {
  if (status === 'failing') return isoMinutesAgo(190);
  if (status === 'paused') return isoDaysAgo(9, 3, 0);
  return hourly ? isoMinutesAgo(28) : isoDaysAgo(0, 3, 0);
}

function nextRunOf(status: PanelExportDto['status'], hourly: boolean): string | null {
  if (status === 'active') return inMinutes(hourly ? 32 : 60 * 12);
  return status === 'failing' ? inMinutes(55) : null;
}

function exportDto(
  id: string,
  projectId: string,
  name: string,
  destination: PanelExportDto['destination'],
  tables: PanelExportTable[],
  frequency: PanelExportDto['frequency'],
  status: PanelExportDto['status'],
  days: number,
  lastError: string | null = null,
): PanelExportDto {
  const hourly = frequency === 'hourly';
  return {
    id,
    projectId,
    name,
    destination,
    tables,
    frequency,
    startAt: isoDaysAgo(days, 0, 0),
    exportedUntil: exportedUntilOf(status, hourly),
    status,
    lastRunAt: lastRunOf(status, hourly),
    lastError,
    nextRunAt: nextRunOf(status, hourly),
    createdByUserId: member(0),
    createdAt: isoDaysAgo(days, 11, 0),
    updatedAt: isoDaysAgo(Math.max(0, days - 20), 11, 0),
  };
}

const exportsList: PanelExportDto[] = [
  exportDto('pnex_sample_warehouse', W, 'Data warehouse (S3)', { provider: 's3', endpoint: null, region: 'eu-west-1', bucket: 'weldsuite-analytics-raw', prefix: 'weldpanel/website', accessKeyId: 'AKIAWELDSAMPLE7Q2X', pathStyle: false }, ['events', 'people', 'groups'], 'daily', 'active', 110),
  exportDto('pnex_sample_r2', A, 'Product events to R2', { provider: 'r2', endpoint: 'https://3f9a1c27d5b84e0a.r2.cloudflarestorage.com', region: 'auto', bucket: 'product-events', prefix: 'app', accessKeyId: 'a82f31c0d9e44b7aa1c6', pathStyle: false }, ['events'], 'hourly', 'active', 54),
  exportDto('pnex_sample_gcs', W, 'BigQuery staging', { provider: 'gcs', endpoint: 'https://storage.googleapis.com', region: 'europe-west4', bucket: 'bq-staging-weldsuite', prefix: 'panel', accessKeyId: 'GOOGSAMPLEHMAC0183', pathStyle: false }, ['events', 'people'], 'daily', 'paused', 88),
  exportDto('pnex_sample_minio', A, 'Finance archive (MinIO)', { provider: 'minio', endpoint: 'https://minio.finance-archive.nl', region: 'eu-central-1', bucket: 'panel-archive', prefix: 'exports/app', accessKeyId: 'finance-archiver', pathStyle: true }, ['events', 'people', 'identities'], 'daily', 'failing', 36, 'AccessDenied: the access key is not allowed to write to panel-archive/exports/app/'),
];

function tableScale(table: PanelExportTable): number {
  if (table === 'events') return 1;
  if (table === 'people') return 0.06;
  return table === 'groups' ? 0.02 : 0.03;
}

/** How many windows back an export's history starts: paused and failing ones stopped a while ago. */
function runOffset(exp: PanelExportDto, hourly: boolean): number {
  if (exp.status === 'paused') return hourly ? 0 : 9;
  return exp.status === 'failing' ? 3 : 0;
}

/** One run: one table over one window. The newest runs of a failing export fail on the events table. */
function exportRun(exp: PanelExportDto, table: PanelExportTable, tableIndex: number, windowIndex: number, window: { from: Date; to: Date }, random: () => number): PanelExportRunDto {
  const hourly = exp.frequency === 'hourly';
  const rows = Math.round((hourly ? 5200 : 118_000) * tableScale(table) * (0.85 + random() * 0.3));
  const started = new Date(window.to.getTime() + 9 * 60_000 + tableIndex * 2 * 60_000);
  const fails = exp.status === 'failing' && windowIndex < 2 && table === 'events';
  const bytesPerRow = table === 'events' ? 410 : 780;
  const figures = fails ? { rows: 0, bytes: 0, files: 0 } : { rows, bytes: rows * bytesPerRow, files: Math.max(1, Math.ceil(rows / 60_000)) };
  return {
    id: `pnxr_${exp.id.slice(-8)}_${windowIndex}_${tableIndex}`,
    exportId: exp.id,
    table,
    windowFrom: window.from.toISOString(),
    windowTo: window.to.toISOString(),
    status: fails ? 'failed' : 'succeeded',
    ...figures,
    error: fails ? (exp.lastError ?? 'AccessDenied') : null,
    startedAt: started.toISOString(),
    finishedAt: new Date(started.getTime() + (20 + Math.round(random() * 90)) * 1000).toISOString(),
  };
}

function runsFor(exp: PanelExportDto): PanelExportRunDto[] {
  const random = rng(`runs-${exp.id}`);
  const out: PanelExportRunDto[] = [];
  const hourly = exp.frequency === 'hourly';
  const hourMs = 3_600_000;
  const stepMs = hourly ? hourMs : DAY_MS;
  for (let w = 0; w < (hourly ? 14 : 8); w++) {
    const baseEnd = new Date(hourly ? Math.floor(Date.now() / hourMs) * hourMs : new Date().setHours(0, 0, 0, 0));
    const to = new Date(baseEnd.getTime() - (w + runOffset(exp, hourly)) * stepMs - (hourly ? 60 * 60_000 : 0));
    const window = { from: new Date(to.getTime() - stepMs), to };
    exp.tables.forEach((table, t) => out.push(exportRun(exp, table, t, w, window, random)));
  }
  return out;
}

const runsByExport = new Map<string, PanelExportRunDto[]>(exportsList.map((e) => [e.id, runsFor(e)]));

// ---------------------------------------------------------------------------
// Collector domains
// ---------------------------------------------------------------------------

function activeDomain(id: string, projectId: string, hostname: string, days: number): PanelDomainDto {
  return {
    id,
    projectId,
    hostname,
    status: 'active',
    sslStatus: 'active',
    records: [{ type: 'CNAME', name: hostname, value: 'collect.weldsuite.org', purpose: 'routing' }],
    lastError: null,
    lastCheckedAt: isoMinutesAgo(6),
    scriptUrl: `https://${hostname}/s.js`,
    snippet: domainSnippet(hostname),
    createdAt: isoDaysAgo(days, 12, 0),
  };
}

function domainSnippet(hostname: string): string {
  return `<script async src="https://${hostname}/s.js" data-token="wpk_sample_site_7f3a91"></script>`;
}

function pendingDomain(id: string, projectId: string, hostname: string, minutes: number): PanelDomainDto {
  return {
    id,
    projectId,
    hostname,
    status: 'pending',
    sslStatus: 'pending_validation',
    records: [
      { type: 'CNAME', name: hostname, value: 'collect.weldsuite.org', purpose: 'routing' },
      { type: 'TXT', name: `_cf-custom-hostname.${hostname}`, value: '4c7e1d52-9b1a-47f0-8a0b-33f2d6c6a9e1', purpose: 'ownership' },
      { type: 'TXT', name: `_acme-challenge.${hostname}`, value: 'Vf2J0pQxk7mYHc8sB1nZrA4dLw9tEoU3gXiK6hNqD5E', purpose: 'certificate' },
    ],
    lastError: null,
    lastCheckedAt: isoMinutesAgo(minutes),
    scriptUrl: null,
    snippet: null,
    createdAt: isoMinutesAgo(minutes + 25),
  };
}

const domains: PanelDomainDto[] = [
  activeDomain('pndm_sample_stats', W, 'stats.weldsuite.com', 74),
  pendingDomain('pndm_sample_insights', W, 'insights.weldsuite.com', 12),
  {
    ...pendingDomain('pndm_sample_old', W, 'analytics.weldsuite-demo.net', 60 * 30),
    status: 'failed',
    sslStatus: 'validation_timed_out',
    lastError: 'The DNS records were not found within 7 days. Check the CNAME and TXT records at your DNS provider and add the host name again.',
  },
  activeDomain('pndm_sample_app', A, 'collect.app.weldsuite.com', 41),
];

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function mineOnly<T extends { ownerUserId: string }>(items: T[], scope: string | null): T[] {
  return scope === 'mine' ? items.filter((i) => i.ownerUserId === ME) : items;
}

function limitOf(query: URLSearchParams): number {
  const limit = Number(query.get('limit'));
  return Number.isFinite(limit) && limit > 0 ? limit : 100;
}

// Alerts

function alertsOf({ request }: CollectionContext): unknown {
  const projectId = request.query.get('projectId');
  return list(mineOnly(alerts, request.query.get('scope')).filter((a) => !projectId || a.projectId === projectId));
}

function createAlert({ request }: CollectionContext): unknown {
  const created = alertFromInput(bodyAs<CreatePanelAlertInput>(request.body));
  alerts.unshift(created);
  alertEvents.set(created.id, []);
  return data(created);
}

function updateAlert({ request, current, index }: ItemContext<PanelAlertDto>): unknown {
  const updated = applyAlertUpdate(current, bodyAs<UpdatePanelAlertInput>(request.body));
  alerts[index] = updated;
  return data(updated);
}

function deleteAlert({ id, index }: ItemContext<PanelAlertDto>): undefined {
  alertEvents.delete(id);
  return removeAt(alerts, index);
}

function alertHistory({ id, request }: ItemContext<PanelAlertDto>): unknown {
  const events = [...(alertEvents.get(id) ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return list(events.slice(0, limitOf(request.query)));
}

function snoozeAlert({ request, current, index, now }: ItemContext<PanelAlertDto>): unknown {
  const input = bodyAs<SnoozePanelAlertInput>(request.body);
  const updated: PanelAlertDto = { ...current, snoozedUntil: input.until ?? null, updatedAt: now };
  alerts[index] = updated;
  return data(updated);
}

const alertRoutes: ResourceRoutes<PanelAlertDto> = {
  items: alerts,
  what: 'alert',
  collection: { GET: alertsOf, POST: createAlert },
  item: { GET: ({ current }) => data(current), PATCH: updateAlert, DELETE: deleteAlert },
  actions: {
    events: { GET: alertHistory },
    test: { POST: ({ current }) => data(deliveryReport(current.channels)) },
    snooze: { POST: snoozeAlert },
  },
};

// Subscriptions

function subscriptionsOf({ request }: CollectionContext): unknown {
  const { query } = request;
  const projectId = query.get('projectId');
  const targetType = query.get('targetType');
  const targetId = query.get('targetId');
  return list(
    mineOnly(subscriptions, query.get('scope'))
      .filter((s) => !projectId || s.projectId === projectId)
      .filter((s) => !targetType || s.targetType === targetType)
      .filter((s) => !targetId || s.targetId === targetId),
  );
}

function createSubscription({ request, now }: CollectionContext): unknown {
  const input = bodyAs<CreatePanelSubscriptionInput>(request.body);
  const schedule: PanelSubscriptionSchedule = { ...input.schedule, timezone: input.schedule.timezone ?? 'UTC' };
  const enabled = input.enabled ?? true;
  const created: PanelSubscriptionDto = {
    id: sampleId('pnsb'),
    projectId: input.projectId,
    name: input.name,
    targetType: input.targetType,
    targetId: input.targetId,
    schedule,
    channels: channelsFromInput(input.channels),
    enabled,
    nextRunAt: enabled ? occurrence(schedule, 1) : null,
    lastRunAt: null,
    lastError: null,
    ownerUserId: ME,
    createdAt: now,
    updatedAt: now,
  };
  subscriptions.unshift(created);
  return data(created);
}

function updateSubscription({ request, current, index, now }: ItemContext<PanelSubscriptionDto>): unknown {
  const input = bodyAs<UpdatePanelSubscriptionInput>(request.body);
  const schedule: PanelSubscriptionSchedule = input.schedule ? { ...input.schedule, timezone: input.schedule.timezone ?? 'UTC' } : current.schedule;
  const enabled = input.enabled ?? current.enabled;
  const updated: PanelSubscriptionDto = {
    ...current,
    name: input.name ?? current.name,
    schedule,
    channels: input.channels ? channelsFromInput(input.channels, current.channels) : current.channels,
    enabled,
    nextRunAt: enabled ? occurrence(schedule, 1) : null,
    updatedAt: now,
  };
  subscriptions[index] = updated;
  return data(updated);
}

/** A subscription that failed before still fails on Slack, so the failure can be seen. */
function sendSubscriptionNow({ current, index, now }: ItemContext<PanelSubscriptionDto>): unknown {
  const failing = current.lastError !== null ? 'slack' : null;
  subscriptions[index] = { ...current, lastRunAt: now, updatedAt: now };
  return data(deliveryReport(current.channels, failing));
}

const subscriptionRoutes: ResourceRoutes<PanelSubscriptionDto> = {
  items: subscriptions,
  what: 'subscription',
  collection: { GET: subscriptionsOf, POST: createSubscription },
  item: { GET: ({ current }) => data(current), PATCH: updateSubscription, DELETE: ({ index }) => removeAt(subscriptions, index) },
  actions: { 'send-now': { POST: sendSubscriptionNow } },
};

// Exports

function destinationOf(input: CreatePanelExportInput['destination']): PanelExportDto['destination'] {
  return {
    provider: input.provider,
    endpoint: input.endpoint ?? null,
    region: input.region,
    bucket: input.bucket,
    prefix: input.prefix ?? '',
    accessKeyId: input.accessKeyId,
    pathStyle: input.pathStyle ?? false,
  };
}

function createExport({ request, now }: CollectionContext): unknown {
  const input = bodyAs<CreatePanelExportInput>(request.body);
  const created: PanelExportDto = {
    id: sampleId('pnex'),
    projectId: input.projectId,
    name: input.name,
    destination: destinationOf(input.destination),
    tables: [...new Set(input.tables)],
    frequency: input.frequency ?? 'daily',
    startAt: input.startAt ?? now,
    exportedUntil: null,
    status: 'active',
    lastRunAt: null,
    lastError: null,
    nextRunAt: inMinutes(20),
    createdByUserId: ME,
    createdAt: now,
    updatedAt: now,
  };
  exportsList.unshift(created);
  runsByExport.set(created.id, []);
  return data(created);
}

function updateExport({ request, current, index, now }: ItemContext<PanelExportDto>): unknown {
  const input = bodyAs<UpdatePanelExportInput>(request.body);
  const updated: PanelExportDto = {
    ...current,
    name: input.name ?? current.name,
    destination: input.destination ? destinationOf(input.destination) : current.destination,
    tables: input.tables ? [...new Set(input.tables)] : current.tables,
    frequency: input.frequency ?? current.frequency,
    updatedAt: now,
  };
  exportsList[index] = updated;
  return data(updated);
}

function deleteExport({ id, index }: ItemContext<PanelExportDto>): undefined {
  runsByExport.delete(id);
  return removeAt(exportsList, index);
}

function setExportState(changes: Partial<PanelExportDto>): (context: ItemContext<PanelExportDto>) => unknown {
  return ({ current, index, now }) => {
    const updated: PanelExportDto = { ...current, ...changes, updatedAt: now };
    exportsList[index] = updated;
    return data(updated);
  };
}

const exportRoutes: ResourceRoutes<PanelExportDto> = {
  items: exportsList,
  what: 'export',
  collection: {
    GET: ({ request }) => list(exportsList.filter((e) => e.projectId === request.query.get('projectId'))),
    POST: createExport,
  },
  item: { GET: ({ current }) => data(current), PATCH: updateExport, DELETE: deleteExport },
  actions: {
    runs: { GET: ({ id, request }) => list((runsByExport.get(id) ?? []).slice(0, limitOf(request.query))) },
    pause: { POST: setExportState({ status: 'paused', nextRunAt: null }) },
    resume: { POST: setExportState({ status: 'active', lastError: null, nextRunAt: inMinutes(15) }) },
  },
};

/** `POST /panel/exports/test`: try the bucket. A failing sample export only works once a new secret key is given. */
function testExport(body: unknown): unknown {
  const input = bodyAs<TestPanelExportInput>(body);
  const saved = input.exportId ? exportsList.find((e) => e.id === input.exportId) : undefined;
  if (saved?.status === 'failing' && !input.secretAccessKey) {
    return data({ ok: false, wrote: false, deleted: false, error: 'AccessDenied: the access key is not allowed to write to this bucket' });
  }
  return data({ ok: true, wrote: true, deleted: true, error: null });
}

function handleExports(request: SampleRequest): unknown {
  if (request.segments[1] === 'test' && request.segments.length === 2 && request.method === 'POST') return testExport(request.body);
  return routeResource(request, exportRoutes);
}

// Collector domains

/** A pending domain turns active on the first refresh, so the whole flow can be seen. */
function refreshedDomain(current: PanelDomainDto, now: string): PanelDomainDto {
  if (current.status !== 'pending') return { ...current, lastCheckedAt: now };
  return { ...current, status: 'active', sslStatus: 'active', lastCheckedAt: now, scriptUrl: `https://${current.hostname}/s.js`, snippet: domainSnippet(current.hostname) };
}

function handleDomains({ method, segments, body }: SampleRequest): unknown {
  const [, projectId, third, fourth] = segments;
  if (third !== 'domains' || !projectId) return UNHANDLED;
  if (segments.length === 3) {
    if (method === 'GET') return list(domains.filter((d) => d.projectId === projectId));
    if (method !== 'POST') return UNHANDLED;
    const input = bodyAs<CreatePanelDomainInput>(body);
    const created = pendingDomain(sampleId('pndm'), projectId, (input.hostname ?? 'stats.example.com').trim().toLowerCase(), 0);
    domains.push(created);
    return data(created);
  }
  if (!fourth) return UNHANDLED;
  const index = domains.findIndex((d) => d.id === fourth && d.projectId === projectId);
  if (index < 0) throw notFound('domain');
  if (segments.length === 5 && segments[4] === 'refresh' && method === 'POST') {
    const updated = refreshedDomain(domains[index]!, new Date().toISOString());
    domains[index] = updated;
    return data(updated);
  }
  if (segments.length === 4 && method === 'DELETE') return removeAt(domains, index);
  return UNHANDLED;
}

/** Each area's handler, by the first path segment. */
const AREA_HANDLERS: Record<string, SampleAreaHandler> = {
  alerts: (request) => routeResource(request, alertRoutes),
  subscriptions: (request) => routeResource(request, subscriptionRoutes),
  exports: handleExports,
  projects: handleDomains,
};

export const handleMonitor: SampleAreaHandler = (request) => {
  const area = request.segments[0];
  const handler = area !== undefined && Object.hasOwn(AREA_HANDLERS, area) ? AREA_HANDLERS[area] : undefined;
  return handler ? handler(request) : UNHANDLED;
};
