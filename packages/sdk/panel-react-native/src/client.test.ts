import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeDevice, HOST, memoryStorage, setup, TOKEN } from './test/harness';
import type { PanelPlatform } from './platform';
import type { StorageAdapter } from './storage';
import type { WireEvent } from './wire';

const STATE = `weldpanel:${TOKEN}`;
const QUEUE = `weldpanel:${TOKEN}:queue`;
const NO_CONSENT_NEEDED = { config: { consentMode: 'none' } };

afterEach(() => {
  vi.useRealTimers();
});

function byName(events: WireEvent[], name: string): WireEvent {
  const e = events.find((x) => x.name === name);
  if (!e) throw new Error(`no ${name} in ${events.map((x) => x.name).join(', ')}`);
  return e;
}

describe('consent', () => {
  it('without consent: no ids, nothing stored, no profile or group operations', async () => {
    const { panel, idle, net, storage } = setup();
    panel.register({ plan: 'pro' });
    panel.identify('user-1');
    panel.people.set({ email: 'a@b.co' });
    panel.group('company', 'acme', { name: 'Acme' });
    panel.track('Viewed plans', { count: 3 });
    await panel.flush();
    await idle();

    expect(net.sent).toHaveLength(1);
    const { url, headers, batch } = net.sent[0];
    expect(url).toBe(`${HOST}/e`);
    expect(headers).toEqual({ 'Content-Type': 'text/plain' });
    expect(net.fetch).toHaveBeenCalledWith(`${HOST}/c/${TOKEN}`, { method: 'GET' });
    expect(batch).toMatchObject({ token: TOKEN, lib: 'mobile', consent: false });
    expect(batch.people).toBeUndefined();
    expect(batch.groups).toBeUndefined();
    expect(batch.events.map((e) => e.name)).toEqual(['$app_opened', 'Viewed plans']);
    for (const e of batch.events) {
      expect(e).not.toHaveProperty('anon_id');
      expect(e).not.toHaveProperty('session_id');
      expect(e).not.toHaveProperty('user_id');
    }
    expect(batch.events[1].props).toMatchObject({ count: 3, plan: 'pro' });
    expect(batch.events[1].props).not.toHaveProperty('$group_company');
    expect(storage?.writes).toEqual([]);
    expect(panel.getDistinctId()).toBeNull();
    expect(panel.getSessionId()).toBeNull();
  });

  it('with consent: ids on every event, identify, profiles, and everything kept for the next launch', async () => {
    const storage = memoryStorage();
    const { panel, idle, net } = setup({ storage });
    panel.consent.grant();
    panel.identify('user-42');
    panel.people.set({ email: 'jane@example.com', plan: 'pro' });
    panel.people.increment('visits');
    panel.register({ tier: 'gold' });
    panel.group('company', 'acme');
    await panel.flush();
    await idle();

    const batch = net.sent[0].batch;
    expect(batch.consent).toBe(true);
    expect(batch.events.map((e) => e.name)).toEqual(['$app_installed', '$identify', '$app_opened']);
    const anon = batch.events[0].anon_id;
    expect(anon).toMatch(/^a_/);
    for (const e of batch.events) {
      expect(e.anon_id).toBe(anon);
      expect(e.session_id).toMatch(/^s_/);
    }
    expect(batch.events[0]).not.toHaveProperty('user_id');
    expect(batch.events[1]).toMatchObject({ anon_id: anon, user_id: 'user-42' });
    expect(batch.people).toEqual([
      { op: 'set', user_id: 'user-42', ts: expect.any(String), props: { $email: 'jane@example.com', plan: 'pro' } },
      { op: 'increment', user_id: 'user-42', ts: expect.any(String), props: { visits: 1 } },
    ]);
    expect(panel.getDistinctId()).toBe('user-42');
    expect(panel.getSessionId()).toBe(batch.events[0].session_id);
    expect(storage.json(STATE)).toMatchObject({
      anonId: anon,
      userId: 'user-42',
      granted: true,
      superProps: { tier: 'gold' },
      groups: { company: 'acme' },
      appVersion: '2.1.0',
    });
    // Sent: nothing waits.
    expect(storage.data.has(QUEUE)).toBe(false);
    panel.shutdown();

    const next = setup({ storage });
    next.panel.track('Came back');
    await next.panel.flush();
    await next.idle();
    const events = next.net.events();
    expect(events.map((e) => e.name)).toEqual(['$app_opened', 'Came back']);
    expect(events[1]).toMatchObject({ anon_id: anon, user_id: 'user-42' });
    expect(events[1].props).toMatchObject({ tier: 'gold', $group_company: 'acme' });
    expect(next.net.sent[0].batch.consent).toBe(true);
  });

  it('a project that needs no consent gets ids without grant(), kept as not granted', async () => {
    const { panel, idle, net, storage } = setup({ network: NO_CONSENT_NEEDED });
    await panel.flush();
    await idle();
    expect(net.sent[0].batch.consent).toBe(true);
    expect(net.names()).toEqual(['$app_installed', '$app_opened']);
    expect(net.events()[0].anon_id).toMatch(/^a_/);
    expect(storage?.json(STATE)).toMatchObject({ granted: false });
  });

  it('offline at launch: a record kept without a grant still means no consent is needed', async () => {
    const storage = memoryStorage();
    const first = setup({ storage, network: NO_CONSENT_NEEDED });
    await first.panel.ready;
    const anon = first.panel.getDistinctId();
    first.panel.shutdown();
    await first.idle();

    const offline = setup({ storage, network: { config: 'error' } });
    await offline.panel.ready;
    expect(offline.panel.getDistinctId()).toBe(anon);
    offline.panel.shutdown();

    const fresh = setup({ storage: memoryStorage(), network: { config: 'error' } });
    await fresh.panel.ready;
    expect(fresh.panel.getDistinctId()).toBeNull();
    fresh.panel.shutdown();
  });

  it('ids kept from a project that now asks for consent are deleted', async () => {
    const storage = memoryStorage();
    const first = setup({ storage, network: NO_CONSENT_NEEDED });
    await first.panel.ready;
    first.panel.shutdown();
    await first.idle();
    expect(storage.data.has(STATE)).toBe(true);

    const now = setup({ storage });
    await now.idle();
    expect(now.panel.getDistinctId()).toBeNull();
    expect(storage.data.has(STATE)).toBe(false);
    now.panel.shutdown();
  });

  it('revoke() deletes what is stored and goes back to events without ids', async () => {
    const { panel, idle, net, storage } = setup();
    panel.consent.grant();
    panel.identify('user-1');
    await idle();
    expect(storage?.data.has(STATE)).toBe(true);
    panel.people.set({ plan: 'pro' });
    panel.consent.revoke();
    panel.track('After revoke');
    await panel.flush();
    await idle();

    expect(storage?.data.has(STATE)).toBe(false);
    expect(storage?.data.has(QUEUE)).toBe(false);
    expect(net.sent.every((s) => !s.batch.people)).toBe(true);
    const after = byName(net.events(), 'After revoke');
    expect(after).not.toHaveProperty('anon_id');
    expect(net.sent[net.sent.length - 1].batch.consent).toBe(false);
    expect(panel.getDistinctId()).toBeNull();
  });
});

