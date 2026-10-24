import { describe, it, expect } from 'vitest';
import { hmacSha256Hex, STRIPE_CONNECT_VERIFIED_HEADER } from '@weldsuite/connectors';
import { handleStripeConnectWebhook, type StripeConnectEnv } from './stripe-connect';

const SECRET = 'whsec_platform';

async function signed(body: string): Promise<string> {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${await hmacSha256Hex(SECRET, `${t}.${body}`)}`;
}

function env(kv: Record<string, string>, forwarded: Array<{ url: string; headers: Headers; body: string }>, status = 200): StripeConnectEnv {
  return {
    STRIPE_CONNECT_WEBHOOK_SECRET: SECRET,
    WORKSPACE_CACHE: { get: async (key: string) => kv[key] ?? null } as unknown as KVNamespace,
    CONNECT_INTERNAL: {
      fetch: async (url: string, init: RequestInit) => {
        forwarded.push({ url, headers: new Headers(init.headers), body: String(init.body) });
        return new Response('{}', { status });
      },
    } as unknown as Fetcher,
  };
}

describe('Stripe Connect webhook ingress', () => {
  it('rejects a bad signature', async () => {
    const res = await handleStripeConnectWebhook(env({}, []), '{}', 't=1,v1=00');
    expect(res.status).toBe(401);
  });

  it('forwards a connected account event to every connection using that account, marked verified', async () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', account: 'acct_1', data: { object: { id: 'in_1' } } });
    const forwarded: Array<{ url: string; headers: Headers; body: string }> = [];
    const kv = {
      'stripeacct:acct_1': JSON.stringify([
        { workspaceId: 'ws_a', connectionId: 'conn_a' },
        { workspaceId: 'ws_b', connectionId: 'conn_b' },
      ]),
    };
    const res = await handleStripeConnectWebhook(env(kv, forwarded), body, await signed(body));
    expect(res.status).toBe(200);
    expect(forwarded.map((call) => call.url)).toEqual([
      'https://internal/api/integrations/connections/conn_a/connector-event',
      'https://internal/api/integrations/connections/conn_b/connector-event',
    ]);
    expect(forwarded[0]?.headers.get(STRIPE_CONNECT_VERIFIED_HEADER)).toBe('verified');
    expect(forwarded[0]?.headers.get('X-Internal-Workspace-Id')).toBe('ws_a');
    expect(forwarded[0]?.body).toBe(body);
  });

  it('ignores platform events and accounts nobody connected', async () => {
    const platform = JSON.stringify({ id: 'evt_2', type: 'invoice.paid' });
    expect((await handleStripeConnectWebhook(env({}, []), platform, await signed(platform))).status).toBe(200);
    const unknown = JSON.stringify({ id: 'evt_3', type: 'invoice.paid', account: 'acct_x' });
    const forwarded: Array<{ url: string; headers: Headers; body: string }> = [];
    expect((await handleStripeConnectWebhook(env({}, forwarded), unknown, await signed(unknown))).status).toBe(200);
    expect(forwarded).toHaveLength(0);
  });

  it('answers 502 when ingest fails so Stripe retries', async () => {
    const body = JSON.stringify({ id: 'evt_4', type: 'payout.paid', account: 'acct_1' });
    const kv = { 'stripeacct:acct_1': JSON.stringify([{ workspaceId: 'ws', connectionId: 'conn' }]) };
    const res = await handleStripeConnectWebhook(env(kv, [], 500), body, await signed(body));
    expect(res.status).toBe(502);
  });
});
