import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWeldApp, WeldApiError, shouldUseLocalDev } from '../index';
import { WeldAppBridge } from './bridge';
import { LOCAL_DEV_WINDOW_FLAG } from './local-dev';

function mockTopLevelWindow(search = ''): void {
  const location = { search, href: `http://localhost:5173/${search}` };
  vi.stubGlobal('window', {
    parent: undefined as unknown,
    location,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    [LOCAL_DEV_WINDOW_FLAG]: undefined,
  });
  // top-level: parent === window
  (window as { parent: Window }).parent = window;
}

function mockIframeWindow(): void {
  const parent = { postMessage: vi.fn() };
  vi.stubGlobal('window', {
    parent,
    location: { search: '', href: 'http://localhost:5173/' },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

describe('shouldUseLocalDev', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is false when embedded in an iframe even if localDev is requested', () => {
    mockIframeWindow();
    expect(shouldUseLocalDev({ localDev: true })).toBe(false);
  });

  it('is true for top-level + localDev option', () => {
    mockTopLevelWindow();
    expect(shouldUseLocalDev({ localDev: true })).toBe(true);
  });

  it('is true for top-level + ?weldLocal=1', () => {
    mockTopLevelWindow('?weldLocal=1');
    expect(shouldUseLocalDev()).toBe(true);
  });

  it('is false for top-level without opt-in', () => {
    mockTopLevelWindow();
    expect(shouldUseLocalDev()).toBe(false);
  });
});

describe('WeldAppBridge local preview', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connects immediately with a mock payload when localDev is set', async () => {
    mockTopLevelWindow();
    const bridge = new WeldAppBridge({ localDev: true, local: { userName: 'Gert' } });
    const init = await bridge.connect();
    expect(bridge.isLocalDev).toBe(true);
    expect(init.user.name).toBe('Gert');
    expect(init.appCode).toBe('local-preview');
    expect(init.token).toBe('local_preview_token');
  });

  it('rejects outside an iframe without opt-in', async () => {
    mockTopLevelWindow();
    const bridge = new WeldAppBridge();
    await expect(bridge.connect()).rejects.toThrow(/not embedded in an iframe/);
    await expect(bridge.connect()).rejects.toThrow(/localDev/);
  });

  it('does not activate local mode when iframed', async () => {
    mockIframeWindow();
    const bridge = new WeldAppBridge({ localDev: true });
    expect(bridge.isLocalDev).toBe(false);
    // Will hang waiting for host — don't call connect with timeout in unit test;
    // just assert local store is absent.
    expect(bridge.localStore).toBeNull();
  });

  it('stubs toast and navigate as no-ops', async () => {
    mockTopLevelWindow();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const bridge = new WeldAppBridge({ localDev: true });
    await bridge.connect();
    await bridge.toast('hello', 'success');
    await bridge.navigate('/crm');
    expect(debug).toHaveBeenCalled();
    debug.mockRestore();
  });
});

describe('WeldApi local memory store', () => {
  beforeEach(() => {
    mockTopLevelWindow();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('supports records CRUD in memory', async () => {
    const { api, bridge } = createWeldApp({ localDev: true });
    await bridge.connect();
    const items = api.records<{ title: string; done: boolean }>('items');

    expect((await items.list()).data).toEqual([]);
    const created = await items.create({ title: 'Ship', done: false });
    expect(created.id).toMatch(/^rec_local_/);
    expect((await items.list()).data).toHaveLength(1);

    const updated = await items.update(created.id, { title: 'Ship', done: true });
    expect(updated.data.done).toBe(true);

    await items.remove(created.id);
    expect((await items.list()).data).toEqual([]);
  });

  it('supports kv get/set/delete in memory', async () => {
    const { api, bridge } = createWeldApp({ localDev: true });
    await bridge.connect();
    expect(await api.kv.get('settings')).toBeNull();
    await api.kv.set('settings', { compact: true });
    expect(await api.kv.get<{ compact: boolean }>('settings')).toEqual({ compact: true });
    await api.kv.delete('settings');
    expect(await api.kv.get('settings')).toBeNull();
  });

  it('rejects non-storage API calls with a clear local_preview error', async () => {
    const { api, bridge } = createWeldApp({ localDev: true });
    await bridge.connect();
    await expect(api.people.list()).rejects.toMatchObject({
      name: 'WeldApiError',
      code: 'local_preview',
      status: 503,
    } satisfies Partial<WeldApiError>);
  });
});
