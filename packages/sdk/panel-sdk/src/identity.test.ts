import { afterEach, describe, expect, it } from 'vitest';
import { stateKey, type VisitorState } from './storage';
import { resetPage, setup, TOKEN } from './test/harness';
import type { WireEvent } from './wire';

afterEach(resetPage);

function stored(): VisitorState | null {
  const raw = localStorage.getItem(stateKey(TOKEN));
  return raw ? (JSON.parse(raw) as VisitorState) : null;
}

const byName = (events: WireEvent[], name: string) => events.filter((e) => e.name === name);

describe('identify()', () => {
  it('without consent sends no link and no user id, and stores nothing', async () => {
    const { client, net } = setup({ consentMode: 'required' });
    client.api.identify('user-42');
    client.api.track('After');
    await client.api.flush();
    const events = await net.events();
    expect(byName(events, '$identify')).toHaveLength(0);
    expect(events.every((e) => e.user_id === undefined)).toBe(true);
    expect(localStorage).toHaveLength(0);
  });

  it('with consent links the anonymous id, then sends user_id on every event and keeps it', async () => {
    const { client, net } = setup({ consentMode: 'none' });
    client.api.track('Before');
    client.api.identify(' user-42 ');
    client.api.track('After');
    await client.api.flush();

    const events = await net.events();
    const [link] = byName(events, '$identify');
    expect(link).toMatchObject({ user_id: 'user-42', anon_id: stored()!.a, session_id: stored()!.s });
    expect(byName(events, 'Before')[0].user_id).toBeUndefined();
    expect(byName(events, 'After')[0].user_id).toBe('user-42');
    expect(stored()).toMatchObject({ u: 'user-42' });
    client.destroy();

    // The next page load: still identified, no second link for the same user.
    const next = setup({ consentMode: 'none' });
    next.client.api.identify('user-42');
    await next.client.api.flush();
    const later = await next.net.events();
    expect(byName(later, '$identify')).toHaveLength(0);
    expect(later[0]).toMatchObject({ name: '$pageview', user_id: 'user-42' });
  });

  it('a different user on the same browser starts a new anonymous id first', async () => {
    const { client, net } = setup({ consentMode: 'none' });
    client.api.identify('ann');
    const annAnon = stored()!.a;
    client.api.identify('bob');
    await client.api.flush();
    const links = byName(await net.events(), '$identify');
    expect(links.map((e) => e.user_id)).toEqual(['ann', 'bob']);
    expect(links[0].anon_id).toBe(annAnon);
    expect(links[1].anon_id).not.toBe(annAnon);
    expect(links[1].session_id).not.toBe(links[0].session_id);
  });

  it('drops user ids the collector refuses', async () => {
    const { client, net } = setup({ consentMode: 'none' });
    client.api.identify('');
    client.api.identify('x'.repeat(256));
    client.api.identify('line\nbreak');
    await client.api.flush();
    expect(byName(await net.events(), '$identify')).toHaveLength(0);
    expect(stored()!.u).toBeUndefined();
  });

  it('sends nothing from an excluded page', async () => {
    history.replaceState(null, '', '/account/login');
    const { client, net } = setup({ consentMode: 'none', excludedUrls: ['/account/*'] });
    client.api.identify('user-42');
    history.pushState(null, '', '/home');
    client.api.identify('user-42');
    await client.api.flush();
    const links = byName(await net.events(), '$identify');
    expect(links.map((e) => new URL(e.url).pathname)).toEqual(['/home']);
  });
});

