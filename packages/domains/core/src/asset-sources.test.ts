/**
 * Asset sources, the pure parts: the device mapper (asset type, compliance,
 * fallbacks), the error mapping of Microsoft's answers, the tenant id and the
 * `@odata.nextLink` host checks, the schedule arithmetic. The stub answers by
 * URL and method, never by call order.
 */

import { describe, expect, it } from 'vitest';
import {
  assetSourceDueAt,
  assetTypeFor,
  deviceChecksum,
  fetchIntunePage,
  formatAssetSourceError,
  INTUNE_DEVICES_URL,
  intuneToken,
  isGraphUrl,
  isValidEntraTenantId,
  mapCompliance,
  mapIntuneDevice,
  nextAssetImportAt,
  parseAssetSourceError,
  testAssetSource,
  AssetSourceError,
  type FetchLike,
} from './asset-sources';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CONFIG = { tenantId: TENANT, clientId: 'cccccccc-2222-3333-4444-555555555555' };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function stub(handler: (url: string, method: string) => Response): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    return handler(url, method);
  }) as FetchLike;
  return { fetch: fetcher, calls };
}

describe('assetTypeFor', () => {
  it.each([
    ['iOS/iPadOS', 'iPad Pro 11-inch', 'tablet'],
    ['iOS/iPadOS', 'iPhone 15', 'phone'],
    ['iOS', null, 'phone'],
    ['Android', 'Pixel 8', 'phone'],
    ['Android', 'Galaxy Tab S9', 'phone'],
    ['Windows', 'Latitude 7440', 'laptop'],
    ['Windows', 'OptiPlex 7010', 'desktop'],
    ['Windows', 'ThinkCentre M70q', 'desktop'],
    ['Windows', 'HP ProDesk 400 G9', 'desktop'],
    ['Windows', 'EliteDesk 800', 'desktop'],
    ['Windows', 'Intel NUC11', 'desktop'],
    ['Windows', 'Precision Tower 5860', 'desktop'],
    ['Windows', 'Surface Laptop 5', 'laptop'],
    ['macOS', 'MacBookPro18,1', 'laptop'],
    ['macOS', 'MacBook Air', 'laptop'],
    ['macOS', 'iMac21,1', 'desktop'],
    ['macOS', 'Macmini9,1', 'desktop'],
    ['macOS', 'Mac Studio', 'desktop'],
    ['macOS', 'MacPro7,1', 'desktop'],
    ['Linux', 'ThinkPad T14', 'laptop'],
    ['ChromeOS', 'Chromebook', 'other'],
    [null, null, 'other'],
  ])('%s / %s is %s', (os, model, expected) => {
    expect(assetTypeFor(os, model)).toBe(expected);
  });
});

describe('mapCompliance', () => {
  it('maps every Graph state and falls back to unknown', () => {
    expect(mapCompliance('compliant')).toBe('compliant');
    expect(mapCompliance('noncompliant')).toBe('noncompliant');
    expect(mapCompliance('inGracePeriod')).toBe('in_grace_period');
    expect(mapCompliance('conflict')).toBe('conflict');
    expect(mapCompliance('error')).toBe('error');
    expect(mapCompliance('configManager')).toBe('config_manager');
    expect(mapCompliance('unknown')).toBe('unknown');
    expect(mapCompliance('somethingNew')).toBe('unknown');
    expect(mapCompliance(undefined)).toBe('unknown');
  });
});

