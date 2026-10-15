import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_GRAPHQL_URL,
  CloudflareAnalytics,
  isFailureStatus,
  parseGraphqlResponse,
  summarizeCloudflare,
  summarizeDomain,
  zoneCandidates,
  type FetchLike,
} from './cloudflare';
import type { CfGroupRow } from './types';

function group(dimensions: Partial<CfGroupRow> & { count: number }) {
  const { count, ...rest } = dimensions;
  return {
    count,
    dimensions: { date: '2026-10-10', sendingDomain: 'acme.test', status: 'delivered', isSpam: 0, isLastEvent: 1, eventType: 'newEmail', ...rest },
  };
}

function body(groups: ReturnType<typeof group>[]) {
  return { data: { viewer: { zones: [{ emailSendingAdaptiveGroups: groups }] } }, errors: null };
}

describe('parseGraphqlResponse', () => {
  it('flattens the zone groups into rows', () => {
    const rows = parseGraphqlResponse(body([group({ count: 5 }), group({ count: 2, status: 'deliveryFailed', sendingDomain: 'ACME.test' })]));
    expect(rows).toEqual([
      { count: 5, date: '2026-10-10', sendingDomain: 'acme.test', status: 'delivered', isSpam: 0, isLastEvent: 1, eventType: 'newEmail' },
      { count: 2, date: '2026-10-10', sendingDomain: 'acme.test', status: 'deliveryFailed', isSpam: 0, isLastEvent: 1, eventType: 'newEmail' },
    ]);
  });

  it("throws with Cloudflare's messages on GraphQL errors", () => {
    expect(() => parseGraphqlResponse({ data: null, errors: [{ message: 'not authorized for that zone' }] })).toThrow(
      'GraphQL: not authorized for that zone',
    );
    expect(() => parseGraphqlResponse('nope')).toThrow('Unexpected GraphQL response shape');
  });
});

describe('zoneCandidates', () => {
  it('walks up to the registrable domain', () => {
    expect(zoneCandidates('acme.eu.weldmail.com')).toEqual(['acme.eu.weldmail.com', 'eu.weldmail.com', 'weldmail.com']);
    expect(zoneCandidates('Example.com')).toEqual(['example.com']);
    expect(zoneCandidates('localhost')).toEqual([]);
  });
});

describe('summarizeDomain', () => {
  it('counts emails by their last event, failures and spam', () => {
    const rows: CfGroupRow[] = [
      { count: 90, date: '2026-10-10', sendingDomain: 'acme.test', status: 'delivered', isSpam: 0, isLastEvent: 1, eventType: 'newEmail' },
      { count: 8, date: '2026-10-10', sendingDomain: 'acme.test', status: 'deliveryFailed', isSpam: 0, isLastEvent: 1, eventType: 'newEmail' },
      { count: 2, date: '2026-10-11', sendingDomain: 'acme.test', status: 'delivered', isSpam: 1, isLastEvent: 1, eventType: 'reply' },
      { count: 100, date: '2026-10-10', sendingDomain: 'acme.test', status: 'queued', isSpam: 0, isLastEvent: 0, eventType: 'newEmail' },
    ];
    expect(summarizeDomain('acme.test', 'zone1', rows)).toEqual({
      domain: 'acme.test',
      zoneId: 'zone1',
      events: 200,
      emails: 100,
      byStatus: { delivered: 92, deliveryFailed: 8 },
      byEventType: { newEmail: 98, reply: 2 },
      failed: 8,
      spam: 2,
    });
  });

  it('falls back to all events when none is marked last', () => {
    const rows: CfGroupRow[] = [
      { count: 3, date: '2026-10-10', sendingDomain: 'acme.test', status: 'delivered', isSpam: 0, isLastEvent: 0, eventType: 'newEmail' },
      { count: 1, date: '2026-10-10', sendingDomain: 'acme.test', status: 'rejected', isSpam: 0, isLastEvent: 0, eventType: 'newEmail' },
    ];
    expect(summarizeDomain('acme.test', 'zone1', rows)).toMatchObject({ emails: 4, failed: 1 });
  });

  it('classifies failure statuses', () => {
    expect(['deliveryFailed', 'bounced', 'rejected', 'dropped', 'error'].every(isFailureStatus)).toBe(true);
    expect(['delivered', 'queued', 'deferred'].some(isFailureStatus)).toBe(false);
  });
});