describe('reset()', () => {
  it('forgets the user and starts a new anonymous id and session', async () => {
    const { client, net } = setup({ consentMode: 'none' });
    client.api.identify('user-42');
    const before = stored()!;
    client.api.reset();
    client.api.track('Logged out');
    await client.api.flush();

    const [after] = byName(await net.events(), 'Logged out');
    expect(after.user_id).toBeUndefined();
    expect(after.anon_id).not.toBe(before.a);
    expect(after.session_id).not.toBe(before.s);
    expect(stored()!.u).toBeUndefined();
    expect(stored()!.g).toBe(before.g);
  });

  it('does nothing without consent', async () => {
    const { client, net } = setup({ consentMode: 'required' });
    client.api.reset();
    await client.api.flush();
    expect(localStorage).toHaveLength(0);
    expect(await net.names()).toEqual(['$pageview']);
  });
});

describe('people', () => {
  it('queues profile operations for the identified user, with email and name as profile fields', async () => {
    const { client, net } = setup({ consentMode: 'none' });
    client.api.identify('user-42');
    client.api.people.set({ email: 'ann@example.com', name: 'Ann', plan: 'pro', bad: { nested: 1 } });
    client.api.people.set_once({ first_seen_plan: 'free' });
    client.api.people.unset('trial');
    client.api.people.unset(['email', 'coupon']);
    client.api.people.increment('logins');
    client.api.people.increment('credits', -5);
    client.api.people.increment({ seats: 2, plan: 'x' as unknown as number });
    await client.api.flush();

    const [sent] = await net.sent();
    expect(sent.batch.consent).toBe(true);
    expect(sent.batch.people?.map(({ ts: _ts, ...op }) => op)).toEqual([
      { op: 'set', user_id: 'user-42', props: { $email: 'ann@example.com', $name: 'Ann', plan: 'pro' } },
      { op: 'set_once', user_id: 'user-42', props: { first_seen_plan: 'free' } },
      { op: 'unset', user_id: 'user-42', keys: ['trial'] },
      { op: 'unset', user_id: 'user-42', keys: ['$email', 'coupon'] },
      { op: 'increment', user_id: 'user-42', props: { logins: 1 } },
      { op: 'increment', user_id: 'user-42', props: { credits: -5 } },
      { op: 'increment', user_id: 'user-42', props: { seats: 2 } },
    ]);
    for (const op of sent.batch.people ?? []) expect(new Date(op.ts).toISOString()).toBe(op.ts);
  });

  it('are dropped without consent or before identify()', async () => {
    const consentless = setup({ consentMode: 'required' });
    consentless.client.api.people.set({ plan: 'pro' });
    await consentless.client.api.flush();
    expect((await consentless.net.sent()).every((s) => s.batch.people === undefined)).toBe(true);
    consentless.client.destroy();

    const anonymous = setup({ consentMode: 'none' });
    anonymous.client.api.people.set({ plan: 'pro' });
    anonymous.client.api.track('Something');
    await anonymous.client.api.flush();
    expect((await anonymous.net.sent()).every((s) => s.batch.people === undefined)).toBe(true);
  });

  it('wait for the next batch of events instead of going alone', async () => {
    const { client, net } = setup({ consentMode: 'none' });
    client.api.identify('user-42');
    await client.api.flush();
    client.api.people.set({ plan: 'pro' });
    await client.api.flush();
    expect(await net.sent()).toHaveLength(1);

    client.api.track('Upgraded');
    await client.api.flush();
    const sent = await net.sent();
    expect(sent).toHaveLength(2);
    expect(sent[1].batch.events.map((e) => e.name)).toEqual(['Upgraded']);
    expect(sent[1].batch.people).toHaveLength(1);
  });

  it('a revoke drops operations still waiting and the user id', async () => {
    const { client, net } = setup({ consentMode: 'required' });
    client.api.consent.grant();
    client.api.identify('user-42');
    await client.api.flush();
    client.api.people.set({ plan: 'pro' });
    client.api.consent.revoke();
    client.api.track('Anonymous again');
    await client.api.flush();
    const sent = await net.sent();
    expect(sent.every((s) => s.batch.people === undefined)).toBe(true);
    expect(byName(await net.events(), 'Anonymous again')[0].user_id).toBeUndefined();
    expect(localStorage).toHaveLength(0);
  });
});