describe('identity', () => {
  it('identify() with someone else starts a new anonymous id, so two people sharing a device do not merge', async () => {
    const { panel, idle, net } = setup({ network: NO_CONSENT_NEEDED });
    panel.identify('ann');
    panel.identify('ann');
    panel.identify('bob');
    await panel.flush();
    await idle();
    const identifies = net.events().filter((e) => e.name === '$identify');
    expect(identifies.map((e) => e.user_id)).toEqual(['ann', 'bob']);
    expect(identifies[0].anon_id).not.toBe(identifies[1].anon_id);
  });

  it('people calls need identify(); unset and increment take their short forms', async () => {
    const { panel, idle, net } = setup({ network: NO_CONSENT_NEEDED });
    await panel.ready;
    panel.people.set({ plan: 'free' });
    panel.identify('ann');
    panel.people.unset('name');
    panel.people.increment('credits', -5);
    panel.people.set_once({ $created: '2026-01-01', bad: {} });
    await panel.flush();
    await idle();
    expect(net.sent[0].batch.people).toEqual([
      { op: 'unset', user_id: 'ann', ts: expect.any(String), keys: ['$name'] },
      { op: 'increment', user_id: 'ann', ts: expect.any(String), props: { credits: -5 } },
      { op: 'set_once', user_id: 'ann', ts: expect.any(String), props: { $created: '2026-01-01' } },
    ]);
  });

  it('reset() forgets the user, super properties and groups, and starts new ids', async () => {
    const { panel, idle, net, storage } = setup({ network: NO_CONSENT_NEEDED });
    await panel.ready;
    panel.identify('ann');
    panel.register({ plan: 'pro' });
    panel.group('company', 'acme');
    panel.track('Before');
    panel.reset();
    panel.track('After');
    await panel.flush();
    await idle();
    const before = byName(net.events(), 'Before');
    const after = byName(net.events(), 'After');
    expect(before).toMatchObject({ user_id: 'ann' });
    expect(before.props).toMatchObject({ plan: 'pro', $group_company: 'acme' });
    expect(after).not.toHaveProperty('user_id');
    expect(after.anon_id).not.toBe(before.anon_id);
    expect(after.session_id).not.toBe(before.session_id);
    expect(after.props).not.toHaveProperty('plan');
    expect(after.props).not.toHaveProperty('$group_company');
    expect(storage?.json(STATE)).toMatchObject({ superProps: {}, groups: {} });
    expect(storage?.json(STATE)).not.toHaveProperty('userId');
    expect(panel.getDistinctId()).toBe(after.anon_id);
  });

  it('a session ends after 30 minutes without events', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-17T10:00:00Z') });
    const { panel } = setup({ network: NO_CONSENT_NEEDED });
    await panel.ready;
    const first = panel.getSessionId();
    vi.setSystemTime(new Date('2026-11-17T10:29:00Z'));
    panel.track('Still here');
    expect(panel.getSessionId()).toBe(first);
    vi.setSystemTime(new Date('2026-11-17T11:00:00Z'));
    panel.track('Back later');
    expect(panel.getSessionId()).not.toBe(first);
    expect(panel.getSessionId()).toMatch(/^s_/);
    panel.shutdown();
  });
});

