import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelSalt } from '../durable-objects/panel-salt';
import { fakeDurableObjectContext, fakeNamespace } from '../testing/fakes';
import { COOKIELESS_PREFIX, cookielessVisitorId, resetSaltCache, todaysSalt } from './visitor';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36';

describe('cookielessVisitorId', () => {
  it('is ck_ plus 24 hex characters', async () => {
    expect(await cookielessVisitorId('salt', 'pnp_1', '203.0.113.7', UA)).toMatch(/^ck_[0-9a-f]{24}$/);
  });

  it('is the first 24 hex of SHA-256(salt:project:ip:userAgent)', async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`salt:pnp_1:203.0.113.7:${UA}`));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(await cookielessVisitorId('salt', 'pnp_1', '203.0.113.7', UA)).toBe(COOKIELESS_PREFIX + hex.slice(0, 24));
  });

  it('is stable for the same salt, project, address and agent', async () => {
    expect(await cookielessVisitorId('salt', 'pnp_1', '203.0.113.7', UA)).toBe(
      await cookielessVisitorId('salt', 'pnp_1', '203.0.113.7', UA),
    );
  });

  it('changes when any ingredient changes, the salt included', async () => {
    const base = await cookielessVisitorId('salt-monday', 'pnp_1', '203.0.113.7', UA);
    expect(await cookielessVisitorId('salt-tuesday', 'pnp_1', '203.0.113.7', UA)).not.toBe(base);
    expect(await cookielessVisitorId('salt-monday', 'pnp_2', '203.0.113.7', UA)).not.toBe(base);
    expect(await cookielessVisitorId('salt-monday', 'pnp_1', '203.0.113.8', UA)).not.toBe(base);
    expect(await cookielessVisitorId('salt-monday', 'pnp_1', '203.0.113.7', `${UA} x`)).not.toBe(base);
  });
});

describe('todaysSalt', () => {
  beforeEach(() => {
    resetSaltCache();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'));
    return () => vi.useRealTimers();
  });

  function namespace() {
    const object = new PanelSalt(fakeDurableObjectContext().ctx, {});
    const today = vi.spyOn(object, 'today');
    return { ns: fakeNamespace(() => object) as unknown as DurableObjectNamespace<PanelSalt>, today };
  }

  it('asks the salt object once per day, however many requests come in', async () => {
    const { ns, today } = namespace();
    const salts = await Promise.all(Array.from({ length: 20 }, () => todaysSalt(ns, Date.now())));
    expect(new Set(salts).size).toBe(1);
    await todaysSalt(ns, Date.now());
    expect(today).toHaveBeenCalledTimes(1);
  });

  it('asks again on a new UTC day and gets a different salt', async () => {
    const { ns, today } = namespace();
    const monday = await todaysSalt(ns, Date.now());
    vi.setSystemTime(new Date('2026-10-28T00:00:05Z'));
    const tuesday = await todaysSalt(ns, Date.now());
    expect(today).toHaveBeenCalledTimes(2);
    expect(tuesday).not.toBe(monday);
  });

  it('does not keep a failed lookup', async () => {
    const { ns, today } = namespace();
    today.mockRejectedValueOnce(new Error('object unavailable'));
    await expect(todaysSalt(ns, Date.now())).rejects.toThrow('object unavailable');
    await expect(todaysSalt(ns, Date.now())).resolves.toMatch(/^[0-9a-f]{32}$/);
  });
});