describe('mapIntuneDevice', () => {
  const device = {
    id: 'dev-1',
    deviceName: ' LAPTOP-01 ',
    managedDeviceName: 'user_Windows_1',
    serialNumber: 'SN123',
    manufacturer: 'Dell',
    model: 'Latitude 7440',
    operatingSystem: 'Windows',
    osVersion: '10.0.22631',
    complianceState: 'inGracePeriod',
    lastSyncDateTime: '2026-11-01T08:30:00Z',
    userPrincipalName: 'Sanne@Example.com',
    emailAddress: 'sanne.jansen@example.com',
  };

  it('maps the device facts to the asset fields', () => {
    const mapped = mapIntuneDevice(device);
    expect(mapped.externalId).toBe('dev-1');
    expect(mapped.serialNumber).toBe('SN123');
    expect(mapped.values).toEqual({
      name: 'LAPTOP-01',
      serial_number: 'SN123',
      manufacturer: 'Dell',
      model: 'Latitude 7440',
      operating_system: 'Windows',
      os_version: '10.0.22631',
      compliance: 'in_grace_period',
      last_check_in: '2026-11-01T08:30:00.000Z',
      primary_user: 'Sanne@Example.com',
      intune_device_id: 'dev-1',
    });
    expect(mapped.createdOnly).toEqual({ asset_type: 'laptop', status: 'in_use' });
    // The owner is looked up by the email address first, lower-cased.
    expect(mapped.userEmail).toBe('sanne.jansen@example.com');
  });

  it('names the record by device name, managed name, serial number, then id', () => {
    expect(mapIntuneDevice({ id: 'a', managedDeviceName: 'M', serialNumber: 'S' }).values.name).toBe('M');
    expect(mapIntuneDevice({ id: 'a', deviceName: '  ', serialNumber: 'S' }).values.name).toBe('S');
    expect(mapIntuneDevice({ id: 'a' }).values.name).toBe('a');
  });

  it('uses the email address for the primary user when there is no user principal name, and the principal name for the owner otherwise', () => {
    expect(mapIntuneDevice({ id: 'a', emailAddress: 'x@example.com' }).values.primary_user).toBe('x@example.com');
    expect(mapIntuneDevice({ id: 'a', userPrincipalName: 'U@Example.com' }).userEmail).toBe('u@example.com');
    expect(mapIntuneDevice({ id: 'a' }).userEmail).toBeNull();
  });

  it('leaves out what the device does not report and the "never checked in" date', () => {
    const mapped = mapIntuneDevice({ id: 'a', lastSyncDateTime: '0001-01-01T00:00:00Z', serialNumber: '' });
    expect(mapped.values.last_check_in).toBeNull();
    expect(mapped.values.serial_number).toBeNull();
    expect(mapped.values.manufacturer).toBeNull();
    expect(mapped.createdOnly.asset_type).toBe('other');
  });

  it('refuses a device without an id', () => {
    expect(() => mapIntuneDevice({ deviceName: 'x' })).toThrow();
    expect(() => mapIntuneDevice({ id: ' ' })).toThrow();
  });

  it('has a checksum that changes with the values only', async () => {
    const a = await deviceChecksum(mapIntuneDevice(device).values);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await deviceChecksum(mapIntuneDevice({ ...device }).values)).toBe(a);
    expect(await deviceChecksum(mapIntuneDevice({ ...device, osVersion: '10.0.26100' }).values)).not.toBe(a);
  });
});

describe('isValidEntraTenantId', () => {
  it('accepts a GUID or a domain name', () => {
    expect(isValidEntraTenantId(TENANT)).toBe(true);
    expect(isValidEntraTenantId('contoso.onmicrosoft.com')).toBe(true);
    expect(isValidEntraTenantId('Example.COM')).toBe(true);
  });

  it('refuses anything that could change the URL', () => {
    for (const value of ['', 'contoso', 'a/b.com', 'evil.com/../x', 'a.com?x=1', 'a.com#x', 'a b.com', '..', 'a..com', '-a.com', 'a.com\n', 'user@example.com', `${TENANT}/x`]) {
      expect(isValidEntraTenantId(value), value).toBe(false);
    }
  });
});

describe('isGraphUrl', () => {
  it('accepts only https on graph.microsoft.com', () => {
    expect(isGraphUrl(INTUNE_DEVICES_URL)).toBe(true);
    expect(isGraphUrl('https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$skiptoken=abc')).toBe(true);
    for (const url of [
      'http://graph.microsoft.com/v1.0/x',
      'https://evil.example.com/v1.0/x',
      'https://graph.microsoft.com.evil.example/v1.0/x',
      'https://graph.microsoft.com:8443/v1.0/x',
      'https://user:pw@graph.microsoft.com/v1.0/x',
      'https://login.microsoftonline.com/x',
      'not a url',
      '',
    ]) {
      expect(isGraphUrl(url), url).toBe(false);
    }
  });
});

