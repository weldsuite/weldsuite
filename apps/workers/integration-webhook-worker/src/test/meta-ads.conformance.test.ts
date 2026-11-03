/**
 * Meta's WeldAds webhook end to end, through the worker's own `fetch`: the
 * subscription handshake (`GET /webhooks/meta/ads`) and the change deliveries
 * (`POST`), signed with the app secret, each handed to connect-api's
 * `/api/integrations/ad-events` over `CONNECT_INTERNAL` for the workspace the
 * `adsconn:<account>` KV entry names. Run on both backends by the
 * `integrations: meta ads` conformance suite.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createWebhookTestApp } from './harness';

const SECRET = 'meta-app-secret';

function memoryKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  };
}

function connectStub() {
  return {
    fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { platformAccountId?: string };
      const status = body.platformAccountId === 'act_down' ? 502 : 200;
      return new Response(JSON.stringify({ data: { ok: status === 200 } }), { status });
    }),
  };
}

const KV = {
  'adsconn:act_1': JSON.stringify({ workspaceId: 'ws_ads', connectionId: 'adc_1', clerkOrgId: 'org_ads' }),
  'adsconn:act_down': JSON.stringify({ workspaceId: 'ws_ads', connectionId: 'adc_2', clerkOrgId: 'org_ads' }),
  'adsconn:act_bad': '{not json',
};

function app(env: Record<string, unknown> = {}) {
  return createWebhookTestApp({ env: { WORKSPACE_CACHE: memoryKv(KV), FACEBOOK_APP_SECRET: SECRET, ...env } });
}

function deliver(target: ReturnType<typeof app>, payload: unknown, secret = SECRET) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  return target.request('/webhooks/meta/ads', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${signature}` },
  });
}

describe('GET /webhooks/meta/ads', () => {
  it('answers the challenge for the verify token, and refuses anything else', async () => {
    const ok = await app().request('/webhooks/meta/ads?hub.mode=subscribe&hub.verify_token=weldsuite-meta-ads&hub.challenge=12345');
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('12345');

    const custom = await app({ FACEBOOK_WEBHOOK_VERIFY_TOKEN: 'mine' }).request(
      '/webhooks/meta/ads?hub.mode=subscribe&hub.verify_token=mine&hub.challenge=c',
    );
    expect(await custom.text()).toBe('c');

    for (const query of [
      'hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1',
      'hub.mode=unsubscribe&hub.verify_token=weldsuite-meta-ads&hub.challenge=1',
      'hub.mode=subscribe&hub.verify_token=weldsuite-meta-ads',
    ]) {
      const refused = await app().request(`/webhooks/meta/ads?${query}`);
      expect(refused.status).toBe(403);
      expect(await refused.text()).toBe('Forbidden');
    }
  });
});

describe('POST /webhooks/meta/ads', () => {
  it('needs the connect binding, a valid signature and JSON', async () => {
    const unbound = await deliver(app(), { entry: [] });
    expect(unbound.status).toBe(503);
    expect(await unbound.json()).toEqual({ error: 'Ad ingest unavailable' });

    const connect = connectStub();
    const forged = await deliver(app({ CONNECT_INTERNAL: connect }), { entry: [] }, 'wrong');
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ error: 'Invalid signature' });

    const garbled = await deliver(app({ CONNECT_INTERNAL: connect }), '{oops');
    expect(garbled.status).toBe(400);
    expect(await garbled.json()).toEqual({ error: 'Invalid JSON' });
    expect(connect.fetch).not.toHaveBeenCalled();
  });

  it('hands each change of a known account to connect-api, and reports the rest', async () => {
    const connect = connectStub();
    const res = await deliver(app({ CONNECT_INTERNAL: connect }), {
      object: 'ad_account',
      entry: [
        {
          id: 'act_1',
          changes: [
            { field: 'campaigns', value: { campaign_id: 42, status: 'PAUSED' } },
            { field: 'ads', value: { ad_id: '9' } },
            { field: 'billing' },
          ],
        },
        { id: 'act_unknown', changes: [{ field: 'adsets', value: { adset_id: '7' } }] },
        { id: 'act_bad', changes: [{ field: 'ads', value: {} }] },
        { id: 'act_down', changes: [{ field: 'campaign', value: { id: 'c1' } }] },
        { changes: [{ field: 'ads' }] },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        processed: 6,
        responses: [
          { platformAccountId: 'act_1', status: 200 },
          { platformAccountId: 'act_1', status: 200 },
          { platformAccountId: 'act_1', status: 200 },
          { skipped: true, platformAccountId: 'act_unknown' },
          { error: 'Corrupt ad account mapping', platformAccountId: 'act_bad' },
          { platformAccountId: 'act_down', status: 502 },
        ],
      },
    });
    expect(connect.fetch).toHaveBeenCalledTimes(4);
    const [url, init] = connect.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://internal/api/integrations/ad-events');
    expect(JSON.parse(String(init.body))).toEqual({ platformAccountId: 'act_1', platformCampaignId: '42', objectType: 'campaign' });

    // Without an app secret a delivery is taken unsigned.
    const unsigned = await app({ CONNECT_INTERNAL: connect, FACEBOOK_APP_SECRET: undefined }).request('/webhooks/meta/ads', {
      method: 'POST',
      body: JSON.stringify({ entry: [] }),
    });
    expect(unsigned.status).toBe(200);
    expect(await unsigned.json()).toEqual({ data: { processed: 0, responses: [] } });
  });
});
