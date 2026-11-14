import { quotaKvKey } from '@weldsuite/panel-domain/registry';
import type { WirePeopleOp } from '@weldsuite/panel-domain/wire';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_FLUSH_INTERVAL_MS } from '../lib/live';
import {
  NOW,
  PROJECT_ID,
  TOKEN,
  call,
  makeEnv,
  projectRecord,
  resetIsolateState,
  wireBatch,
  wireEvent,
} from '../testing/fakes';

const TS = '2026-10-27T11:59:58.000Z';
const consented = (events: ReturnType<typeof wireEvent>[], extra: Record<string, unknown> = {}) =>
  wireBatch({ consent: true, events: events.map((e) => ({ anon_id: 'a-browser', session_id: 's-browser', ...e })), ...extra });

describe('POST /e: users, people and the new events', () => {
  beforeEach(() => {
    resetIsolateState();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  describe('user ids', () => {
    it('are written with consent and become the distinct id', async () => {
      const testEnv = makeEnv();
      await call(testEnv, { body: consented([wireEvent({ user_id: 'user-1' })]) });

      expect(testEnv.stream.sent[0]).toMatchObject({ user_id: 'user-1', distinct_id: 'user-1', anon_id: 'a-browser', cookieless: false });
    });

    it('are dropped without consent, which keeps the visitor cookieless', async () => {
      const testEnv = makeEnv();
      await call(testEnv, { body: wireBatch({ consent: false, events: [wireEvent({ user_id: 'user-1', anon_id: 'a-browser' })] }) });

      const [row] = testEnv.stream.sent;
      expect(row).toMatchObject({ user_id: null, cookieless: true });
      expect(row!.distinct_id).toMatch(/^ck_/);
    });

    it('are not attached to an event that has no consented anonymous id', async () => {
      const testEnv = makeEnv();
      await call(testEnv, { body: wireBatch({ consent: true, events: [wireEvent({ user_id: 'user-1' })] }) });

      expect(testEnv.stream.sent[0]).toMatchObject({ user_id: null, cookieless: true });
    });
  });

  describe('the new columns', () => {
    it('carry the click position inside the element, and the error message', async () => {
      const testEnv = makeEnv();
      const el = { tag: 'button', selector: 'main > button', action: 'click' as const };
      await call(testEnv, {
        body: wireBatch({
          events: [
            wireEvent({ event_id: 'evt-aaaaaaaa', name: '$rageclick', x: 10, y: 20, rel_x: 0.25, rel_y: 0.75, el }),
            wireEvent({ event_id: 'evt-bbbbbbbb', name: '$deadclick', rel_x: 0, rel_y: 1, el }),
            wireEvent({
              event_id: 'evt-cccccccc',
              name: '$exception',
              error_message: 'x is not a function',
              props: { $source: 'app.js', $line: 12, $col: 3 },
            }),
            wireEvent({ event_id: 'evt-dddddddd', name: '$quickback', props: { $from: '/pricing' } }),
            wireEvent({ event_id: 'evt-eeeeeeee', name: '$excessivescroll', scroll_depth: 90 }),
          ],
        }),
      });

      const rows = testEnv.stream.sent;
      expect(rows.map((row) => row.name)).toEqual(['$rageclick', '$deadclick', '$exception', '$quickback', '$excessivescroll']);
      expect(rows[0]).toMatchObject({ rel_x: 0.25, rel_y: 0.75, error_message: null });
      expect(rows[1]).toMatchObject({ rel_x: 0, rel_y: 1 });
      expect(rows[2]).toMatchObject({ error_message: 'x is not a function', rel_x: null });
      expect(JSON.parse(rows[2]!.properties)).toEqual({ $source: 'app.js', $line: 12, $col: 3 });
      expect(JSON.parse(rows[3]!.properties)).toEqual({ $from: '/pricing' });
      expect(rows[4]).toMatchObject({ scroll_depth: 90 });
    });

    it('are null on a plain pageview', async () => {
      const testEnv = makeEnv();
      await call(testEnv);
      expect(testEnv.stream.sent[0]).toMatchObject({ rel_x: null, rel_y: null, error_message: null, user_id: null });
    });

    it('send frustration and exception events without consent, cookieless like pageviews', async () => {
      const testEnv = makeEnv();
      await call(testEnv, { body: wireBatch({ consent: false, events: [wireEvent({ name: '$exception', error_message: 'boom' })] }) });
      expect(testEnv.stream.sent[0]).toMatchObject({ name: '$exception', cookieless: true, error_message: 'boom' });
    });
  });

  describe('$identify', () => {
    const identify = wireEvent({ name: '$identify', anon_id: 'a-browser', user_id: 'user-1' });

    it('links the anonymous id to the user in the project object, in the EU jurisdiction, and writes the event row', async () => {
      const testEnv = makeEnv();
      await call(testEnv, { body: consented([identify]) });

      expect(testEnv.identities.sent).toEqual([
        { workspace_id: 'ws_test_workspace', project_id: PROJECT_ID, anon_id: 'a-browser', user_id: 'user-1', ts: '2026-10-27T11:59:58.000Z' },
      ]);
      expect(testEnv.projects.jurisdictions).toContain('eu');
      expect(await testEnv.projects.get(PROJECT_ID).getPerson('a-browser')).toMatchObject({ userId: 'user-1' });
      expect(testEnv.stream.sent.map((row) => row.name)).toEqual(['$identify']);
    });

    it('is ignored without consent', async () => {
      const testEnv = makeEnv();
      await call(testEnv, { body: wireBatch({ consent: false, events: [identify] }) });

      expect(testEnv.identities.sent).toEqual([]);
      expect(await testEnv.projects.get(PROJECT_ID).hasIdentifiedUsers()).toBe(false);
    });

    it('is ignored when the link is incomplete', async () => {
      const testEnv = makeEnv();
      await call(testEnv, { body: consented([wireEvent({ name: '$identify', user_id: 'user-1', anon_id: undefined })]) });
      expect(testEnv.identities.sent).toEqual([]);
    });

    it('is still applied when the events stream refuses the rows', async () => {
      const testEnv = makeEnv();
      testEnv.stream.send.mockRejectedValue(new Error('stream down'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      await call(testEnv, { body: consented([identify]) });

      expect(testEnv.identities.sent).toHaveLength(1);
      error.mockRestore();
    });
  });

  describe('people operations', () => {
    const ops: WirePeopleOp[] = [
      { op: 'set', user_id: 'user-1', ts: TS, props: { $email: 'Ada@Example.com', plan: 'pro' } },
      { op: 'increment', user_id: 'user-1', ts: TS, props: { logins: 1 } },
    ];

    it('are applied with consent', async () => {
      const testEnv = makeEnv();
      const res = await call(testEnv, { body: consented([wireEvent()], { people: ops }) });

      expect(res.status).toBe(204);
      expect(await testEnv.projects.get(PROJECT_ID).getPerson('user-1')).toMatchObject({
        email: 'ada@example.com',
        properties: { plan: 'pro', logins: 1 },
      });
      expect(testEnv.people.sent).toHaveLength(1);
    });

    it('are ignored without consent', async () => {
      const testEnv = makeEnv();
      await call(testEnv, { body: wireBatch({ consent: false, people: ops }) });

      expect(await testEnv.projects.get(PROJECT_ID).hasIdentifiedUsers()).toBe(false);
      expect(testEnv.people.sent).toEqual([]);
      expect(await testEnv.projects.get(PROJECT_ID).getPerson('user-1')).toBeNull();
    });

    it('cost only the unreadable operation', async () => {
      const testEnv = makeEnv();
      const res = await call(testEnv, { body: { ...consented([wireEvent()]), people: [{ op: 'set', user_id: '', ts: TS, props: {} }, ...ops] } });

      expect(res.status).toBe(204);
      expect((await testEnv.projects.get(PROJECT_ID).getPerson('user-1'))?.properties.plan).toBe('pro');
    });

    it('do nothing, with one warning, when the project object is not bound', async () => {
      const testEnv = makeEnv();
      delete (testEnv.env as { PANEL_PROJECT?: unknown }).PANEL_PROJECT;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const first = await call(testEnv, { body: consented([wireEvent()], { people: ops }) });
      await call(testEnv, { body: consented([wireEvent({ event_id: 'evt-bbbbbbbb' })], { people: ops }) });

      expect(first.status).toBe(204);
      expect(testEnv.stream.sent).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });
  });

  describe('the live view', () => {
    it('sends the session to the project object', async () => {
      const testEnv = makeEnv();
      await call(testEnv, { body: consented([wireEvent({ url: 'https://shop.example.com/pricing', title: 'Pricing' })]) });

      const live = await testEnv.projects.get(PROJECT_ID).live();
      expect(live.visitors).toBe(1);
      expect(live.sessions[0]).toMatchObject({ sessionId: 's-browser', distinctId: 'a-browser', path: '/pricing', title: 'Pricing', country: 'NL', deviceType: 'desktop', pageviews: 1 });
    });

    it('uses the cookieless id when there is no session', async () => {
      const testEnv = makeEnv();
      await call(testEnv);

      const [session] = (await testEnv.projects.get(PROJECT_ID).live()).sessions;
      expect(session!.sessionId).toMatch(/^ck_/);
    });

    it('sends the first batch at once and collects the following ones until the interval has passed', async () => {
      const testEnv = makeEnv();
      const touch = vi.spyOn(testEnv.projects.get(PROJECT_ID), 'touchLive');
      const page = (id: string, path: string) =>
        call(testEnv, { body: consented([wireEvent({ event_id: id, url: `https://shop.example.com${path}` })]) });

      await page('evt-aaaaaaaa', '/');
      await page('evt-bbbbbbbb', '/a');
      await page('evt-cccccccc', '/b');
      expect(touch).toHaveBeenCalledTimes(1);

      vi.setSystemTime(NOW + LIVE_FLUSH_INTERVAL_MS);
      await page('evt-dddddddd', '/c');

      expect(touch).toHaveBeenCalledTimes(2);
      expect(touch.mock.calls[1]![0].map((t) => t.path)).toEqual(['/a', '/b', '/c']);
      const [session] = (await testEnv.projects.get(PROJECT_ID).live()).sessions;
      expect(session).toMatchObject({ path: '/c', pageviews: 4 });
    });

    it('leaves leave-beacons and excluded pages out', async () => {
      const testEnv = makeEnv(projectRecord({ settings: { ...projectRecord().settings, excludedUrls: ['/admin/*'] } }));
      await call(testEnv, {
        body: consented([
          wireEvent({ name: '$pageleave', scroll_depth: 10 }),
          wireEvent({ event_id: 'evt-bbbbbbbb', url: 'https://shop.example.com/admin/users' }),
        ]),
      });

      expect((await testEnv.projects.get(PROJECT_ID).live()).sessions).toEqual([]);
    });
  });

  describe('quota', () => {
    const blocked = (state: string) => {
      const testEnv = makeEnv();
      testEnv.kv.store.set(quotaKvKey('ws_test_workspace'), state);
      return testEnv;
    };

    it('drops events with a 204 when the workspace is events_blocked', async () => {
      const testEnv = blocked('events_blocked');
      const res = await call(testEnv);

      expect(res.status).toBe(204);
      expect(testEnv.stream.sent).toEqual([]);
      expect((await testEnv.usage.get('ws_test_workspace').month('2026-10')).events).toBe(0);
    });

    it('keeps accepting events when only replays are blocked, or the state is unknown', async () => {
      for (const state of ['replay_blocked', 'ok', 'something-else']) {
        resetIsolateState();
        const testEnv = blocked(state);
        await call(testEnv);
        expect(testEnv.stream.sent, state).toHaveLength(1);
      }
    });

    it('remembers the state for a minute per isolate, then asks again', async () => {
      const testEnv = blocked('ok');
      await call(testEnv);
      testEnv.kv.store.set(quotaKvKey('ws_test_workspace'), 'events_blocked');

      await call(testEnv, { body: wireBatch({ events: [wireEvent({ event_id: 'evt-bbbbbbbb' })] }) });
      expect(testEnv.stream.sent).toHaveLength(2);

      vi.setSystemTime(NOW + 61 * 1000);
      await call(testEnv, { body: wireBatch({ events: [wireEvent({ event_id: 'evt-cccccccc' })] }) });
      expect(testEnv.stream.sent).toHaveLength(2);
    });

    it('keeps accepting events when the quota lookup fails', async () => {
      const testEnv = makeEnv();
      const get = testEnv.kv.get as unknown as ReturnType<typeof vi.fn>;
      const original = get.getMockImplementation()!;
      get.mockImplementation(async (key: string, ...rest: unknown[]) => {
        if (key.startsWith('panel:quota:')) throw new Error('kv down');
        return (original as (...args: unknown[]) => Promise<string | null>)(key, ...rest);
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      await call(testEnv);

      expect(testEnv.stream.sent).toHaveLength(1);
      error.mockRestore();
    });
  });

  describe('rate limiting', () => {
    it('answers 429 over the limit, before reading the body or asking KV', async () => {
      const testEnv = makeEnv(projectRecord(), { limits: { events: 2 } });

      expect((await call(testEnv)).status).toBe(204);
      expect((await call(testEnv)).status).toBe(204);
      const kvGet = vi.mocked(testEnv.kv.get as unknown as (key: string) => Promise<string | null>);
      const kvReads = kvGet.mock.calls.length;
      const res = await call(testEnv, { body: '{not json' });

      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('10');
      expect(await res.json()).toEqual({ error: { code: 'rate_limited', message: 'Too many requests' } });
      expect(kvGet.mock.calls).toHaveLength(kvReads);
    });

    it('counts per client and never passes the address on', async () => {
      const testEnv = makeEnv(projectRecord(), { limits: { events: 1 } });
      await call(testEnv, { headers: { 'CF-Connecting-IP': '203.0.113.7' } });
      await call(testEnv, { headers: { 'CF-Connecting-IP': '198.51.100.9' } });

      const limiter = testEnv.env.EVENTS_RATE_LIMIT as unknown as { calls: Map<string, number> };
      expect(limiter.calls.size).toBe(2);
      for (const key of limiter.calls.keys()) {
        expect(key).toMatch(/^[0-9a-f]{16}$/);
        expect(key).not.toContain('203.0.113');
      }
    });

    it('does not limit a request that has no address, or when the limiter fails', async () => {
      const testEnv = makeEnv(projectRecord(), { limits: { events: 0 } });
      const noAddress = await call(testEnv, { headers: { 'CF-Connecting-IP': '' } });
      expect(noAddress.status).toBe(204);

      const failing = makeEnv();
      (failing.env as { EVENTS_RATE_LIMIT?: unknown }).EVENTS_RATE_LIMIT = { limit: async () => { throw new Error('limiter down'); } };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect((await call(failing)).status).toBe(204);
      warn.mockRestore();
    });
  });

  it('keeps the token check where it was', async () => {
    const testEnv = makeEnv(null);
    expect((await call(testEnv, { body: wireBatch({ token: TOKEN }) })).status).toBe(404);
  });
});
