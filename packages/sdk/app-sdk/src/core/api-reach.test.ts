import { describe, expect, it, vi } from 'vitest';
import { WeldApi } from './api';
import type { WeldAppBridge } from './bridge';

interface SentRequest {
  path: string;
  method: string;
  body: unknown;
}

/** A connected protocol 2 bridge whose host answers every request with `respond(request)`. */
function apiWith(respond: (request: SentRequest) => { status: number; body?: unknown }) {
  const sent: SentRequest[] = [];
  const hostFetch = vi.fn(async (path: string, init: RequestInit = {}) => {
    const request: SentRequest = {
      path,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    sent.push(request);
    const { status, body } = respond(request);
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });
  });
  const bridge = {
    isLocalDev: false,
    hostProxiesRequests: true,
    connect: async () => undefined,
    hostFetch,
  } as unknown as WeldAppBridge;
  return { api: new WeldApi(bridge), sent };
}

const ok = (data: unknown) => ({ status: 200, body: { data } });

describe('WeldApi.reach', () => {
  it('calls every endpoint under /v1/reach with the right method and body', async () => {
    const { api, sent } = apiWith((request) => (request.method === 'DELETE' ? { status: 204 } : ok({})));

    await api.reach.access();
    await api.reach.overview();
    await api.reach.campaigns.list({ status: 'active', limit: 10 });
    await api.reach.campaigns.get('rcmp_1');
    await api.reach.campaigns.create({ name: 'Q4' });
    await api.reach.campaigns.update('rcmp_1', { dailyLimit: 50 });
    await api.reach.campaigns.remove('rcmp_1');
    await api.reach.campaigns.setSteps('rcmp_1', [
      { delayDays: 0, delayHours: 0, subject: 'Hi', body: 'Hello', replyInThread: false },
    ]);
    await api.reach.campaigns.setMailboxes('rcmp_1', ['rmbx_1']);
    await api.reach.campaigns.enroll('rcmp_1', { listId: 'rpl_1' });
    await api.reach.campaigns.enrollments('rcmp_1', { status: 'replied' });
    await api.reach.campaigns.removeEnrollment('rcmp_1', 'renr_1');
    await api.reach.campaigns.launch('rcmp_1');
    await api.reach.campaigns.pause('rcmp_1');
    await api.reach.campaigns.resume('rcmp_1');
    await api.reach.campaigns.stats('rcmp_1');
    await api.reach.prospects.list({ listId: 'rpl_1', validation: 'valid' });
    await api.reach.prospects.create({ email: 'jane@example.com', listId: 'rpl_1' });
    await api.reach.prospects.import({ rows: [{ email: 'jane@example.com' }], listName: 'Fair' });
    await api.reach.prospects.update('rpro_1', { title: 'COO' });
    await api.reach.prospects.remove('rpro_1');
    await api.reach.lists.create({ name: 'Fair' });
    await api.reach.lists.addMembers('rpl_1', ['rpro_1']);
    await api.reach.lists.removeMembers('rpl_1', ['rpro_1']);
    await api.reach.suppressions.add(['example.com']);
    await api.reach.suppressions.remove('rsup_1');
    await api.reach.mailboxes.list({ status: 'warming' });
    await api.reach.domains.get('rdom_1');

    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/reach/access',
      'GET /v1/reach/overview',
      'GET /v1/reach/campaigns?status=active&limit=10',
      'GET /v1/reach/campaigns/rcmp_1',
      'POST /v1/reach/campaigns',
      'PATCH /v1/reach/campaigns/rcmp_1',
      'DELETE /v1/reach/campaigns/rcmp_1',
      'PUT /v1/reach/campaigns/rcmp_1/steps',
      'PUT /v1/reach/campaigns/rcmp_1/mailboxes',
      'POST /v1/reach/campaigns/rcmp_1/prospects',
      'GET /v1/reach/campaigns/rcmp_1/enrollments?status=replied',
      'DELETE /v1/reach/campaigns/rcmp_1/enrollments/renr_1',
      'POST /v1/reach/campaigns/rcmp_1/launch',
      'POST /v1/reach/campaigns/rcmp_1/pause',
      'POST /v1/reach/campaigns/rcmp_1/resume',
      'GET /v1/reach/campaigns/rcmp_1/stats',
      'GET /v1/reach/prospects?listId=rpl_1&validation=valid',
      'POST /v1/reach/prospects',
      'POST /v1/reach/prospects/import',
      'PATCH /v1/reach/prospects/rpro_1',
      'DELETE /v1/reach/prospects/rpro_1',
      'POST /v1/reach/lists',
      'POST /v1/reach/lists/rpl_1/members',
      'POST /v1/reach/lists/rpl_1/members/remove',
      'POST /v1/reach/suppressions',
      'DELETE /v1/reach/suppressions/rsup_1',
      'GET /v1/reach/mailboxes?status=warming',
      'GET /v1/reach/domains/rdom_1',
    ]);

    const bodyOf = (path: string) => sent.find((r) => r.path === path)?.body;
    expect(bodyOf('/v1/reach/campaigns/rcmp_1/steps')).toEqual({
      steps: [{ delayDays: 0, delayHours: 0, subject: 'Hi', body: 'Hello', replyInThread: false }],
    });
    expect(bodyOf('/v1/reach/campaigns/rcmp_1/mailboxes')).toEqual({ mailboxIds: ['rmbx_1'] });
    expect(bodyOf('/v1/reach/lists/rpl_1/members/remove')).toEqual({ prospectIds: ['rpro_1'] });
    expect(bodyOf('/v1/reach/suppressions')).toEqual({ values: ['example.com'] });
  });

  it('encodes the thread key and unwraps the sent reply', async () => {
    const threadKey = 'abc123.mgk2x1@acme-outreach.com';
    const message = { id: 'rmsg_1', direction: 'out', threadKey };
    const { api, sent } = apiWith((request) => (request.method === 'POST' ? { status: 201, body: { data: message } } : ok({})));

    await api.reach.threads.get(threadKey);
    await expect(api.reach.threads.reply(threadKey, 'Thursday works.')).resolves.toEqual(message);

    expect(sent[0]?.path).toBe('/v1/reach/threads/abc123.mgk2x1%40acme-outreach.com');
    expect(sent[1]).toEqual({
      path: '/v1/reach/threads/abc123.mgk2x1%40acme-outreach.com/reply',
      method: 'POST',
      body: { body: 'Thursday works.' },
    });
  });

  it('returns list envelopes whole, including the inbox unread count', async () => {
    const envelope = {
      data: [],
      pagination: { totalCount: 0, hasMore: false, cursor: null },
      meta: { unreadCount: 3 },
    };
    const { api, sent } = apiWith(() => ({ status: 200, body: envelope }));

    await expect(api.reach.threads.list({ state: 'unread', label: 'interested' })).resolves.toEqual(envelope);
    expect(sent[0]?.path).toBe('/v1/reach/threads?state=unread&label=interested');
  });

  it('surfaces the on-request gate as a WeldApiError', async () => {
    const { api } = apiWith(() => ({
      status: 403,
      body: {
        error: {
          code: 'APP_ACCESS_REQUIRED',
          message: 'This workspace has no approved access to weldreach.',
          details: { appCode: 'weldreach', status: 'requested' },
        },
      },
    }));

    await expect(api.reach.campaigns.list()).rejects.toMatchObject({
      status: 403,
      code: 'APP_ACCESS_REQUIRED',
      details: { appCode: 'weldreach', status: 'requested' },
    });
  });
});
