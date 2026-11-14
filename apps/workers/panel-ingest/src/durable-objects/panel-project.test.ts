import type { PanelPeopleOp, PanelPropertyValue } from '@weldsuite/panel-domain/project-object';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import { resetWarnings } from '../lib/warn';
import { NOW, PROJECT_ID, WORKSPACE_ID, fakePipeline, fakeSqlContext } from '../testing/fakes';
import { PanelProject } from './panel-project';

const SCOPE = { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID };
const ISO = new Date(NOW).toISOString();
const MINUTE = 60 * 1000;

function create(bindings: Partial<Pick<Env, 'PANEL_IDENTITIES' | 'PANEL_PEOPLE'>> | 'none' = {}) {
  const identities = fakePipeline<Parameters<NonNullable<Env['PANEL_IDENTITIES']>['send']>[0][number]>();
  const people = fakePipeline<Parameters<NonNullable<Env['PANEL_PEOPLE']>['send']>[0][number]>();
  const state = fakeSqlContext();
  const env = (bindings === 'none' ? {} : { PANEL_IDENTITIES: identities, PANEL_PEOPLE: people, ...bindings }) as unknown as Env;
  return { project: new PanelProject(state.ctx, env), identities, people, ...state };
}

const set = (userId: string, props: Record<string, PanelPropertyValue>): PanelPeopleOp => ({ op: 'set', userId, ts: ISO, props });

