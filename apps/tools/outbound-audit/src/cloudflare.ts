/**
 * Cloudflare Email Sending analytics for a workspace's sending domains
 * (`--cloudflare`). Zone ids come from `mail_domains.cloudflare_zone_id` or
 * `findZoneIdByName` (@weldsuite/cloudflare-zones, official SDK). The
 * analytics themselves are GraphQL only: the `cloudflare` SDK (v7) has no
 * GraphQL resource, so this one query goes to the GraphQL endpoint with plain
 * `fetch`.
 *
 * Dataset: `emailSendingAdaptiveGroups` (zone level, 31 days retention),
 * https://developers.cloudflare.com/email-service/observability/metrics-analytics/
 * One query per sending domain (filtered on `sendingDomain`), so the shared
 * weldmail.com zone only returns the workspace's own subdomain.
 */

import { z } from 'zod';
import { findZoneIdByName } from '@weldsuite/cloudflare-zones';
import { utcDay } from './recipients';
import type { CfDomainSummary, CfGroupRow, CloudflareSummary } from './types';

export const CLOUDFLARE_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
/** Cloudflare keeps Email Sending analytics for 31 days. */
export const CLOUDFLARE_MAX_DAYS = 31;
const GROUP_LIMIT = 10_000;

const QUERY = `query OutboundAuditEmailSending($zoneTag: string!, $start: Date!, $end: Date!, $domain: string!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      emailSendingAdaptiveGroups(
        filter: { date_geq: $start, date_leq: $end, sendingDomain: $domain }
        limit: ${GROUP_LIMIT}
        orderBy: [date_ASC]
      ) {
        count
        dimensions { date sendingDomain status isSpam isLastEvent eventType }
      }
    }
  }
}`;

const groupSchema = z.object({
  count: z.number(),
  dimensions: z.object({
    date: z.string(),
    sendingDomain: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    isSpam: z.number().nullable().optional(),
    isLastEvent: z.number().nullable().optional(),
    eventType: z.string().nullable().optional(),
  }),
});

const responseSchema = z.object({
  data: z
    .object({
      viewer: z.object({
        zones: z.array(z.object({ emailSendingAdaptiveGroups: z.array(groupSchema).nullable().optional() })),
      }),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() })).nullable().optional(),
});

/** Rows from a GraphQL response body; throws with Cloudflare's messages on errors. */
export function parseGraphqlResponse(body: unknown): CfGroupRow[] {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new Error('Unexpected GraphQL response shape');
  const { data, errors } = parsed.data;
  if (errors && errors.length > 0) {
    throw new Error(`GraphQL: ${errors.map((e) => e.message).join('; ').slice(0, 300)}`);
  }
  const rows: CfGroupRow[] = [];
  for (const zone of data?.viewer.zones ?? []) {
    for (const group of zone.emailSendingAdaptiveGroups ?? []) {
      const d = group.dimensions;
      rows.push({
        count: group.count,
        date: d.date,
        sendingDomain: (d.sendingDomain ?? '').toLowerCase(),
        status: d.status ?? 'unknown',
        isSpam: d.isSpam ?? 0,
        isLastEvent: d.isLastEvent ?? 0,
        eventType: d.eventType ?? 'unknown',
      });
    }
  }
  return rows;
}

/** `a.b.example.com` → itself, `b.example.com`, `example.com`: where its zone may be. */
export function zoneCandidates(domain: string): string[] {
  const labels = domain.toLowerCase().split('.').filter(Boolean);
  const candidates: string[] = [];
  for (let i = 0; i + 2 <= labels.length; i++) candidates.push(labels.slice(i).join('.'));
  return candidates;
}

export function isFailureStatus(status: string): boolean {
  return /fail|bounce|reject|drop|error/i.test(status);
}

