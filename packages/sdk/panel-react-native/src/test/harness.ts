/** Test helpers: a client on a fake device, fake storage and a fake network. */

import { vi } from 'vitest';
import { createClient, type FetchLike, type FetchResponse, type WeldPanelOptions } from '../client';
import type { DeviceInfo, PanelPlatform, Size } from '../platform';
import type { StorageAdapter } from '../storage';
import type { EventBatch, WireEvent } from '../wire';

export const TOKEN = 'wpk_0123456789abcdef0123456789abcdef';
export const HOST = 'https://pnl.example.org';

export interface FakeDevice {
  platform: PanelPlatform;
  /** Change the app state and tell the listeners, like `AppState` does. */
  setAppState(state: string): void;
  listeners(): number;
}

export function fakeDevice(
  options: { device?: DeviceInfo; appState?: string | null; window?: Size; screen?: Size } = {},
): FakeDevice {
  const listeners = new Set<(state: string) => void>();
  let state = options.appState === undefined ? 'active' : options.appState;
  const platform: PanelPlatform = {
    device: () => options.device ?? { os: 'ios', osVersion: '17.4', deviceType: 'mobile', deviceModel: 'iPhone', locale: 'en-US' },
    dimensions: () => ({ window: options.window ?? { width: 390.4, height: 844 }, screen: options.screen ?? { width: 390, height: 844 } }),
    appState: () => state,
    onAppStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    platform,
    setAppState(next) {
      state = next;
      for (const listener of Array.from(listeners)) listener(next);
    },
    listeners: () => listeners.size,
  };
}

export interface MemoryStorage extends StorageAdapter {
  data: Map<string, string>;
  /** Every `setItem` and `removeItem`, in order. */
  writes: Array<[string, string | null]>;
  json(key: string): unknown;
}

export function memoryStorage(initial: Record<string, string> = {}): MemoryStorage {
  const data = new Map(Object.entries(initial));
  const writes: Array<[string, string | null]> = [];
  return {
    data,
    writes,
    json: (key) => {
      const v = data.get(key);
      return v === undefined ? undefined : (JSON.parse(v) as unknown);
    },
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      writes.push([key, value]);
      data.set(key, value);
    },
    removeItem: async (key) => {
      writes.push([key, null]);
      data.delete(key);
    },
  };
}

export interface NetworkOptions {
  /** What `GET /c/:token` answers; `null` for a 404, `'error'` for a network failure. */
  config?: Record<string, unknown> | null | 'error';
  /** Answers for the next `POST /e` requests, in order: a status, or `'error'` for a network failure. Then 204. */
  answers?: Array<number | 'error'>;
}

export interface Sent {
  url: string;
  headers?: Record<string, string>;
  batch: EventBatch;
}

export function fakeNetwork(options: NetworkOptions = {}) {
  /** Every `POST /e` attempt, failed ones included. */
  const attempts: Sent[] = [];
  /** The ones the collector took. */
  const sent: Sent[] = [];
  const answers = [...(options.answers ?? [])];
  const config = options.config === undefined ? { consentMode: 'required' } : options.config;
  const reply = (status: number, body: unknown = {}): FetchResponse => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  const fetch = vi.fn<FetchLike>(async (url, init) => {
    if (url.includes('/c/')) {
      if (config === 'error') throw new TypeError('Network request failed');
      return config === null ? reply(404) : reply(200, config);
    }
    const entry: Sent = { url, headers: init.headers, batch: JSON.parse(String(init.body)) as EventBatch };
    attempts.push(entry);
    const answer = answers.length ? answers.shift() : 204;
    if (answer === 'error') throw new TypeError('Network request failed');
    if (answer !== undefined && answer >= 200 && answer < 300) sent.push(entry);
    return reply(answer ?? 204);
  });

  return {
    fetch,
    attempts,
    sent,
    /** Every event the collector took, in order. */
    events: (): WireEvent[] => ([] as WireEvent[]).concat(...sent.map((s) => s.batch.events)),
    names: (): string[] => ([] as WireEvent[]).concat(...sent.map((s) => s.batch.events)).map((e) => e.name),
  };
}

export interface SetupOptions extends Partial<WeldPanelOptions> {
  network?: NetworkOptions;
  device?: FakeDevice;
}

export function setup(options: SetupOptions = {}) {
  const { network: networkOptions, device: givenDevice, ...rest } = options;
  const net = fakeNetwork(networkOptions);
  const device = givenDevice ?? fakeDevice();
  const storage = 'storage' in rest ? rest.storage : memoryStorage();
  const client = createClient({
    token: TOKEN,
    apiHost: HOST,
    app: { id: 'com.acme.shop', version: '2.1.0', build: '210' },
    ...rest,
    storage,
    platform: device.platform,
    fetch: rest.fetch ?? net.fetch,
  });
  return { panel: client.api, idle: client.idle, net, device, storage: storage as MemoryStorage | undefined };
}