describe('properties', () => {
  it('super properties: register() overwrites, registerOnce() does not, unregister() removes; event properties win', async () => {
    const { panel, idle, net } = setup();
    panel.register({ plan: 'pro', source: 'ads' });
    panel.registerOnce({ plan: 'free', first_seen: '2026-11-17' });
    panel.register({ source: 'email', $os: 'forged', 'bad key': 1 });
    panel.registerOnce({ temp: true });
    panel.unregister('temp');
    panel.track('Bought', { plan: 'enterprise' });
    await panel.flush();
    await idle();
    const props = byName(net.events(), 'Bought').props;
    expect(props).toMatchObject({ plan: 'enterprise', source: 'email', first_seen: '2026-11-17', $os: 'ios' });
    expect(props).not.toHaveProperty('temp');
    expect(props).not.toHaveProperty('bad key');
  });

  it('every event carries the device and app properties that are known', async () => {
    const { panel, idle, net } = setup();
    await panel.flush();
    await idle();
    const opened = net.events()[0];
    expect(opened.viewport_w).toBe(390);
    expect(opened.props).toEqual({
      $os: 'ios',
      $os_version: '17.4',
      $device_type: 'mobile',
      $device_model: 'iPhone',
      $app_id: 'com.acme.shop',
      $app_version: '2.1.0',
      $app_build: '210',
      $screen_width: 390,
      $screen_height: 844,
      $locale: 'en-US',
    });
  });

  it('keeps 50 properties: the event’s own, then groups, then super properties, then the device’s', async () => {
    const { panel, idle, net } = setup({ network: NO_CONSENT_NEEDED });
    await panel.ready;
    panel.register(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`s${i}`, i])));
    panel.group('company', 'acme');
    panel.track('Wide', Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`e${i}`, i])));
    await panel.flush();
    await idle();
    const props = byName(net.events(), 'Wide').props ?? {};
    expect(Object.keys(props)).toHaveLength(50);
    expect(props.e44).toBe(44);
    expect(props.$group_company).toBe('acme');
    expect(props.s3).toBe(3);
    expect(props).not.toHaveProperty('s4');
    expect(props).not.toHaveProperty('$os');
  });
});

