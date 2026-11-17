/**
 * Super properties, first touch, groups, `apiHost` and the id getters: what
 * every event carries besides its own properties, and what the browser keeps.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as domain from '../../../domains/panel/src/wire';
import { buildBatches } from './batch';
import { createClient } from './client';
import { stateKey } from './storage';
import { FIRST_TOUCH, HOST, installNetwork, onCleanup, resetPage, setup, TOKEN } from './test/harness';
import type { WireEvent } from './wire';

afterEach(resetPage);

const byName = (events: WireEvent[], name: string) => events.filter((e) => e.name === name);
const stored = () => JSON.parse(localStorage.getItem(stateKey(TOKEN)) || 'null') as Record<string, unknown> | null;

describe('super properties', () => {
  it('go on every later event, the event’s own properties winning; registerOnce keeps what is set', async () => {
    const { client, net } = setup({ consentMode: 'none' });
    client.api.register({ plan: 'pro', app: 'web', $bad: 1 });
    client.api.registerOnce({ plan: 'free', tier: 2 });
    client.api.track('Clicked', { app: 'mobile' });
    client.api.unregister('tier');
    client.api.track('Again');
    await client.api.flush();

    const events = await net.events();
    expect(byName(events, 'Clicked')[0].props).toEqual({ app: 'mobile', plan: 'pro', tier: 2, ...FIRST_TOUCH });
    expect(byName(events, 'Again')[0].props).toEqual({ plan: 'pro', app: 'web', ...FIRST_TOUCH });
    expect(stored()?.p).toEqual({ plan: 'pro', app: 'web' });
  });

  it('stay in memory before consent, are kept after it, and go on reset()', async () => {
    const { client, net } = setup({ consentMode: 'required' });
    client.api.register({ plan: 'pro' });
    client.api.track('Before');
    expect(stored()).toBeNull();

    client.api.consent.grant();
    expect(stored()?.p).toEqual({ plan: 'pro' });

    client.api.reset();
    client.api.track('After reset');
    await client.api.flush();
    const events = await net.events();
    expect(byName(events, 'Before')[0].props).toMatchObject({ plan: 'pro' });
    expect(byName(events, 'After reset')[0].props).toEqual(FIRST_TOUCH);
    expect(stored()?.p).toEqual({});
  });
});

describe('first touch', () => {
  it('records the first referrer (without its query), landing path and UTM tags, once, and puts them on the profile', async () => {
    history.replaceState(null, '', '/pricing?utm_source=news&utm_campaign=launch&token=x');
    Object.defineProperty(document, 'referrer', { value: 'https://www.google.com/search?q=secret', configurable: true });
    onCleanup(() => Object.defineProperty(document, 'referrer', { value: '', configurable: true }));
    const { client, net } = setup({ consentMode: 'none' });
    client.api.identify('user-1');
    await client.api.flush();

    const first = {
      $initial_referrer: 'https://www.google.com/search',
      $initial_referring_domain: 'www.google.com',
      $initial_landing_path: '/pricing',
      $initial_utm_source: 'news',
      $initial_utm_campaign: 'launch',
    };
    const [sent] = await net.sent();
    expect(sent.batch.events[0].props).toEqual(first);
    expect(sent.batch.people).toEqual([expect.objectContaining({ op: 'set_once', user_id: 'user-1', props: first })]);
    expect(stored()?.f).toEqual(first);
  });

  it('keeps the stored first touch on a later page', async () => {
    localStorage.setItem(stateKey(TOKEN), JSON.stringify({ a: 'a_1', s: 's_1', t: Date.now(), g: 0, f: { $initial_referrer: 'https://ads.example/', $initial_landing_path: '/landing' } }));
    const { client, net } = setup({ consentMode: 'none' });
    await client.api.flush();
    expect((await net.events())[0].props).toEqual({ $initial_referrer: 'https://ads.example/', $initial_landing_path: '/landing' });
  });
});

describe('groups', () => {
  it('put $group_<type> on later events and send the profile operations once consent is given', async () => {
    const { client, net } = setup({ consentMode: 'none' });
    client.api.group('company', 'acme', { name: 'Acme', plan: 'pro' });
    client.api.group('workspace', 42);
    client.api.groups.set_once('company', 'acme', { founded: 1999 });
    client.api.groups.unset('company', 'acme', 'plan');
    client.api.track('Invited');
    await client.api.flush();

    const [sent] = await net.sent();
    expect(sent.batch.consent).toBe(true);
    expect(byName(sent.batch.events, 'Invited')[0].props).toMatchObject({ $group_company: 'acme', $group_workspace: '42' });
    expect(sent.batch.groups).toEqual([
      { op: 'set', type: 'company', key: 'acme', props: { $name: 'Acme', plan: 'pro' } },
      { op: 'set', type: 'workspace', key: '42', props: {} },
      { op: 'set_once', type: 'company', key: 'acme', props: { founded: 1999 } },
      { op: 'unset', type: 'company', key: 'acme', keys: ['plan'] },
    ]);
    expect(domain.parseEventBatch(sent.batch)).toMatchObject({ ok: true, groupsDropped: 0 });
    expect(stored()?.r).toEqual({ company: 'acme', workspace: '42' });
  });

  it('keep groups in memory without consent: no $group_ properties, no profile operations, nothing stored', async () => {
    const { client, net } = setup({ consentMode: 'required' });
    client.api.group('company', 'acme', { name: 'Acme' });
    client.api.track('Before consent');
    await client.api.flush();

    const [sent] = await net.sent();
    expect(sent.batch.consent).toBe(false);
    expect(byName(sent.batch.events, 'Before consent')[0].props ?? {}).not.toHaveProperty('$group_company');
    expect(sent.batch.groups ?? []).toEqual([]);
    expect(stored()).toBeNull();

    // After consent the membership set earlier goes with the events.
    client.api.consent.grant();
    client.api.track('After consent');
    await client.api.flush();
    const after = (await net.events()).filter((e) => e.name === 'After consent');
    expect(after[0].props).toMatchObject({ $group_company: 'acme' });
  });

  it('refuse a bad type or key, and resetGroups() and reset() leave every group', async () => {
    const { client, net } = setup({ consentMode: 'none' });
    client.api.group('Company', 'acme');
    client.api.group('team', '');
    client.api.group('team', 'red');
    expect(stored()?.r).toEqual({ team: 'red' });
    client.api.track('In team');
    client.api.resetGroups();
    client.api.track('No team');
    await client.api.flush();

    const events = await net.events();
    expect(byName(events, 'In team')[0].props).toMatchObject({ $group_team: 'red' });
    expect(byName(events, 'No team')[0].props).not.toHaveProperty('$group_team');
    expect((await net.sent())[0].batch.groups?.map((op) => op.type)).toEqual(['team']);
  });
});

describe('apiHost and ids', () => {
  it('sends events to apiHost and answers the ids only with consent', async () => {
    const net = installNetwork();
    const client = createClient({ token: TOKEN, host: HOST, apiHost: 'https://shop.example.com/wp', webVitals: false });
    onCleanup(() => client.destroy());
    client.start({ consentMode: 'required' });
    expect(client.api.getDistinctId()).toBeNull();
    expect(client.api.getSessionId()).toBeNull();

    client.api.consent.grant();
    expect(client.api.getDistinctId()).toMatch(/^a_/);
    client.api.identify('user-9');
    expect(client.api.getDistinctId()).toBe('user-9');
    expect(client.api.getSessionId()).toMatch(/^s_/);
    await client.api.flush();
    expect((await net.sent()).every((s) => s.url === 'https://shop.example.com/wp/e')).toBe(true);
  });
});

describe('batches', () => {
  it('carry group operations with or without consent, at most 50 per batch', () => {
    const groups = Array.from({ length: 60 }, (_, i) => ({ op: 'set' as const, type: 'company', key: `c${i}`, props: {} }));
    const [batch] = buildBatches({ token: TOKEN, consent: false, events: [{ name: 'X', url: 'https://shop.example.com/' }], groups });
    expect(batch.groups).toHaveLength(50);
    expect(batch.people).toBeUndefined();
    expect(domain.parseEventBatch(batch).ok).toBe(true);
  });
});