describe('summarizeCloudflare', () => {
  it('totals the domains and computes shares', () => {
    const summary = summarizeCloudflare(
      [
        { domain: 'a.test', zoneId: 'z', events: 10, emails: 10, byStatus: {}, byEventType: {}, failed: 1, spam: 0 },
        { domain: 'b.test', zoneId: 'z', events: 30, emails: 30, byStatus: {}, byEventType: {}, failed: 3, spam: 3 },
      ],
      31,
      ['x'],
    );
    expect(summary).toMatchObject({ emails: 40, failed: 4, spam: 3, bounceShare: 0.1, spamShare: 0.075, problems: ['x'] });
    expect(summary.domains[0].domain).toBe('b.test');
    expect(summarizeCloudflare([], 31, []).bounceShare).toBeNull();
  });
});

describe('CloudflareAnalytics', () => {
  const now = new Date('2026-10-13T12:00:00Z');

  it('resolves zones, queries one sending domain at a time and reports what it could not read', async () => {
    const zoneLookups: string[] = [];
    const requests: { url: string; variables: Record<string, string>; auth: string }[] = [];
    const findZone = async (_token: string, name: string) => {
      zoneLookups.push(name);
      return name === 'weldmail.com' ? 'zone-weldmail' : null;
    };
    const fetchImpl: FetchLike = async (url, init) => {
      const parsed = JSON.parse(init.body) as { variables: Record<string, string> };
      requests.push({ url, variables: parsed.variables, auth: init.headers.Authorization });
      const domain = parsed.variables.domain;
      const groups =
        domain === 'acme.test'
          ? [group({ count: 95, sendingDomain: domain }), group({ count: 5, sendingDomain: domain, status: 'deliveryFailed' })]
          : [group({ count: 40, sendingDomain: domain }), group({ count: 60, sendingDomain: domain, status: 'deliveryFailed', isSpam: 1 })];
      return { ok: true, status: 200, json: async () => body(groups) };
    };

    const analytics = new CloudflareAnalytics('token-123', 7, now, findZone, fetchImpl);
    const summary = await analytics.summarize([
      { domain: 'acme.test', zoneId: 'zone-acme' },
      { domain: 'acme-ws.weldmail.com', zoneId: null },
      { domain: 'gmail.com', zoneId: null },
    ]);

    expect(zoneLookups).toEqual(['acme-ws.weldmail.com', 'weldmail.com', 'gmail.com']);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({
      url: CLOUDFLARE_GRAPHQL_URL,
      variables: { zoneTag: 'zone-acme', start: '2026-10-07', end: '2026-10-13', domain: 'acme.test' },
      auth: 'Bearer token-123',
    });
    expect(requests[1].variables).toMatchObject({ zoneTag: 'zone-weldmail', domain: 'acme-ws.weldmail.com' });
    expect(summary).toMatchObject({ days: 7, emails: 200, failed: 65, spam: 60 });
    expect(summary.bounceShare).toBeCloseTo(0.325);
    expect(summary.problems).toEqual(['gmail.com: no zone in this Cloudflare account']);
  });

  it('records a failed query as a problem instead of throwing', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 403, json: async () => ({}) });
    const analytics = new CloudflareAnalytics('t', 31, now, async () => 'zone', fetchImpl);
    const summary = await analytics.summarize([{ domain: 'acme.test', zoneId: null }]);
    expect(summary.problems).toEqual(['acme.test: GraphQL HTTP 403']);
    expect(summary.emails).toBe(0);
  });
});