describe('PanelProject', () => {
  beforeEach(() => {
    resetWarnings();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  describe('identify', () => {
    it('links an anonymous id to a user, writes the link and creates the profile', async () => {
      const { project, identities, people } = create();

      expect(await project.identify({ ...SCOPE, anonId: 'a-1', userId: 'u-1', ts: ISO })).toEqual({ linked: true });

      expect(identities.sent).toEqual([{ workspace_id: WORKSPACE_ID, project_id: PROJECT_ID, anon_id: 'a-1', user_id: 'u-1', ts: ISO }]);
      expect(people.sent).toHaveLength(1);
      expect(people.sent[0]).toMatchObject({ user_id: 'u-1', version: 1, deleted: false, properties: JSON.stringify({ $created: ISO }) });
      expect(await project.getPerson('u-1')).toMatchObject({ userId: 'u-1', anonIds: ['a-1'], firstSeen: ISO });
      expect(await project.hasIdentifiedUsers()).toBe(true);
    });

    it('lets one user own several anonymous ids and finds the person by any of them', async () => {
      const { project, identities } = create();
      await project.identify({ ...SCOPE, anonId: 'a-1', userId: 'u-1', ts: ISO });
      await project.identify({ ...SCOPE, anonId: 'a-2', userId: 'u-1', ts: ISO });

      expect(identities.sent).toHaveLength(2);
      expect((await project.getPerson('a-2'))?.anonIds).toEqual(['a-1', 'a-2']);
    });

    it('keeps the first link: an anonymous id never moves to another user', async () => {
      const { project, identities } = create();
      await project.identify({ ...SCOPE, anonId: 'a-1', userId: 'u-1', ts: ISO });

      expect(await project.identify({ ...SCOPE, anonId: 'a-1', userId: 'u-2', ts: ISO })).toEqual({ linked: false });
      expect(await project.getPerson('u-2')).toBeNull();
      expect((await project.getPerson('a-1'))?.userId).toBe('u-1');
      expect(identities.sent).toHaveLength(1);
    });

    it('is idempotent for the same link: no second row', async () => {
      const { project, identities, people } = create();
      await project.identify({ ...SCOPE, anonId: 'a-1', userId: 'u-1', ts: ISO });

      expect(await project.identify({ ...SCOPE, anonId: 'a-1', userId: 'u-1', ts: ISO })).toEqual({ linked: true });
      expect(identities.sent).toHaveLength(1);
      expect(people.sent).toHaveLength(1);
    });

    it('does not touch an existing profile beyond its last-seen time', async () => {
      const { project, people } = create();
      await project.applyPeopleOps({ ...SCOPE, ops: [set('u-1', { $email: 'a@b.com' })] });
      people.sent.length = 0;

      await project.identify({ ...SCOPE, anonId: 'a-1', userId: 'u-1', ts: ISO });

      expect(people.sent).toEqual([]);
      expect((await project.getPerson('u-1'))?.email).toBe('a@b.com');
    });

    it('ignores a missing id and ids that were erased', async () => {
      const { project } = create();
      expect(await project.identify({ ...SCOPE, anonId: '', userId: 'u-1', ts: ISO })).toEqual({ linked: false });

      await project.erase({ ...SCOPE, userIdOrAnonId: 'u-9' });
      expect(await project.identify({ ...SCOPE, anonId: 'a-1', userId: 'u-9', ts: ISO })).toEqual({ linked: false });
      expect(await project.identify({ ...SCOPE, anonId: 'u-9', userId: 'u-1', ts: ISO })).toEqual({ linked: false });
      expect(await project.hasIdentifiedUsers()).toBe(false);
    });

    it('warns once and writes no rows when the streams are not bound, keeping its state', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { project } = create('none');

      await project.identify({ ...SCOPE, anonId: 'a-1', userId: 'u-1', ts: ISO });
      await project.identify({ ...SCOPE, anonId: 'a-2', userId: 'u-2', ts: ISO });

      expect(warn).toHaveBeenCalledTimes(2); // identities_v1 and people_v1, once each
      expect(await project.getPerson('a-2')).toMatchObject({ userId: 'u-2' });
      warn.mockRestore();
    });

    it('survives a failing stream', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { project, identities } = create();
      identities.send.mockRejectedValue(new Error('stream down'));

      await expect(project.identify({ ...SCOPE, anonId: 'a-1', userId: 'u-1', ts: ISO })).resolves.toEqual({ linked: true });
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });
  });

  describe('applyPeopleOps', () => {
    it('creates a profile with set, lower-casing the email, and writes a people row', async () => {
      const { project, people } = create();

      await project.applyPeopleOps({ ...SCOPE, ops: [set('u-1', { $email: ' Ada@Example.COM ', $name: 'Ada', plan: 'pro', seats: 3 })] });

      const person = await project.getPerson('u-1');
      expect(person).toMatchObject({ userId: 'u-1', email: 'ada@example.com', name: 'Ada' });
      expect(person?.properties).toEqual({ $created: ISO, $email: 'ada@example.com', $name: 'Ada', plan: 'pro', seats: 3 });
      expect(people.sent).toHaveLength(1);
      expect(people.sent[0]).toMatchObject({ workspace_id: WORKSPACE_ID, project_id: PROJECT_ID, user_id: 'u-1', deleted: false });
      expect(JSON.parse(people.sent[0]!.properties)).toEqual(person?.properties);
    });

    it('set overwrites, set_once keeps, unset removes, increment adds', async () => {
      const { project } = create();
      await project.applyPeopleOps({ ...SCOPE, ops: [set('u-1', { plan: 'free', logins: 1, old: true })] });

      await project.applyPeopleOps({
        ...SCOPE,
        ops: [
          set('u-1', { plan: 'pro' }),
          { op: 'set_once', userId: 'u-1', ts: ISO, props: { plan: 'ignored', source: 'ads' } },
          { op: 'unset', userId: 'u-1', ts: ISO, keys: ['old', 'never-there'] },
          { op: 'increment', userId: 'u-1', ts: ISO, props: { logins: 2, visits: 5 } },
        ],
      });

      expect((await project.getPerson('u-1'))?.properties).toEqual({ $created: ISO, plan: 'pro', logins: 3, source: 'ads', visits: 5 });
    });

    it('treats increment on a non-number as starting from zero', async () => {
      const { project } = create();
      await project.applyPeopleOps({ ...SCOPE, ops: [set('u-1', { n: 'text' }), { op: 'increment', userId: 'u-1', ts: ISO, props: { n: 2 } }] });

      expect((await project.getPerson('u-1'))?.properties.n).toBe(2);
    });

    it('writes one row per profile and call, with a rising version across calls', async () => {
      const { project, people } = create();

      await project.applyPeopleOps({ ...SCOPE, ops: [set('u-1', { a: 1 }), set('u-1', { b: 2 }), set('u-2', { a: 1 })] });
      await project.applyPeopleOps({ ...SCOPE, ops: [set('u-1', { c: 3 })] });

      expect(people.sent.map((row) => row.user_id)).toEqual(['u-1', 'u-2', 'u-1']);
      const versions = people.sent.filter((row) => row.user_id === 'u-1').map((row) => row.version);
      expect(versions[1]).toBeGreaterThan(versions[0]!);
      expect(JSON.parse(people.sent[0]!.properties)).toMatchObject({ a: 1, b: 2 });
    });

    it('writes no row when nothing changed', async () => {
      const { project, people } = create();
      await project.applyPeopleOps({ ...SCOPE, ops: [set('u-1', { plan: 'pro' })] });
      people.sent.length = 0;

      await project.applyPeopleOps({ ...SCOPE, ops: [set('u-1', { plan: 'pro' }), { op: 'unset', userId: 'u-1', ts: ISO, keys: ['nope'] }] });

      expect(people.sent).toEqual([]);
    });

    it('refuses a prototype key, a non-string email and more than 200 properties', async () => {
      const { project } = create();
      const many = Object.fromEntries(Array.from({ length: 210 }, (_, i) => [`k${i}`, i]));

      await project.applyPeopleOps({
        ...SCOPE,
        ops: [set('u-1', JSON.parse('{"__proto__": 1, "$email": 5, "ok": true}') as Record<string, PanelPropertyValue>), set('u-1', many)],
      });

      const person = await project.getPerson('u-1');
      expect(person?.email).toBeNull();
      expect(person?.properties.ok).toBe(true);
      expect(Object.keys(person?.properties ?? {})).not.toContain('__proto__');
      expect(Object.keys(person?.properties ?? {}).length).toBeLessThanOrEqual(200);
    });

    it('ignores operations on erased ids', async () => {
      const { project, people } = create();
      await project.erase({ ...SCOPE, userIdOrAnonId: 'u-1' });
      people.sent.length = 0;

      await project.applyPeopleOps({ ...SCOPE, ops: [set('u-1', { a: 1 })] });

      expect(await project.getPerson('u-1')).toBeNull();
      expect(people.sent).toEqual([]);
    });
  });

  describe('searching people', () => {
    async function seeded() {
      const state = create();
      for (let i = 1; i <= 5; i += 1) {
        vi.setSystemTime(NOW + i * MINUTE);
        await state.project.applyPeopleOps({
          ...SCOPE,
          ops: [set(`user-${i}`, { $email: `person${i}@example.com`, $name: i === 3 ? 'Grace Hopper' : `Person ${i}` })],
        });
      }
      return state;
    }

    it('lists newest first with cursor pagination', async () => {
      const { project } = await seeded();

      const first = await project.listPeople({ limit: 2 });
      expect(first.people.map((p) => p.userId)).toEqual(['user-5', 'user-4']);
      expect(first.totalCount).toBe(5);
      expect(first.cursor).not.toBeNull();

      const second = await project.listPeople({ limit: 2, cursor: first.cursor });
      expect(second.people.map((p) => p.userId)).toEqual(['user-3', 'user-2']);

      const third = await project.listPeople({ limit: 2, cursor: second.cursor });
      expect(third.people.map((p) => p.userId)).toEqual(['user-1']);
      expect(third.cursor).toBeNull();
    });

    it('pages through people with the same last-seen time without losing or repeating any', async () => {
      const { project } = create();
      await project.applyPeopleOps({ ...SCOPE, ops: ['a', 'b', 'c', 'd'].map((id) => set(id, { x: 1 })) });

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await project.listPeople({ limit: 3, cursor });
        seen.push(...page.people.map((p) => p.userId));
        cursor = page.cursor;
      } while (cursor);

      expect(seen.sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('searches by email, name and user id, case-insensitively, counting only matches', async () => {
      const { project } = await seeded();

      expect((await project.listPeople({ search: 'PERSON4@', limit: 10 })).people.map((p) => p.userId)).toEqual(['user-4']);
      expect((await project.listPeople({ search: 'hopper', limit: 10 })).people.map((p) => p.userId)).toEqual(['user-3']);
      const byId = await project.listPeople({ search: 'user-2', limit: 10 });
      expect(byId.people.map((p) => p.userId)).toEqual(['user-2']);
      expect(byId.totalCount).toBe(1);
      expect((await project.listPeople({ search: 'nobody', limit: 10 })).people).toEqual([]);
    });

    it('takes % and _ in a search literally', async () => {
      const { project } = await seeded();
      expect((await project.listPeople({ search: '%', limit: 10 })).people).toEqual([]);
      expect((await project.listPeople({ search: 'user_1', limit: 10 })).people).toEqual([]);
    });

    it('ignores a cursor it cannot read and clamps the limit', async () => {
      const { project } = await seeded();
      expect((await project.listPeople({ limit: 1000, cursor: 'garbage' })).people).toHaveLength(5);
      expect((await project.listPeople({ limit: 0 })).people).toHaveLength(1);
    });

    it('finds profiles by email, exactly and case-insensitively', async () => {
      const { project } = await seeded();
      expect((await project.findByEmail('Person2@Example.com')).map((p) => p.userId)).toEqual(['user-2']);
      expect(await project.findByEmail('person2@example')).toEqual([]);
    });
  });

  describe('the live view', () => {
    const touch = (overrides: Partial<Parameters<PanelProject['touchLive']>[0][number]> = {}) => ({
      sessionId: 's-1',
      distinctId: 'a-1',
      path: '/',
      title: 'Home',
      country: 'NL',
      deviceType: 'desktop' as const,
      ts: ISO,
      ...overrides,
    });

    it('keeps one entry per session and counts a new path as a page view', async () => {
      const { project } = create();
      await project.touchLive([touch(), touch({ ts: new Date(NOW + 1000).toISOString() }), touch({ path: '/pricing', title: 'Pricing', ts: new Date(NOW + 2000).toISOString() })]);

      const live = await project.live();
      expect(live.visitors).toBe(1);
      expect(live.sessions).toEqual([
        {
          sessionId: 's-1',
          distinctId: 'a-1',
          path: '/pricing',
          title: 'Pricing',
          country: 'NL',
          deviceType: 'desktop',
          ts: new Date(NOW + 2000).toISOString(),
          startedAt: ISO,
          pageviews: 2,
        },
      ]);
    });

    it('counts visitors, not sessions', async () => {
      const { project } = create();
      await project.touchLive([touch(), touch({ sessionId: 's-2' }), touch({ sessionId: 's-3', distinctId: 'a-2' })]);

      const live = await project.live();
      expect(live.visitors).toBe(2);
      expect(live.sessions).toHaveLength(3);
    });

    it('shows only the last five minutes and drops older sessions on the alarm', async () => {
      const { project, alarm, db } = create();
      await project.touchLive([touch()]);
      expect(alarm()).not.toBeNull();

      vi.setSystemTime(NOW + 6 * MINUTE);
      expect((await project.live()).sessions).toEqual([]);
      await project.alarm();
      expect(db.prepare('SELECT COUNT(*) AS n FROM live').all()).toEqual([{ n: 0 }]);
    });

    it('keeps the alarm going while sessions are left', async () => {
      const { project, alarm } = create();
      await project.touchLive([touch()]);
      vi.setSystemTime(NOW + 3 * MINUTE);
      await project.touchLive([touch({ sessionId: 's-2', ts: new Date(NOW + 3 * MINUTE).toISOString() })]);

      vi.setSystemTime(NOW + 6 * MINUTE);
      await project.alarm();

      expect((await project.live()).sessions.map((s) => s.sessionId)).toEqual(['s-2']);
      expect(alarm()).toBe(NOW + 6 * MINUTE + 5 * MINUTE);
    });

    it('leaves erased visitors out', async () => {
      const { project } = create();
      await project.erase({ ...SCOPE, userIdOrAnonId: 'a-1' });
      await project.touchLive([touch()]);
      expect((await project.live()).sessions).toEqual([]);
    });
  });

  describe('erase', () => {
    async function seeded() {
      const state = create();
      await state.project.identify({ ...SCOPE, anonId: 'a-1', userId: 'u-1', ts: ISO });
      await state.project.identify({ ...SCOPE, anonId: 'a-2', userId: 'u-1', ts: ISO });
      await state.project.applyPeopleOps({ ...SCOPE, ops: [set('u-1', { $email: 'ada@example.com' }), set('u-2', { $email: 'other@example.com' })] });
      await state.project.touchLive([
        { sessionId: 's-1', distinctId: 'u-1', path: '/', title: null, country: null, deviceType: null, ts: ISO },
        { sessionId: 's-2', distinctId: 'a-9', path: '/', title: null, country: null, deviceType: null, ts: ISO },
      ]);
      state.people.sent.length = 0;
      return state;
    }

    it('removes the profile, links and live entries of a user and records every id', async () => {
      const { project, people } = await seeded();

      const erasure = await project.erase({ ...SCOPE, userIdOrAnonId: 'u-1' });

      expect(erasure.userId).toBe('u-1');
      expect([...erasure.erasedIds].sort()).toEqual(['a-1', 'a-2', 'u-1']);
      expect(await project.getPerson('u-1')).toBeNull();
      expect(await project.getPerson('a-1')).toBeNull();
      expect(await project.hasIdentifiedUsers()).toBe(false);
      expect((await project.live()).sessions.map((s) => s.sessionId)).toEqual(['s-2']);
      expect(await project.erasedIds()).toEqual(['a-1', 'a-2', 'u-1']);
      expect(await project.findByEmail('ada@example.com')).toEqual([]);
      expect((await project.getPerson('u-2'))?.email).toBe('other@example.com');
      expect(people.sent).toHaveLength(1);
      expect(people.sent[0]).toMatchObject({ user_id: 'u-1', deleted: true, properties: '{}' });
    });

    it('resolves an anonymous id to its user', async () => {
      const { project } = await seeded();

      const erasure = await project.erase({ ...SCOPE, userIdOrAnonId: 'a-2' });

      expect(erasure.userId).toBe('u-1');
      expect(await project.getPerson('u-1')).toBeNull();
    });

    it('writes a deleted row with a higher version than the profile had', async () => {
      const { project, people } = await seeded();
      await project.applyPeopleOps({ ...SCOPE, ops: [set('u-1', { more: 1 })] });
      const lastProfileVersion = people.sent[people.sent.length - 1]!.version;

      await project.erase({ ...SCOPE, userIdOrAnonId: 'u-1' });

      expect(people.sent[people.sent.length - 1]!.version).toBeGreaterThan(lastProfileVersion);
    });

    it('records an unknown id without a user and without a people row', async () => {
      const { project, people } = await seeded();

      const erasure = await project.erase({ ...SCOPE, userIdOrAnonId: 'ck_visitor' });

      expect(erasure).toEqual({ userId: null, erasedIds: ['ck_visitor'] });
      expect(people.sent).toEqual([]);
      expect(await project.erasedIds()).toContain('ck_visitor');
    });

    it('is safe to repeat', async () => {
      const { project } = await seeded();
      await project.erase({ ...SCOPE, userIdOrAnonId: 'u-1' });

      await expect(project.erase({ ...SCOPE, userIdOrAnonId: 'u-1' })).resolves.toMatchObject({ erasedIds: ['u-1'] });
    });

    it('lets the maintenance job clear ids once the Iceberg rows are rewritten', async () => {
      const { project } = await seeded();
      await project.erase({ ...SCOPE, userIdOrAnonId: 'u-1' });

      await project.clearErased(['a-1', 'u-1']);

      expect(await project.erasedIds()).toEqual(['a-2']);
    });
  });
});
