import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WeldApi } from './api';
import { WeldAppBridge } from './bridge';
import type { AppMessage, BridgeFetchRequest, InitPayload } from './types';

/**
 * Minimal iframe harness: `window` is an EventTarget whose `parent` records
 * posted messages, and the test plays the host by dispatching `message`
 * events that claim to come from that parent.
 */
interface Harness {
  posted: AppMessage[];
  reply: (data: unknown) => void;
  keydown: (init: Partial<KeyboardEvent>) => { defaultPrevented: boolean };
}

function installWindow(): Harness {
  const posted: AppMessage[] = [];
  const target = new EventTarget();
  const parent = {
    postMessage: (message: AppMessage) => {
      posted.push(message);
    },
  };
  const fakeWindow = Object.assign(target, { parent, location: { search: '' } });
  vi.stubGlobal('window', fakeWindow);

  return {
    posted,
    reply: (data) => {
      const event = new Event('message');
      Object.defineProperty(event, 'data', { value: data });
      Object.defineProperty(event, 'source', { value: parent });
      target.dispatchEvent(event);
    },
    keydown: (init) => {
      const event = new Event('keydown', { cancelable: true });
      for (const [key, value] of Object.entries({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init })) {
        Object.defineProperty(event, key, { value });
      }
      target.dispatchEvent(event);
      return { defaultPrevented: event.defaultPrevented };
    },
  };
}

function initPayload(overrides: Partial<InitPayload> = {}): InitPayload {
  return {
    appCode: 'demo',
    theme: 'light',
    locale: 'en',
    apiBaseUrl: 'https://api.example.test',
    token: null,
    tokenExpiresAt: null,
    user: { id: 'usr_1', name: 'Ada' },
    protocol: 2,
    ...overrides,
  };
}

async function connect(harness: Harness, bridge: WeldAppBridge, payload: InitPayload): Promise<void> {
  const connecting = bridge.connect();
  expect(harness.posted[0]).toEqual({ type: 'weldapp:ready' });
  harness.reply({ type: 'weldapp:init', payload });
  await connecting;
}

/** Answer the next `weldapp:request` the app posts. */
async function answerNext(harness: Harness, payload: unknown): Promise<AppMessage & { method?: string; payload?: unknown }> {
  await vi.waitFor(() => {
    expect(harness.posted.some((m) => m.type === 'weldapp:request')).toBe(true);
  });
  const index = harness.posted.findIndex((m) => m.type === 'weldapp:request');
  const request = harness.posted.splice(index, 1)[0] as AppMessage & { id: string; method: string; payload?: unknown };
  harness.reply({ type: 'weldapp:response', id: request.id, ok: true, payload });
  return request;
}

describe('WeldAppBridge protocol 2', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = installWindow();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('proxies API calls through the host without ever holding a token', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const bridge = new WeldAppBridge({ applyAppearance: false });
    await connect(harness, bridge, initPayload());
    expect(bridge.hostProxiesRequests).toBe(true);

    const api = new WeldApi(bridge);
    const pending = api.post<{ data: { id: string } }>('/v1/app-storage/kv/x', { value: 1 });

    const body = new TextEncoder().encode(JSON.stringify({ data: { id: 'rec_1' } })).buffer;
    const request = await answerNext(harness, {
      status: 200,
      headers: [['content-type', 'application/json']],
      body,
    });

    await expect(pending).resolves.toEqual({ data: { id: 'rec_1' } });
    expect(request.method).toBe('fetch');
    const sent = request.payload as BridgeFetchRequest;
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe('/v1/app-storage/kv/x');
    expect(sent.body).toBe(JSON.stringify({ value: 1 }));
    expect(sent.headers.some(([name]) => name === 'authorization')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces host-proxied API errors as WeldApiError', async () => {
    const bridge = new WeldAppBridge({ applyAppearance: false });
    await connect(harness, bridge, initPayload());
    const api = new WeldApi(bridge);
    const pending = api.get('/v1/people');
    const body = new TextEncoder().encode(JSON.stringify({ error: { code: 'forbidden', message: 'Missing scope' } })).buffer;
    await answerNext(harness, { status: 403, headers: [['content-type', 'application/json']], body });
    await expect(pending).rejects.toMatchObject({ status: 403, code: 'forbidden', message: 'Missing scope' });
  });

  it('builds a body-less Response for 204', async () => {
    const bridge = new WeldAppBridge({ applyAppearance: false });
    await connect(harness, bridge, initPayload());
    const api = new WeldApi(bridge);
    const pending = api.delete('/v1/app-storage/kv/x');
    await answerNext(harness, { status: 204, headers: [], body: new ArrayBuffer(0) });
    await expect(pending).resolves.toBeUndefined();
  });

  it('keeps the direct token path for protocol 1 hosts', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const bridge = new WeldAppBridge({ applyAppearance: false });
    const expires = new Date(Date.now() + 10 * 60_000).toISOString();
    await connect(harness, bridge, initPayload({ protocol: undefined, token: 'wsat_legacy', tokenExpiresAt: expires }));
    expect(bridge.hostProxiesRequests).toBe(false);

    await new WeldApi(bridge).get('/v1/people');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/v1/people');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer wsat_legacy');
  });

  it('hands unhandled Cmd/Ctrl+K to the host and leaves handled ones alone', async () => {
    const bridge = new WeldAppBridge({ applyAppearance: false });
    await connect(harness, bridge, initPayload());
    harness.posted.length = 0;

    expect(harness.keydown({ key: 'k', metaKey: true }).defaultPrevented).toBe(true);
    expect(harness.posted).toEqual([
      {
        type: 'weldapp:notify',
        event: 'shortcut',
        payload: { key: 'k', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
      },
    ]);

    harness.posted.length = 0;
    harness.keydown({ key: 'k' });
    harness.keydown({ key: 'b', ctrlKey: true });
    expect(harness.posted).toEqual([]);
  });

  it('resolves confirm and openModal without a timeout', async () => {
    vi.useFakeTimers();
    try {
      const bridge = new WeldAppBridge({ applyAppearance: false });
      await connect(harness, bridge, initPayload());
      const confirming = bridge.confirm({ title: 'Delete?' });
      await vi.advanceTimersByTimeAsync(120_000);
      await answerNext(harness, { confirmed: true });
      await expect(confirming).resolves.toBe(true);

      const opening = bridge.openModal({ path: '/new' });
      await answerNext(harness, { dismissed: false, result: { id: 'x' } });
      await expect(opening).resolves.toEqual({ dismissed: false, result: { id: 'x' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('notifies mounted once', async () => {
    const bridge = new WeldAppBridge({ applyAppearance: false });
    await connect(harness, bridge, initPayload());
    harness.posted.length = 0;
    bridge.notifyMounted();
    bridge.notifyMounted();
    expect(harness.posted).toEqual([{ type: 'weldapp:notify', event: 'mounted' }]);
  });
});