describe('intuneToken', () => {
  it('posts the client credentials to the tenant token endpoint', async () => {
    let body = '';
    const { fetch, calls } = stub((url, method) => {
      if (method === 'POST' && url === `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`) return json({ token_type: 'Bearer', expires_in: 3599, access_token: 'tok' });
      return json({}, 404);
    });
    const spy: FetchLike = (async (input: RequestInfo | URL, init?: RequestInit) => {
      body = String(init?.body);
      return fetch(input, init);
    }) as FetchLike;
    expect(await intuneToken(CONFIG, 's3cret', spy)).toBe('tok');
    expect(calls).toEqual([`POST https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`]);
    const form = new URLSearchParams(body);
    expect(Object.fromEntries(form)).toEqual({
      client_id: CONFIG.clientId,
      client_secret: 's3cret',
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
  });

  it.each([
    [7000215, 'invalid_secret'],
    [7000218, 'invalid_secret'],
    [7000222, 'secret_expired'],
    [90002, 'tenant_not_found'],
    [700016, 'app_not_found'],
    [50034, 'sign_in_failed'],
  ])('maps error code %s to %s', async (errorCode, expected) => {
    const { fetch } = stub(() => json({ error: 'invalid_client', error_description: 'AADSTS…', error_codes: [errorCode] }, 401));
    await expect(intuneToken(CONFIG, 's', fetch)).rejects.toMatchObject({ code: expected });
  });

  it('never sends a bad tenant id to the network', async () => {
    const { fetch, calls } = stub(() => json({}));
    await expect(intuneToken({ ...CONFIG, tenantId: 'a/../b' }, 's', fetch)).rejects.toMatchObject({ code: 'tenant_not_found' });
    expect(calls).toEqual([]);
  });

  it('maps throttling with Retry-After, server errors and network failures', async () => {
    const throttled = stub(() => json({}, 429, { 'Retry-After': '45' }));
    await expect(intuneToken(CONFIG, 's', throttled.fetch)).rejects.toMatchObject({ code: 'throttled', retryAfterSeconds: 45 });
    const down = stub(() => json({}, 500));
    await expect(intuneToken(CONFIG, 's', down.fetch)).rejects.toMatchObject({ code: 'unreachable' });
    const offline = (async () => {
      throw new TypeError('fetch failed s3cret');
    }) as unknown as FetchLike;
    const failure = await intuneToken(CONFIG, 's3cret', offline).catch((err: AssetSourceError) => err);
    expect(failure).toMatchObject({ code: 'unreachable' });
    expect((failure as Error).message).not.toContain('s3cret');
  });
});

describe('fetchIntunePage', () => {
  it('reads the first page and hands back the nextLink verbatim', async () => {
    const next = `${INTUNE_DEVICES_URL}?$skiptoken=abc`;
    const { fetch, calls } = stub((url) => (url === INTUNE_DEVICES_URL ? json({ value: [{ id: 'a' }], '@odata.nextLink': next }) : json({}, 404)));
    expect(await fetchIntunePage('tok', null, fetch)).toEqual({ devices: [{ id: 'a' }], nextLink: next });
    expect(calls).toEqual([`GET ${INTUNE_DEVICES_URL}`]);
  });

  it('accepts an empty page and the last page', async () => {
    const { fetch } = stub(() => json({ value: [] }));
    expect(await fetchIntunePage('tok', null, fetch)).toEqual({ devices: [], nextLink: null });
  });

  it('refuses a link to another host before calling it, and a nextLink to another host', async () => {
    const calls = stub(() => json({ value: [] }));
    await expect(fetchIntunePage('tok', 'https://evil.example.com/x', calls.fetch)).rejects.toMatchObject({ code: 'unreachable' });
    expect(calls.calls).toEqual([]);
    const evil = stub(() => json({ value: [], '@odata.nextLink': 'https://evil.example.com/next' }));
    await expect(fetchIntunePage('tok', null, evil.fetch)).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('maps 403 and 401 to a missing permission, 429/503 to throttled, and the rest to unreachable', async () => {
    for (const status of [401, 403]) {
      await expect(fetchIntunePage('t', null, stub(() => json({}, status)).fetch)).rejects.toMatchObject({ code: 'permission_missing' });
    }
    await expect(fetchIntunePage('t', null, stub(() => json({}, 429, { 'Retry-After': '120' })).fetch)).rejects.toMatchObject({ code: 'throttled', retryAfterSeconds: 120 });
    await expect(fetchIntunePage('t', null, stub(() => json({}, 503)).fetch)).rejects.toMatchObject({ code: 'throttled', retryAfterSeconds: 60 });
    await expect(fetchIntunePage('t', null, stub(() => json({}, 500)).fetch)).rejects.toMatchObject({ code: 'unreachable' });
    await expect(fetchIntunePage('t', null, stub(() => json({ nope: true })).fetch)).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('caps an absurd Retry-After at an hour', async () => {
    await expect(fetchIntunePage('t', null, stub(() => json({}, 429, { 'Retry-After': '999999' })).fetch)).rejects.toMatchObject({ retryAfterSeconds: 3600 });
  });
});

describe('testAssetSource', () => {
  it('reports the device count of the first page', async () => {
    const { fetch } = stub((url, method) => {
      if (method === 'POST') return json({ access_token: 'tok' });
      return url === INTUNE_DEVICES_URL ? json({ value: [{ id: 'a' }, { id: 'b' }] }) : json({}, 404);
    });
    expect(await testAssetSource(CONFIG, 's', fetch)).toEqual({ ok: true, deviceCount: 2 });
  });

  it('answers with the code and message instead of throwing', async () => {
    const { fetch } = stub((_url, method) => (method === 'POST' ? json({ error_codes: [7000215] }, 401) : json({})));
    const result = await testAssetSource(CONFIG, 's', fetch);
    expect(result).toMatchObject({ ok: false, code: 'invalid_secret' });
    expect(result.ok ? '' : result.message).toContain('secret');
  });

  it('reports a missing permission from Graph', async () => {
    const { fetch } = stub((_url, method) => (method === 'POST' ? json({ access_token: 'tok' }) : json({ error: { code: 'Forbidden' } }, 403)));
    expect(await testAssetSource(CONFIG, 's', fetch)).toMatchObject({ ok: false, code: 'permission_missing' });
  });
});

describe('stored errors', () => {
  it('round-trips the code and message', () => {
    const stored = formatAssetSourceError(new AssetSourceError('permission_missing'));
    expect(parseAssetSourceError(stored)).toMatchObject({ code: 'permission_missing' });
    expect(parseAssetSourceError('something else: broke')).toEqual({ code: null, message: 'something else: broke' });
    expect(parseAssetSourceError(null)).toEqual({ code: null, message: null });
  });
});

describe('schedule', () => {
  const now = new Date('2026-11-10T08:00:00Z');

  it('puts the next import one interval after a run, or nowhere when the schedule is off', () => {
    expect(nextAssetImportAt({ enabled: true, intervalHours: 24 }, now)?.toISOString()).toBe('2026-11-11T08:00:00.000Z');
    expect(nextAssetImportAt({ enabled: true, intervalHours: 1 }, now)?.toISOString()).toBe('2026-11-10T09:00:00.000Z');
    expect(nextAssetImportAt({ enabled: false, intervalHours: 24 }, now)).toBeNull();
  });

  it('is due now while a run is under way, else at its schedule', () => {
    const state = { startedAt: now.toISOString(), stats: { total: 0, created: 0, updated: 0, unchanged: 0, failed: 0 } };
    const later = new Date('2026-11-12T00:00:00Z');
    expect(assetSourceDueAt({ enabled: false, nextSyncAt: null, syncState: state }, now)).toEqual(now);
    expect(assetSourceDueAt({ enabled: true, nextSyncAt: later, syncState: null }, now)).toEqual(later);
    expect(assetSourceDueAt({ enabled: false, nextSyncAt: later, syncState: null }, now)).toBeNull();
    expect(assetSourceDueAt({ enabled: true, nextSyncAt: null, syncState: null }, now)).toBeNull();
  });
});