/** One sending domain's rows → counts by status and event type, emails counted by their last event. */
export function summarizeDomain(domain: string, zoneId: string, rows: CfGroupRow[]): CfDomainSummary {
  const hasLast = rows.some((r) => r.isLastEvent === 1);
  const counted = hasLast ? rows.filter((r) => r.isLastEvent === 1) : rows;
  const summary: CfDomainSummary = {
    domain,
    zoneId,
    events: rows.reduce((sum, r) => sum + r.count, 0),
    emails: 0,
    byStatus: {},
    byEventType: {},
    failed: 0,
    spam: 0,
  };
  for (const row of counted) {
    summary.emails += row.count;
    summary.byStatus[row.status] = (summary.byStatus[row.status] ?? 0) + row.count;
    summary.byEventType[row.eventType] = (summary.byEventType[row.eventType] ?? 0) + row.count;
    if (isFailureStatus(row.status)) summary.failed += row.count;
    if (row.isSpam === 1) summary.spam += row.count;
  }
  return summary;
}

export function summarizeCloudflare(domains: CfDomainSummary[], days: number, problems: string[]): CloudflareSummary {
  const emails = domains.reduce((sum, d) => sum + d.emails, 0);
  const failed = domains.reduce((sum, d) => sum + d.failed, 0);
  const spam = domains.reduce((sum, d) => sum + d.spam, 0);
  return {
    days,
    domains: [...domains].sort((a, b) => b.emails - a.emails || a.domain.localeCompare(b.domain)),
    emails,
    failed,
    spam,
    bounceShare: emails > 0 ? failed / emails : null,
    spamShare: emails > 0 ? spam / emails : null,
    problems,
  };
}

export type FindZone = (apiToken: string, domain: string) => Promise<string | null>;
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface SendingDomain {
  domain: string;
  /** From `mail_domains.cloudflare_zone_id`, when the workspace onboarded it. */
  zoneId: string | null;
}

/**
 * Looks up zones (cached across workspaces, the weldmail.com zone is shared)
 * and runs the analytics query per sending domain.
 */
export class CloudflareAnalytics {
  private readonly zoneCache = new Map<string, Promise<string | null>>();

  constructor(
    private readonly apiToken: string,
    private readonly days: number,
    private readonly now: Date,
    private readonly findZone: FindZone = findZoneIdByName,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get windowDays(): number {
    return this.days;
  }

  private cachedZone(name: string): Promise<string | null> {
    let pending = this.zoneCache.get(name);
    if (!pending) {
      pending = this.findZone(this.apiToken, name);
      this.zoneCache.set(name, pending);
    }
    return pending;
  }

  async zoneFor(domain: SendingDomain): Promise<string | null> {
    if (domain.zoneId) return domain.zoneId;
    for (const candidate of zoneCandidates(domain.domain)) {
      const zoneId = await this.cachedZone(candidate);
      if (zoneId) return zoneId;
    }
    return null;
  }

  async groups(zoneId: string, domain: string): Promise<CfGroupRow[]> {
    const end = utcDay(this.now);
    const start = utcDay(new Date(this.now.getTime() - (this.days - 1) * 86_400_000));
    const response = await this.fetchImpl(CLOUDFLARE_GRAPHQL_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { zoneTag: zoneId, start, end, domain } }),
    });
    if (!response.ok) throw new Error(`GraphQL HTTP ${response.status}`);
    return parseGraphqlResponse(await response.json());
  }

  async summarize(domains: SendingDomain[]): Promise<CloudflareSummary> {
    const problems: string[] = [];
    const summaries: CfDomainSummary[] = [];
    for (const domain of domains) {
      try {
        const zoneId = await this.zoneFor(domain);
        if (!zoneId) {
          problems.push(`${domain.domain}: no zone in this Cloudflare account`);
          continue;
        }
        const rows = await this.groups(zoneId, domain.domain);
        if (rows.length >= GROUP_LIMIT) problems.push(`${domain.domain}: hit the ${GROUP_LIMIT} group limit, counts are incomplete`);
        const own = rows.filter((r) => r.sendingDomain === '' || r.sendingDomain === domain.domain);
        if (own.length > 0) summaries.push(summarizeDomain(domain.domain, zoneId, own));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        problems.push(`${domain.domain}: ${message.slice(0, 200)}`);
      }
    }
    return summarizeCloudflare(summaries, this.days, problems);
  }
}
