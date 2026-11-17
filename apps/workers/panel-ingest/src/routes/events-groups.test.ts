import { keyKvKey } from '@weldsuite/panel-domain/registry';
import type { WireGroupOp } from '@weldsuite/panel-domain/wire';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, PROJECT_ID, TOKEN, WORKSPACE_ID, call, makeEnv, projectRecord, resetIsolateState, wireBatch, wireEvent } from '../testing/fakes';

const set = (type: string, key: string, props: Record<string, string | number | boolean | null> = {}): WireGroupOp => ({ op: 'set', type, key, props });

describe('POST /e: groups, mobile apps, proxies and the new event names', () => {
  beforeEach(() => {
    resetIsolateState();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  describe('groups', () => {
    it('applies group operations sent with consent and writes a groups_v1 snapshot', async () => {
      const testEnv = makeEnv();
      const res = await call(testEnv, {
        body: wireBatch({ consent: true, events: [wireEvent({ props: { $group_company: 'acme' } })], groups: [set('company', 'acme', { $name: 'Acme', plan: 'pro' })] }),
      });
      expect(res.status).toBe(204);

      const group = await testEnv.projects.get(PROJECT_ID).getGroup('company', 'acme');
      expect(group).toMatchObject({ groupType: 'company', groupKey: 'acme', properties: { $name: 'Acme', plan: 'pro' } });
      expect(testEnv.groups.sent).toEqual([
        expect.objectContaining({ project_id: PROJECT_ID, group_type: 'company', group_key: 'acme', deleted: false, properties: '{"$name":"Acme","plan":"pro"}' }),
      ]);
      expect(JSON.parse(testEnv.stream.sent[0]!.properties)).toEqual({ $group_company: 'acme' });
    });

    it('ignores group operations in a batch sent without consent, like people operations', async () => {
      const testEnv = makeEnv();
      const res = await call(testEnv, {
        body: wireBatch({ consent: false, events: [wireEvent()], groups: [set('company', 'acme', { $name: 'Acme' })] }),
      });
      expect(res.status).toBe(204);
      expect(await testEnv.projects.get(PROJECT_ID).getGroup('company', 'acme')).toBeNull();
      expect(testEnv.groups.sent).toEqual([]);
      expect(testEnv.stream.sent).toHaveLength(1);
    });

    it('keeps $group_ properties of five types and drops a sixth, also when no operation names them', async () => {
      const testEnv = makeEnv();
      const types = ['a', 'b', 'c', 'd', 'e'];
      await call(testEnv, { body: wireBatch({ consent: true, groups: types.map((type) => set(type, 'k')) }) });

      await call(testEnv, {
        body: wireBatch({
          consent: true,
          groups: [set('f', 'k')],
          events: [wireEvent({ props: { $group_a: 'k', $group_f: 'k', plan: 'pro' } })],
        }),
      });

      expect(await testEnv.projects.get(PROJECT_ID).groupTypes()).toEqual(types);
      expect(await testEnv.projects.get(PROJECT_ID).getGroup('f', 'k')).toBeNull();
      expect(JSON.parse(testEnv.stream.sent.at(-1)!.properties)).toEqual({ $group_a: 'k', plan: 'pro' });
    });

    it('gives a type named only by an event property its slot', async () => {
      const testEnv = makeEnv();
      await call(testEnv, { body: wireBatch({ events: [wireEvent({ props: { $group_workspace: 'w-1' } })] }) });
      expect(await testEnv.projects.get(PROJECT_ID).groupTypes()).toEqual(['workspace']);
      expect(JSON.parse(testEnv.stream.sent[0]!.properties)).toEqual({ $group_workspace: 'w-1' });
    });

    it('drops an invalid group operation alone and refuses more than 50', async () => {
      const testEnv = makeEnv();
      await call(testEnv, { body: { ...wireBatch({ consent: true }), groups: [{ op: 'set', type: 'Bad-Type', key: 'k', props: {} }, set('company', 'ok')] } });
      expect(testEnv.groups.sent.map((row) => row.group_key)).toEqual(['ok']);

      const tooMany = await call(testEnv, { body: { ...wireBatch(), groups: Array.from({ length: 51 }, () => set('company', 'x')) } });
      expect(tooMany.status).toBe(400);
    });

    it('keeps the properties when the object is not bound', async () => {
      const testEnv = makeEnv();
      const env = { ...testEnv.env, PANEL_PROJECT: undefined };
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await call({ ...testEnv, env }, { body: wireBatch({ events: [wireEvent({ props: { $group_company: 'acme' } })] }) });
      expect(JSON.parse(testEnv.stream.sent[0]!.properties)).toEqual({ $group_company: 'acme' });
    });
  });

  describe('mobile batches', () => {
    const mobileEvent = (overrides: Parameters<typeof wireEvent>[0] = {}) =>
      wireEvent({
        name: '$screen',
        url: 'app://com.acme.shop/Product-Detail',
        props: { $app_id: 'com.acme.shop', $screen_name: ' Product  Detail ', $os: 'iOS', $device_type: 'tablet', $app_version: '2.1.0' },
        ...overrides,
      });

    it('take the screen, app and device columns from the properties', async () => {
      const testEnv = makeEnv();
      await call(testEnv, { body: wireBatch({ lib: 'mobile', events: [mobileEvent()] }), headers: { 'User-Agent': 'okhttp/4.12.0' } });

      expect(testEnv.stream.sent[0]).toMatchObject({
        name: '$screen',
        lib: 'mobile',
        host: 'com.acme.shop',
        path: '/Product-Detail',
        url: 'app://com.acme.shop/Product-Detail',
        title: 'Product  Detail',
        os: 'iOS',
        device_type: 'tablet',
        browser: null,
        referrer: null,
        utm_source: null,
        country: 'NL',
      });
    });

    it('fall back to the root path without a screen, and leave unknown systems and devices empty', async () => {
      const testEnv = makeEnv();
      await call(testEnv, {
        body: wireBatch({
          lib: 'mobile',
          events: [mobileEvent({ name: '$app_opened', props: { $app_id: 'com.acme.shop', $os: 'tvOS', $device_type: 'watch' } })],
        }),
      });
      expect(testEnv.stream.sent[0]).toMatchObject({ host: 'com.acme.shop', path: '/', url: 'app://com.acme.shop/', title: null, os: null, device_type: null });
    });

    it('apply the excluded paths to the screen path', async () => {
      const testEnv = makeEnv(projectRecord({ settings: { ...projectRecord().settings, excludedUrls: ['/Checkout*'] } }));
      await call(testEnv, { body: wireBatch({ lib: 'mobile', events: [mobileEvent({ props: { $app_id: 'com.acme.shop', $screen_name: 'Checkout step 1' } })] }) });
      expect(testEnv.stream.sent).toEqual([]);
    });
  });

  describe('behind a proxy', () => {
    it('uses the first forwarded hop for the IP filter and the proxy geo headers', async () => {
      const filtered = makeEnv(projectRecord({ settings: { ...projectRecord().settings, ipFilters: ['198.51.100.0/24'] } }));
      await call(filtered, { headers: { 'X-Forwarded-For': '198.51.100.9, 203.0.113.7' } });
      expect(filtered.stream.sent).toEqual([]);

      const testEnv = makeEnv();
      await call(testEnv, {
        headers: { 'X-Forwarded-For': '198.51.100.9', 'X-WeldPanel-Country': 'de', 'X-WeldPanel-Region': 'Berlin', 'X-WeldPanel-City': 'Berlin%20Mitte' },
      });
      expect(testEnv.stream.sent[0]).toMatchObject({ country: 'DE', region: 'Berlin', city: 'Berlin Mitte' });
    });

    it("reads Vercel's geo headers, and Cloudflare's without any", async () => {
      const vercel = makeEnv();
      await call(vercel, { headers: { 'x-vercel-ip-country': 'US', 'x-vercel-ip-country-region': 'CA', 'x-vercel-ip-city': 'San%20Francisco' } });
      expect(vercel.stream.sent[0]).toMatchObject({ country: 'US', region: 'CA', city: 'San Francisco' });

      const direct = makeEnv();
      await call(direct);
      expect(direct.stream.sent[0]).toMatchObject({ country: 'NL', region: 'North Holland', city: 'Amsterdam' });
    });

    it('limits per client IP, and per connecting IP with the higher ceiling', async () => {
      const testEnv = makeEnv(projectRecord(), { limits: { events: 1, proxy: 2 } });
      const from = (client: string) => ({ headers: { 'X-Forwarded-For': client, 'CF-Connecting-IP': '203.0.113.7' } });

      expect((await call(testEnv, from('198.51.100.1'))).status).toBe(204);
      expect((await call(testEnv, from('198.51.100.1'))).status).toBe(429);
      expect((await call(testEnv, from('198.51.100.2'))).status).toBe(204);
      // A third client through the same proxy is over the proxy's ceiling of two.
      expect((await call(testEnv, from('198.51.100.3'))).status).toBe(429);
    });
  });

  it('accepts the web vitals event with its reserved properties, and first-touch properties', async () => {
    const testEnv = makeEnv();
    await call(testEnv, {
      body: wireBatch({
        events: [
          wireEvent({ name: '$webvitals', props: { $lcp: 1830, $cls: 0.04, $lcp_el: 'main > img.hero', $nav_type: 'navigate' } }),
          wireEvent({ event_id: 'evt-00000002', name: 'Signed up', props: { $initial_utm_source: 'news', $initial_landing_path: '/pricing' } }),
        ],
      }),
    });
    expect(testEnv.stream.sent.map((row) => row.name)).toEqual(['$webvitals', 'Signed up']);
    expect(JSON.parse(testEnv.stream.sent[0]!.properties)).toEqual({ $lcp: 1830, $cls: 0.04, $lcp_el: 'main > img.hero', $nav_type: 'navigate' });
  });

  it('keeps web vitals out of the live view', async () => {
    const testEnv = makeEnv();
    await call(testEnv, { body: wireBatch({ events: [wireEvent({ name: '$webvitals', props: { $lcp: 1 } })] }) });
    expect((await testEnv.projects.get(PROJECT_ID).live()).visitors).toBe(0);
  });

  it('applies group operations sent by a server with a secret key, alone or with events', async () => {
    const secret = `wps_${'0123456789abcdef'.repeat(2)}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    const testEnv = makeEnv();
    testEnv.kv.store.set(keyKvKey(hash), JSON.stringify({ v: 1, keyId: 'pnk_1', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID }));
    const send = (payload: unknown) =>
      call(testEnv, { path: '/v1/track', body: payload, headers: { 'Content-Type': 'application/json', Origin: '', Authorization: `Bearer ${secret}` } });

    const alone = await send({ lib: 'server', lib_version: '0.3.0', groups: [set('company', 'acme', { $name: 'Acme' })] });
    expect(alone.status).toBe(200);
    expect(await alone.json()).toEqual({ accepted: 0, dropped: 0 });
    expect(await testEnv.projects.get(PROJECT_ID).getGroup('company', 'acme')).toMatchObject({ properties: { $name: 'Acme' } });

    const withEvent = await send({
      lib: 'server',
      lib_version: '0.3.0',
      events: [{ event_id: 'evt-00000009', name: 'Invoice paid', ts: new Date(NOW - 1000).toISOString(), distinct_id: 'user-1', props: { $group_company: 'acme' } }],
    });
    expect(await withEvent.json()).toEqual({ accepted: 1, dropped: 0 });
    expect(JSON.parse(testEnv.stream.sent[0]!.properties)).toEqual({ $group_company: 'acme' });
    expect(TOKEN).toMatch(/^wpk_/);
  });
});