describe('groups', () => {
  it('group() sets membership on every later event and sends the group profile; groups.* only the profile', async () => {
    const { panel, idle, net } = setup({ network: NO_CONSENT_NEEDED });
    await panel.ready;
    panel.track('Before');
    panel.group('company', 'acme', { name: 'Acme', plan: 'pro' });
    panel.group('team', 42);
    panel.groups.set_once('company', 'acme', { $created: '2026-01-01' });
    panel.groups.unset('company', 'acme', 'legacy');
    panel.groups.set('workspace', 'ws-1', { seats: 5 });
    panel.group('Bad Type', 'x');
    panel.group('company', '');
    panel.track('Member');
    panel.resetGroups();
    panel.track('After');
    await panel.flush();
    await idle();

    const events = net.events();
    expect(byName(events, 'Before').props).not.toHaveProperty('$group_company');
    expect(byName(events, 'Member').props).toMatchObject({ $group_company: 'acme', $group_team: '42' });
    expect(byName(events, 'Member').props).not.toHaveProperty('$group_workspace');
    expect(byName(events, 'After').props).not.toHaveProperty('$group_company');
    expect(net.sent[0].batch.groups).toEqual([
      { op: 'set', type: 'company', key: 'acme', props: { $name: 'Acme', plan: 'pro' } },
      { op: 'set', type: 'team', key: '42', props: {} },
      { op: 'set_once', type: 'company', key: 'acme', props: { $created: '2026-01-01' } },
      { op: 'unset', type: 'company', key: 'acme', keys: ['legacy'] },
      { op: 'set', type: 'workspace', key: 'ws-1', props: { seats: 5 } },
    ]);
  });

  it('group operations wait for an event to travel with', async () => {
    const { panel, idle, net } = setup({ network: NO_CONSENT_NEEDED });
    await panel.flush();
    await idle();
    expect(net.sent).toHaveLength(1);
    panel.groups.set('company', 'acme', { plan: 'pro' });
    await panel.flush();
    await idle();
    expect(net.sent).toHaveLength(1);
    panel.track('Now');
    await panel.flush();
    await idle();
    expect(net.sent[1].batch.groups).toEqual([{ op: 'set', type: 'company', key: 'acme', props: { plan: 'pro' } }]);
  });
});

describe('screens', () => {
  it('screen() sends $screen and tags later events with the screen', async () => {
    const { panel, idle, net } = setup();
    await panel.ready;
    panel.screen('  Product  Detail ', { sku: 'A-1', $bad: 1 });
    panel.track('Added to cart');
    panel.screen('   ');
    await panel.flush();
    await idle();

    const [opened, screen, added] = net.events();
    expect(opened.url).toBe('app://com.acme.shop/');
    expect(opened).not.toHaveProperty('title');
    expect(opened.props).not.toHaveProperty('$screen_name');
    expect(screen).toMatchObject({ name: '$screen', url: 'app://com.acme.shop/Product-Detail', title: 'Product  Detail' });
    expect(screen.props).toMatchObject({ sku: 'A-1', $screen_name: 'Product  Detail' });
    expect(screen.props).not.toHaveProperty('$bad');
    expect(added).toMatchObject({ url: 'app://com.acme.shop/Product-Detail', title: 'Product  Detail' });
    expect(added.props).toMatchObject({ $screen_name: 'Product  Detail' });
    expect(net.events()).toHaveLength(3);
  });

  it('without an app id the URL is app://app/, and a screen name is encoded into a valid path', async () => {
    const { panel, idle, net } = setup({ app: {} });
    panel.screen('Über uns #1?');
    await panel.flush();
    await idle();
    const [opened, screen] = net.events();
    expect(opened.url).toBe('app://app/');
    expect(screen.url).toBe('app://app/%C3%9Cber-uns-%231%3F');
    expect(screen.props).not.toHaveProperty('$app_id');
  });
});

