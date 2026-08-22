import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl, exchangeCodeForTokens, exchangeForLongLivedToken } from './oauth';
import { MetaMarketingClient } from './client';
import { parseMetaAdsWebhook, verifyMetaWebhookSignature } from './webhooks';
import { hashCampaignPayload } from './hash';

describe('@weldsuite/meta-ads oauth', () => {
  it('builds authorize url with scopes', () => {
    const url = buildAuthorizeUrl({
      appId: 'app123',
      redirectUri: 'https://app.example/weldads/connect/callback',
      state: 'state-abc',
    });
    expect(url).toContain('facebook.com');
    expect(url).toContain('client_id=app123');
    expect(url).toContain('state=state-abc');
    expect(url).toContain('ads_read');
    expect(url).toContain('ads_management');
  });

  it('exchanges code for tokens', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ access_token: 'short', token_type: 'bearer', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const tokens = await exchangeCodeForTokens(
      { appId: 'app', appSecret: 'secret', redirectUri: 'https://cb', code: 'code1' },
      fetchImpl,
    );
    expect(tokens.accessToken).toBe('short');
    expect(tokens.expiresAt).toBeTruthy();
  });

  it('exchanges for long-lived token', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ access_token: 'long', token_type: 'bearer', expires_in: 5184000 }), {
        status: 200,
      });
    const tokens = await exchangeForLongLivedToken(
      { appId: 'app', appSecret: 'secret', shortLivedToken: 'short' },
      fetchImpl,
    );
    expect(tokens.accessToken).toBe('long');
  });
});

describe('@weldsuite/meta-ads client', () => {
  it('lists ad accounts', async () => {
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain('/me/adaccounts');
      return new Response(
        JSON.stringify({
          data: [{ id: 'act_1', name: 'Test', account_status: 1, currency: 'EUR', timezone_name: 'Europe/Amsterdam' }],
        }),
        { status: 200 },
      );
    };
    const client = new MetaMarketingClient({ accessToken: 'tok' }, fetchImpl);
    const accounts = await client.listAdAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.platformAccountId).toBe('act_1');
  });

  it('lists campaigns with insights', async () => {
    let call = 0;
    const fetchImpl = async (input: RequestInfo | URL) => {
      call += 1;
      const url = String(input);
      if (url.includes('/campaigns')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 'c1', name: 'Campaign', status: 'ACTIVE', objective: 'OUTCOME_TRAFFIC', daily_budget: '1000' }],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          data: [{ campaign_id: 'c1', spend: '12.34', impressions: '100', clicks: '5', ctr: '5', cpc: '2.46', reach: '80' }],
        }),
        { status: 200 },
      );
    };
    const client = new MetaMarketingClient({ accessToken: 'tok' }, fetchImpl);
    const campaigns = await client.listCampaignsWithInsights('act_1');
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]?.metrics?.spend).toBe('12.34');
    expect(call).toBeGreaterThanOrEqual(2);
  });
});

describe('@weldsuite/meta-ads webhooks', () => {
  it('verifies signature', async () => {
    const body = '{"entry":[]}';
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(await verifyMetaWebhookSignature(body, `sha256=${hex}`, 'secret')).toBe(true);
  });

  it('parses campaign change events', () => {
    const events = parseMetaAdsWebhook({
      entry: [
        {
          id: 'act_1',
          changes: [{ field: 'campaigns', value: { campaign_id: '123', status: 'ACTIVE' } }],
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.objectType).toBe('campaign');
    expect(events[0]?.platformAccountId).toBe('act_1');
  });
});

describe('@weldsuite/meta-ads hash', () => {
  it('hashes campaign payload consistently', () => {
    const a = hashCampaignPayload({ name: 'A', status: 'ACTIVE', metrics: { spend: '1' } });
    const b = hashCampaignPayload({ name: 'A', status: 'ACTIVE', metrics: { spend: '1' } });
    const c = hashCampaignPayload({ name: 'B', status: 'ACTIVE', metrics: { spend: '1' } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
