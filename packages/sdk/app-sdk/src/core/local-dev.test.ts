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

  it('activates memory store + real host bridge when init.localPreview is set', async () => {
    mockIframeWindow();
    const bridge = new WeldAppBridge({ localDev: true });
    const parent = window.parent as { postMessage: ReturnType<typeof vi.fn> };

    const connectPromise = bridge.connect();
    // Wait a tick so the ready listener is attached, then simulate host init.
    await Promise.resolve();
    const handler = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === 'message',
    )?.[1] as ((event: MessageEvent) => void) | undefined;
    expect(handler).toBeTypeOf('function');

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    handler!({
      source: window.parent,
      data: {
        type: 'weldapp:init',
        payload: {
          appCode: 'demo-app',
          theme: 'light',
          locale: 'en',
          apiBaseUrl: 'http://localhost/local-preview',
          token: 'local_preview_token',
          tokenExpiresAt: expiresAt,
          user: { id: 'usr_local', name: 'Shell User' },
          localPreview: true,
        },
      },
    } as MessageEvent);

    const init = await connectPromise;
    expect(init.localPreview).toBe(true);
    expect(bridge.isLocalDev).toBe(true);
    expect(bridge.isLocalShell).toBe(true);
    expect(bridge.localStore).not.toBeNull();
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'weldapp:ready' }, '*');

    // toast/navigate go to the host (not stubbed).
    const toastPromise = bridge.toast('hi', 'success');
    await Promise.resolve();
    const toastCall = parent.postMessage.mock.calls.find(
      (call) => (call[0] as { type?: string }).type === 'weldapp:request',
    );
    expect(toastCall).toBeTruthy();
    const req = toastCall![0] as { id: string; method: string };
    expect(req.method).toBe('toast');
    handler!({
      source: window.parent,
      data: { type: 'weldapp:response', id: req.id, ok: true, payload: {} },
    } as MessageEvent);
    await toastPromise;
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

  it('supports products CRUD in memory', async () => {
    const { api, bridge } = createWeldApp({ localDev: true });
    await bridge.connect();

    expect((await api.products.list()).data).toEqual([]);
    const created = await api.products.create({
      name: 'Demo Hoodie',
      slug: 'demo-hoodie',
      price: '49.00',
      currency: 'EUR',
      status: 'active',
    });
    expect(created.id).toMatch(/^prod_local_/);
    expect(created.slug).toBe('demo-hoodie');

    const listed = await api.products.list({ search: 'hoodie' });
    expect(listed.data).toHaveLength(1);

    const updated = await api.products.update(created.id, { price: '59.00' });
    expect(updated.price).toBe('59.00');

    const fetched = await api.products.get(created.id);
    expect(fetched.data.name).toBe('Demo Hoodie');

    await api.products.remove(created.id);
    expect((await api.products.list()).data).toEqual([]);
  });
});