describe('opt-out', () => {
  it('sends nothing and keeps nothing, on later launches too, until optIn()', async () => {
    const storage = memoryStorage();
    const { panel, idle, net } = setup({ storage, network: NO_CONSENT_NEEDED });
    await panel.ready;
    panel.optOut();
    panel.track('Hidden');
    panel.group('company', 'acme');
    panel.consent.grant();
    await panel.flush();
    await idle();
    expect(net.attempts).toHaveLength(0);
    expect(storage.data.get('weldpanel:optout')).toBe('1');
    expect(storage.data.has(STATE)).toBe(false);
    expect(panel.getDistinctId()).toBeNull();
    panel.shutdown();

    const again = setup({ storage, network: NO_CONSENT_NEEDED });
    again.panel.track('Still hidden');
    await again.panel.flush();
    await again.idle();
    expect(again.net.attempts).toHaveLength(0);

    again.panel.optIn();
    again.panel.track('Back');
    await again.panel.flush();
    await again.idle();
    expect(again.net.names()).toEqual(['Back']);
    expect(again.net.events()[0].anon_id).toMatch(/^a_/);
    expect(storage.data.has('weldpanel:optout')).toBe(false);
  });

  it('an opt-out made before the SDK is ready holds for the launch events too', async () => {
    const { panel, idle, net } = setup();
    panel.optOut();
    panel.track('Hidden');
    await panel.flush();
    await idle();
    expect(net.attempts).toHaveLength(0);
  });
});

describe('robustness', () => {
  it('never throws into the app, whatever storage, platform, network and arguments do', async () => {
    const boom = (): never => {
      throw new Error('boom');
    };
    const storage: StorageAdapter = { getItem: boom, setItem: () => Promise.reject(new Error('full')), removeItem: boom };
    const platform: PanelPlatform = { device: boom, dimensions: boom, appState: boom, onAppStateChange: boom };
    const { panel, idle } = setup({
      storage,
      device: { platform, setAppState: () => undefined, listeners: () => 0 },
      fetch: () => boom(),
      network: NO_CONSENT_NEEDED,
    });
    const anything = (v: unknown) => v as never;
    expect(() => {
      panel.track(anything(undefined), anything('props'));
      panel.track('Fine', { nested: anything({}) });
      panel.screen(anything(null));
      panel.identify(anything({}));
      panel.people.set(anything(null));
      panel.people.increment(anything(5));
      panel.register(anything('x'));
      panel.group(anything(1), anything(null), anything([]));
      panel.groups.unset('company', 'acme', anything(null));
      panel.consent.grant();
    }).not.toThrow();
    await expect(panel.flush()).resolves.toBeUndefined();
    await idle();
    panel.shutdown();
  });

  it('shutdown() removes the app state listener and timers, and later calls do nothing', async () => {
    vi.useFakeTimers();
    const device = fakeDevice();
    const { panel, net } = setup({ device });
    await panel.ready;
    panel.track('Queued');
    expect(device.listeners()).toBe(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    panel.shutdown();
    expect(device.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    panel.track('After');
    device.setAppState('background');
    await vi.advanceTimersByTimeAsync(60_000);
    await panel.flush();
    expect(net.attempts).toHaveLength(0);
  });

  it('calls made before the SDK is ready are kept and run in order once it is', async () => {
    const { panel, idle, net } = setup();
    panel.track('Early', { n: 1 });
    panel.screen('Home');
    panel.track('Early', { n: 2 });
    const flushed = panel.flush();
    await flushed;
    await idle();
    expect(net.names()).toEqual(['$app_opened', 'Early', '$screen', 'Early']);
    expect(net.events()[3].props).toMatchObject({ n: 2, $screen_name: 'Home' });
  });

  it('works without storage, in memory', async () => {
    const { panel, idle, net } = setup({ storage: undefined, network: NO_CONSENT_NEEDED });
    panel.identify('ann');
    await panel.flush();
    await idle();
    expect(net.names()).toEqual(['$app_installed', '$identify', '$app_opened']);
    expect(panel.getDistinctId()).toBe('ann');
  });
});
