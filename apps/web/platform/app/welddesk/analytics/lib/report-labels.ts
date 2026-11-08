/**
 * Display helpers for WeldDesk reports: durations, and the labels desk-api
 * sends as keys (a state, priority, channel or SLA target) or empty (no
 * type, team or assignee).
 */

import type { TranslationsType } from '@/lib/i18n/types';

type ReportsT = TranslationsType['helpdesk']['reports'];

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A duration in seconds as "45s", "12m", "2h 5m" or "3d 4h"; an em dash when there is none. */
export function formatDuration(seconds: number | null | undefined, t: ReportsT): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < MINUTE) return t.duration.seconds.replace('{n}', String(s));
  if (s < HOUR) return t.duration.minutes.replace('{n}', String(Math.round(s / MINUTE)));
  if (s < DAY) {
    return t.duration.hoursMinutes
      .replace('{h}', String(Math.floor(s / HOUR)))
      .replace('{m}', String(Math.floor((s % HOUR) / MINUTE)));
  }
  return t.duration.daysHours
    .replace('{d}', String(Math.floor(s / DAY)))
    .replace('{h}', String(Math.floor((s % DAY) / HOUR)));
}

export function formatPercent(value: number | null | undefined): string {
  return value == null ? '—' : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

/** The dimension a builder metric groups on, for its labels. */
export type ReportDimension = 'state' | 'priority' | 'channel' | 'type' | 'team' | 'person' | 'customer' | 'sla_metric';

const METRIC_DIMENSION: Record<string, ReportDimension> = {
  tickets_by_status: 'state',
  tickets_by_priority: 'priority',
  response_by_priority: 'priority',
  resolution_by_priority: 'priority',
  tickets_by_channel: 'channel',
  conversations_by_channel: 'channel',
  tickets_by_type: 'type',
  tickets_by_team: 'team',
  tickets_per_agent: 'person',
  resolved_per_agent: 'person',
  agent_performance: 'person',
  replies_per_agent: 'person',
  agent_response_time: 'person',
  satisfaction_by_agent: 'person',
  top_customers: 'customer',
  customers_by_tickets: 'customer',
  sla_compliance_by_metric: 'sla_metric',
};

export function reportDimensionOf(metric: string): ReportDimension | undefined {
  return METRIC_DIMENSION[metric];
}

function fromMap(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}

/** What a data point's label reads as for this dimension. */
export function reportLabel(dimension: ReportDimension | undefined, label: string, t: ReportsT): string {
  switch (dimension) {
    case 'state':
      return fromMap(t.labels.state, label);
    case 'priority':
      return fromMap(t.labels.priority, label || 'none');
    case 'channel':
      return fromMap(t.labels.channel, label);
    case 'sla_metric':
      return fromMap(t.labels.slaMetric, label);
    case 'type':
      return label || t.labels.noType;
    case 'team':
      return label || t.labels.noTeam;
    case 'person':
      return label || t.labels.unassigned;
    case 'customer':
      return label || t.labels.unknownCustomer;
    default:
      return label || t.labels.none;
  }
}
