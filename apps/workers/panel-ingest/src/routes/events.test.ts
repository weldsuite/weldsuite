import { seenKvKey } from '@weldsuite/panel-domain/registry';
import { MAX_BATCH_BYTES, MAX_EVENTS_PER_BATCH } from '@weldsuite/panel-domain/wire';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import {
  CHROME_WINDOWS,
  NOW,
  PROJECT_ID,
  TOKEN,
  WORKSPACE_ID,
  call,
  makeEnv,
  projectRecord,
  resetIsolateState,
  wireBatch,
  wireEvent,
} from '../testing/fakes';

const SETTINGS = projectRecord().settings;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

async function usageOf(testEnv: ReturnType<typeof makeEnv>, month = '2026-10') {
  return testEnv.usage.get(WORKSPACE_ID).month(month);
}

describe('POST /e', () => {
  beforeEach(() => {
    resetIsolateState();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  describe('accepting a batch', () => {
    it('answers 204 and writes one row per event', async () => {
      const testEnv = makeEnv();
      const batch = wireBatch({
        events: [wireEvent({ event_id: 'evt-aaaaaaaa' }), wireEvent({ event_id: 'evt-bbbbbbbb', name: '$pageleave', scroll_depth: 40 })],
      });

      const res = await call(testEnv, { body: batch });

      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      expect(testEnv.stream.sent.map((row) => [row.event_id, row.name])).toEqual([
        ['evt-aaaaaaaa', '$pageview'],
        ['evt-bbbbbbbb', '$pageleave'],
      ]);
      expect(testEnv.stream.send).toHaveBeenCalledTimes(1);
    });

    it('drops an event it cannot read and keeps the rest of the batch', async () => {
      const testEnv = makeEnv();
      const unreadable = { ...wireEvent({ event_id: 'evt-bbbbbbbb' }), url: 'not a url' };
      const batch = { ...wireBatch(), events: [wireEvent({ event_id: 'evt-aaaaaaaa' }), unreadable, wireEvent({ event_id: 'evt-cccccccc' })] };

      const res = await call(testEnv, { body: batch });

      expect(res.status).toBe(204);
      expect(testEnv.stream.sent.map((row) => row.event_id)).toEqual(['evt-aaaaaaaa', 'evt-cccccccc']);
    });

    it('keeps click versus submit in $action, as events_v1 has no column for it', async () => {
      const testEnv = makeEnv();
      const submit = wireEvent({ name: '$autocapture', el: { tag: 'form', selector: 'form.signup', action: 'submit' } });

      await call(testEnv, { body: wireBatch({ events: [submit, wireEvent()] }) });

      expect(testEnv.stream.sent.map((row) => JSON.parse(row.properties))).toEqual([{ $action: 'submit' }, {}]);
    });

    it('answers before the writes finish', async () => {
      const testEnv = makeEnv();
      let release: () => void = () => {};
      testEnv.stream.send.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
      const waited: Promise<unknown>[] = [];
      const request = new Request('https://pnl.test/e', {
        method: 'POST',
        body: JSON.stringify(wireBatch()),
        headers: { 'User-Agent': CHROME_WINDOWS, Origin: 'https://shop.example.com' },
      });

      const res = await app.fetch(request, testEnv.env, {
        waitUntil: (promise: Promise<unknown>) => waited.push(promise),
        passThroughOnException: () => {},
      } as unknown as ExecutionContext);

      expect(res.status).toBe(204);
      await vi.waitFor(() => expect(testEnv.stream.send).toHaveBeenCalledTimes(1));
      expect((await usageOf(testEnv)).events).toBe(0);

      release();
      await Promise.all(waited);
      expect((await usageOf(testEnv)).events).toBe(1);
    });

    it('accepts the body as application/json too', async () => {
      const testEnv = makeEnv();
      const res = await call(testEnv, { body: wireBatch(), headers: { 'Content-Type': 'application/json' } });

      expect(res.status).toBe(204);
      expect(testEnv.stream.sent).toHaveLength(1);
    });

    it('accepts a body without a Content-Type', async () => {
      const testEnv = makeEnv();
      // Fetch gives a string body text/plain by itself; an empty value is what a bare beacon can look like.
      const res = await call(testEnv, { body: JSON.stringify(wireBatch()), headers: { 'Content-Type': '' } });

      expect(res.status).toBe(204);
    });

    it('fills the standard columns from the request', async () => {
      const testEnv = makeEnv();
      const batch = wireBatch({
        events: [
          wireEvent({
            url: 'https://shop.example.com/products/shoes?utm_source=newsletter&utm_medium=email&token=abc#section',
            referrer: 'https://www.google.com/search?q=shoes&auth=xyz',
            title: 'Shoes',
            viewport_w: 1280,
            props: { plan: 'pro' },
          }),
        ],
      });

      await call(testEnv, {
        body: batch,
        cf: { country: 'NL', region: 'North Holland', city: 'Amsterdam' },
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
        },
      });

      expect(testEnv.stream.sent[0]).toMatchObject({
        workspace_id: WORKSPACE_ID,
        project_id: PROJECT_ID,
        url: 'https://shop.example.com/products/shoes?utm_source=newsletter&utm_medium=email',
        host: 'shop.example.com',
        path: '/products/shoes',
        referrer: 'https://www.google.com/search?q=shoes',
        referrer_host: 'www.google.com',
        utm_source: 'newsletter',
        utm_medium: 'email',
        country: 'NL',
        region: 'North Holland',
        city: 'Amsterdam',
        device_type: 'mobile',
        browser: 'Safari',
        os: 'iOS',
        title: 'Shoes',
        viewport_w: 1280,
        properties: '{"plan":"pro"}',
        lib: 'web',
        lib_version: '0.1.0',
        received_at: new Date(NOW).toISOString(),
      });
    });

    it('leaves geo null when Cloudflare gave none, and for the unknown country', async () => {
      const testEnv = makeEnv();
      await call(testEnv, { cf: {} });
      await call(testEnv, { cf: { country: 'XX' }, body: wireBatch({ events: [wireEvent({ event_id: 'evt-second-01' })] }) });

      expect(testEnv.stream.sent.map((row) => [row.country, row.region, row.city])).toEqual([
        [null, null, null],
        [null, null, null],
      ]);
    });

    it('never stores the IP address or the user agent string', async () => {
      const testEnv = makeEnv();
      await call(testEnv, { headers: { 'CF-Connecting-IP': '203.0.113.99' } });

      const stored = JSON.stringify(testEnv.stream.sent);
      expect(stored).not.toContain('203.0.113.99');
      expect(stored).not.toContain('Mozilla');
    });

    it('corrects the event time by the client clock skew', async () => {
      const testEnv = makeEnv();
      const behind = 3 * 60 * MINUTE;
      const batch = wireBatch({
        sent_at: new Date(NOW - behind).toISOString(),
        events: [wireEvent({ ts: new Date(NOW - behind - 4 * SECOND).toISOString() })],
      });

      await call(testEnv, { body: batch });

      expect(testEnv.stream.sent[0]!.ts).toBe(new Date(NOW - 4 * SECOND).toISOString());
    });
  });

  describe('visitor ids', () => {
    it('derives a daily cookieless id and no session without consent', async () => {
      const testEnv = makeEnv();
      await call(testEnv);

      expect(testEnv.stream.sent[0]).toMatchObject({ cookieless: true, session_id: null, user_id: null });
      expect(testEnv.stream.sent[0]!.anon_id).toMatch(/^ck_[0-9a-f]{24}$/);
      expect(testEnv.stream.sent[0]!.distinct_id).toBe(testEnv.stream.sent[0]!.anon_id);
    });

    it('does not use ids the client sends without consent', async () => {
      const testEnv = makeEnv();
      const batch = wireBatch({ consent: false, events: [wireEvent({ anon_id: 'client-anon', session_id: 'client-session' })] });
      await call(testEnv, { body: batch });

      const row = testEnv.stream.sent[0]!;
      expect(row.anon_id).not.toBe('client-anon');
      expect(row.anon_id.startsWith('ck_')).toBe(true);
      expect(row.session_id).toBeNull();
      expect(JSON.stringify(row)).not.toContain('client-');
    });

    it('uses the client ids with consent', async () => {
      const testEnv = makeEnv();
      const batch = wireBatch({ consent: true, events: [wireEvent({ anon_id: 'client-anon', session_id: 'client-session' })] });
      await call(testEnv, { body: batch });

      expect(testEnv.stream.sent[0]).toMatchObject({
        anon_id: 'client-anon',
        distinct_id: 'client-anon',
        session_id: 'client-session',
        cookieless: false,
      });
    });

    it('gives the same visitor the same id all day, and everyone else another', async () => {
      const testEnv = makeEnv();
      await call(testEnv, { body: wireBatch({ events: [wireEvent({ event_id: 'evt-aaaaaaaa' })] }) });
      vi.setSystemTime(NOW + 6 * 60 * MINUTE);
      await call(testEnv, { body: wireBatch({ events: [wireEvent({ event_id: 'evt-bbbbbbbb' })] }) });
      await call(testEnv, {
        body: wireBatch({ events: [wireEvent({ event_id: 'evt-cccccccc' })] }),
        headers: { 'CF-Connecting-IP': '198.51.100.20' },
      });
      await call(testEnv, {
        body: wireBatch({ events: [wireEvent({ event_id: 'evt-dddddddd' })] }),
        headers: { 'User-Agent': `${CHROME_WINDOWS} Extra` },
      });

      const [a, b, otherIp, otherAgent] = testEnv.stream.sent.map((row) => row.anon_id);
      expect(b).toBe(a);
      expect(otherIp).not.toBe(a);
      expect(otherAgent).not.toBe(a);
    });

    it('gives the same visitor another id the next day', async () => {
      const testEnv = makeEnv();
      await call(testEnv);
      vi.setSystemTime(Date.parse('2026-10-28T00:00:30Z'));
      await call(testEnv, { body: wireBatch({ events: [wireEvent({ event_id: 'evt-nextday01' })] }) });

      const [monday, tuesday] = testEnv.stream.sent.map((row) => row.anon_id);
      expect(tuesday).not.toBe(monday);
    });

    it('gives the same visitor another id on another project', async () => {
      const first = makeEnv();
      await call(first);
      const second = makeEnv(projectRecord({ projectId: 'pnp_other_project' }));
      // Same salt object, so only the project differs.
      second.env.PANEL_SALT = first.env.PANEL_SALT;
      await call(second);

      expect(second.stream.sent[0]!.anon_id).not.toBe(first.stream.sent[0]!.anon_id);
    });

    it('asks for the salt once per isolate per day', async () => {
      const testEnv = makeEnv();
      const today = vi.spyOn(testEnv.salt, 'today');
      for (let i = 0; i < 5; i += 1) {
        await call(testEnv, { body: wireBatch({ events: [wireEvent({ event_id: `evt-repeat-0${i}` })] }) });
      }

      expect(today).toHaveBeenCalledTimes(1);
    });

    it('does not ask for the salt when every event brings a consented id', async () => {
      const testEnv = makeEnv();
      const today = vi.spyOn(testEnv.salt, 'today');
      await call(testEnv, { body: wireBatch({ consent: true, events: [wireEvent({ anon_id: 'client-anon' })] }) });

      expect(today).not.toHaveBeenCalled();
    });

    it('still writes consented events when the salt is unavailable, and drops the cookieless ones', async () => {
      const testEnv = makeEnv();
      vi.spyOn(testEnv.salt, 'today').mockRejectedValue(new Error('salt unavailable'));
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const batch = wireBatch({
        consent: true,
        events: [wireEvent({ event_id: 'evt-consented', anon_id: 'client-anon' }), wireEvent({ event_id: 'evt-cookieless' })],
      });

      const res = await call(testEnv, { body: batch });

      expect(res.status).toBe(204);
      expect(testEnv.stream.sent.map((row) => row.event_id)).toEqual(['evt-consented']);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Salt lookup failed'));
      log.mockRestore();
    });
  });

  describe('rejecting a request', () => {
    it('answers 413 for a body over 64 KiB, however it announces its size', async () => {
      const testEnv = makeEnv();
      const oversized = 'x'.repeat(MAX_BATCH_BYTES + 1);

      const streamed = await call(testEnv, { body: oversized });
      const declared = await call(testEnv, { body: '{}', headers: { 'Content-Length': String(MAX_BATCH_BYTES + 1) } });

      expect(streamed.status).toBe(413);
      expect(declared.status).toBe(413);
      expect(testEnv.stream.sent).toHaveLength(0);
    });

    it('accepts a batch of exactly 64 KiB', async () => {
      const testEnv = makeEnv();
      const json = JSON.stringify(wireBatch());
      const padded = `${json}${' '.repeat(MAX_BATCH_BYTES - json.length)}`;
      expect(new TextEncoder().encode(padded).byteLength).toBe(MAX_BATCH_BYTES);

      expect((await call(testEnv, { body: padded })).status).toBe(204);
    });

    it('counts bytes, not characters', async () => {
      const multibyte = '€'.repeat(Math.ceil(MAX_BATCH_BYTES / 3) + 1);
      expect((await call(makeEnv(), { body: multibyte })).status).toBe(413);
    });

    it('answers 415 for another content type', async () => {
      const res = await call(makeEnv(), { body: 'a=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      expect(res.status).toBe(415);
    });

    it('answers 400 for a body that is not JSON', async () => {
      const res = await call(makeEnv(), { body: 'not json' });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: 'invalid_body', message: 'The body is not valid JSON' } });
    });

    it('answers 400 with the first problem for a body that is not a batch', async () => {
      const bad = { ...wireBatch(), events: [wireEvent({ url: 'nope' })] };
      const res = await call(makeEnv(), { body: bad });

      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: { code: string; message: string } };
      expect(error.code).toBe('invalid_batch');
      expect(error.message).toMatch(/^events\.0\.url: /);
    });

    it.each([
      ['no events', { events: [] }],
      ['too many events', { events: Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, i) => wireEvent({ event_id: `evt-many-${i}` })) }],
      ['an event name nobody could type', { events: [wireEvent({ name: '<script>' })] }],
      ['a property key that is not an identifier', { events: [wireEvent({ props: { 'bad key': 1 } })] }],
      ['no consent flag', { consent: undefined as unknown as boolean }],
    ])('answers 400 for %s', async (_label, overrides) => {
      const testEnv = makeEnv();
      const res = await call(testEnv, { body: wireBatch(overrides) });

      expect(res.status).toBe(400);
      expect(testEnv.stream.sent).toHaveLength(0);
    });

    it('answers 404 for an unknown token', async () => {
      const testEnv = makeEnv(null);
      const res = await call(testEnv);

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: 'unknown_project' } });
      expect(testEnv.stream.sent).toHaveLength(0);
    });

    it('answers 404 for a token that cannot be one, without asking KV', async () => {
      const testEnv = makeEnv();
      const res = await call(testEnv, { body: wireBatch({ token: 'wpk_short' }) });

      expect(res.status).toBe(404);
      expect(testEnv.kv.get).not.toHaveBeenCalled();
    });
  });

  describe('allowed domains', () => {
    const restricted = projectRecord({ allowedDomains: ['example.com'] });

    it('answers 403 for an origin that is not listed', async () => {
      const testEnv = makeEnv(restricted);
      const res = await call(testEnv, { headers: { Origin: 'https://evil.test' } });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: 'origin_not_allowed' } });
      expect(testEnv.stream.sent).toHaveLength(0);
    });

    it('answers 403 for a look-alike host', async () => {
      const res = await call(makeEnv(restricted), { headers: { Origin: 'https://notexample.com' } });
      expect(res.status).toBe(403);
    });

    it('answers 403 when there is no Origin at all', async () => {
      const testEnv = makeEnv(restricted);
      const res = await call(testEnv, { headers: { Origin: '' } });

      expect(res.status).toBe(403);
    });

    it('accepts the listed host and its subdomains', async () => {
      const testEnv = makeEnv(restricted);

      expect((await call(testEnv, { headers: { Origin: 'https://example.com' } })).status).toBe(204);
      expect((await call(testEnv, { headers: { Origin: 'https://shop.example.com' } })).status).toBe(204);
      expect(testEnv.stream.sent).toHaveLength(2);
    });

    it('accepts any origin, or none, when the project lists no domains', async () => {
      const testEnv = makeEnv();

      expect((await call(testEnv, { headers: { Origin: 'https://anything.test' } })).status).toBe(204);
      expect((await call(testEnv, { headers: { Origin: '' } })).status).toBe(204);
    });
  });

  describe('dropping a batch with 204', () => {
    async function expectDropped(testEnv: ReturnType<typeof makeEnv>, res: Response) {
      expect(res.status).toBe(204);
      expect(testEnv.stream.send).not.toHaveBeenCalled();
      expect((await usageOf(testEnv)).events).toBe(0);
      expect(testEnv.kv.puts).toHaveLength(0);
    }

    it('for a paused project', async () => {
      const testEnv = makeEnv(projectRecord({ status: 'paused' }));
      await expectDropped(testEnv, await call(testEnv));
    });

    it.each([
      ['Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
      ['headless Chrome', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36'],
      ['curl', 'curl/8.4.0'],
    ])('for %s', async (_label, userAgent) => {
      const testEnv = makeEnv();
      await expectDropped(testEnv, await call(testEnv, { headers: { 'User-Agent': userAgent } }));
    });

    it('for a verified bot, whatever its user agent says', async () => {
      const testEnv = makeEnv();
      await expectDropped(testEnv, await call(testEnv, { cf: { botManagement: { verifiedBot: true, score: 99 } } }));
    });

    it('but not for a visitor Cloudflare did not flag', async () => {
      const testEnv = makeEnv();
      const res = await call(testEnv, { cf: { botManagement: { verifiedBot: false, score: 90 } } });

      expect(res.status).toBe(204);
      expect(testEnv.stream.sent).toHaveLength(1);
    });

    it.each([
      ['an exact IPv4 address', ['203.0.113.7']],
      ['an IPv4 range', ['10.0.0.0/8', '203.0.113.0/24']],
    ])('for %s in the IP filters', async (_label, ipFilters) => {
      const testEnv = makeEnv(projectRecord({ settings: { ...SETTINGS, ipFilters } }));
      await expectDropped(testEnv, await call(testEnv, { headers: { 'CF-Connecting-IP': '203.0.113.7' } }));
    });

    it('for an IPv6 address in the IP filters', async () => {
      const testEnv = makeEnv(projectRecord({ settings: { ...SETTINGS, ipFilters: ['2001:db8::/32'] } }));
      await expectDropped(testEnv, await call(testEnv, { headers: { 'CF-Connecting-IP': '2001:db8:aaaa::1' } }));
    });

    it('but not for an address outside the filters', async () => {
      const testEnv = makeEnv(projectRecord({ settings: { ...SETTINGS, ipFilters: ['203.0.113.0/24'] } }));
      await call(testEnv, { headers: { 'CF-Connecting-IP': '203.0.114.7' } });

      expect(testEnv.stream.sent).toHaveLength(1);
    });

    it('for a batch of events only on excluded paths', async () => {
      const testEnv = makeEnv(projectRecord({ settings: { ...SETTINGS, excludedUrls: ['/admin/*'] } }));
      const batch = wireBatch({ events: [wireEvent({ url: 'https://shop.example.com/admin/users' })] });

      await expectDropped(testEnv, await call(testEnv, { body: batch }));
    });

    it('only the excluded events of a mixed batch', async () => {
      const testEnv = makeEnv(projectRecord({ settings: { ...SETTINGS, excludedUrls: ['/admin/*'] } }));
      const batch = wireBatch({
        events: [
          wireEvent({ event_id: 'evt-public-01', url: 'https://shop.example.com/products' }),
          wireEvent({ event_id: 'evt-admin-001', url: 'https://shop.example.com/admin/users' }),
        ],
      });

      expect((await call(testEnv, { body: batch })).status).toBe(204);
      expect(testEnv.stream.sent.map((row) => row.event_id)).toEqual(['evt-public-01']);
      expect((await usageOf(testEnv)).events).toBe(1);
    });
  });

  describe('bookkeeping', () => {
    it('counts the written events for the workspace and the UTC day', async () => {
      const testEnv = makeEnv();
      const batch = wireBatch({ events: [wireEvent({ event_id: 'evt-aaaaaaaa' }), wireEvent({ event_id: 'evt-bbbbbbbb' })] });

      await call(testEnv, { body: batch });
      await call(testEnv, { body: wireBatch({ events: [wireEvent({ event_id: 'evt-cccccccc' })] }) });

      expect(await usageOf(testEnv)).toEqual({ month: '2026-10', events: 3, days: { '2026-10-27': 3 } });
    });

    it('keeps one count per workspace', async () => {
      const mine = makeEnv();
      const theirs = makeEnv(projectRecord({ workspaceId: 'ws_other_workspace' }));
      theirs.env.PANEL_USAGE = mine.env.PANEL_USAGE;

      await call(mine);
      await call(theirs);

      expect((await mine.usage.get(WORKSPACE_ID).month('2026-10')).events).toBe(1);
      expect((await mine.usage.get('ws_other_workspace').month('2026-10')).events).toBe(1);
    });

    it('marks the project seen, at most once every five minutes per isolate', async () => {
      const testEnv = makeEnv();
      const seen = () => testEnv.kv.puts.filter((put) => put.key === seenKvKey(PROJECT_ID));

      await call(testEnv);
      expect(seen()).toHaveLength(1);
      expect(seen()[0]!.value).toBe(new Date(NOW).toISOString());

      vi.setSystemTime(NOW + 4 * MINUTE);
      await call(testEnv, { body: wireBatch({ events: [wireEvent({ event_id: 'evt-second-01' })] }) });
      expect(seen()).toHaveLength(1);

      vi.setSystemTime(NOW + 5 * MINUTE + SECOND);
      await call(testEnv, { body: wireBatch({ events: [wireEvent({ event_id: 'evt-third-001' })] }) });
      expect(seen()).toHaveLength(2);
    });

    it('does not turn a failed stream write into an error for the site, nor count the events', async () => {
      const testEnv = makeEnv();
      testEnv.stream.send.mockRejectedValue(new Error('stream unavailable'));
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await call(testEnv);

      expect(res.status).toBe(204);
      expect((await usageOf(testEnv)).events).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('stream unavailable'));
      log.mockRestore();
    });

    it('does not let a failed count undo the write, and keeps the log free of request data', async () => {
      const testEnv = makeEnv();
      vi.spyOn(testEnv.usage.get(WORKSPACE_ID), 'add').mockRejectedValue(new Error('usage unavailable'));
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await call(testEnv, { headers: { 'CF-Connecting-IP': '203.0.113.99' } });

      expect(res.status).toBe(204);
      expect(testEnv.stream.sent).toHaveLength(1);
      expect(log).toHaveBeenCalledTimes(1);
      const logged = String(log.mock.calls[0]![0]);
      expect(logged).toContain(PROJECT_ID);
      expect(logged).not.toContain('203.0.113.99');
      log.mockRestore();
    });

    it('notices a project paused after its first batch', async () => {
      const testEnv = makeEnv();
      await call(testEnv);
      testEnv.kv.store.set(`panel:project:${TOKEN}`, JSON.stringify(projectRecord({ status: 'paused' })));
      await call(testEnv, { body: wireBatch({ events: [wireEvent({ event_id: 'evt-after-pause' })] }) });

      expect(testEnv.stream.sent.map((row) => row.event_id)).toEqual(['evt-00000001']);
    });
  });
});
