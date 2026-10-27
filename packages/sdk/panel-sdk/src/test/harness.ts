/** Test helpers: a client on a fake network, and a clean page between tests. */

import { vi } from 'vitest';
import { createClient, type Client, type ClientOptions } from '../client';
import type { ClientConfig, EventBatch, WireEvent } from '../wire';

export const TOKEN = 'wpk_0123456789abcdef0123456789abcdef';
export const HOST = 'https://pnl.example.org';

export interface Sent {
  via: 'fetch' | 'beacon';
  url: string;
  init?: RequestInit;
  blobType?: string;
  batch: EventBatch;
}

export interface NetworkOptions {
  /** `true`: sendBeacon accepts; `'refuse'`: it returns false; `false`: there is none. */
  beacon?: boolean | 'refuse';
  /** What `GET /c/:token` answers; `null` for a 404. */
  config?: Partial<ClientConfig> | null;
  /** Reject this many `POST /e` fetches with a network error first. */
  networkFailures?: number;
}

const cleanups: Array<() => void> = [];

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/** Override a property (jsdom's `scrollY`, `navigator.sendBeacon`, …) until the test ends. */
export function defineOn(target: object, key: string, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  cleanups.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else Reflect.deleteProperty(target, key);
  });
}

export function installNetwork(options: NetworkOptions = {}) {
  const fetched: Sent[] = [];
  const beaconed: Array<{ url: string; blob: Blob }> = [];
  let failures = options.networkFailures ?? 0;
  const config = options.config === undefined ? {} : options.config;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/c/')) {
      return (config === null
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => config }) as unknown as Response;
    }
    if (failures > 0) {
      failures--;
      throw new TypeError('Failed to fetch');
    }
    fetched.push({ via: 'fetch', url, init, batch: JSON.parse(String(init?.body)) as EventBatch });
    return { ok: true, status: 204 } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);

  const beaconMock = vi.fn((url: string | URL, data?: BodyInit | null): boolean => {
    if (options.beacon === 'refuse') return false;
    beaconed.push({ url: String(url), blob: data as Blob });
    return true;
  });
  if (options.beacon) defineOn(navigator, 'sendBeacon', beaconMock);

  return {
    fetchMock,
    beaconMock,
    /** Everything sent so far, fetch and beacon, in a stable order (fetches first). */
    async sent(): Promise<Sent[]> {
      const beacons = await Promise.all(
        beaconed.map(async (b) => ({
          via: 'beacon' as const,
          url: b.url,
          blobType: b.blob.type,
          batch: JSON.parse(await blobText(b.blob)) as EventBatch,
        })),
      );
      return [...fetched, ...beacons];
    },
    async events(): Promise<WireEvent[]> {
      return ([] as WireEvent[]).concat(...(await this.sent()).map((s) => s.batch.events));
    },
    async names(): Promise<string[]> {
      return (await this.events()).map((e) => e.name);
    },
  };
}

export type Network = ReturnType<typeof installNetwork>;

/** A started client on a fake network. */
export function setup(
  config: Partial<ClientConfig> = {},
  options: NetworkOptions & Partial<ClientOptions> = {},
): { client: Client; net: Network } {
  const net = installNetwork(options);
  const client = createClient({ token: TOKEN, host: HOST, debug: options.debug });
  cleanups.push(() => client.destroy());
  client.start({ autocapture: true, consentMode: 'required', maskingLevel: 'balanced', excludedUrls: [], ...config });
  return { client, net };
}

export function onCleanup(cleanup: () => void): void {
  cleanups.push(cleanup);
}

/** Undo everything a test changed: clients, globals, storage, URL, DOM. */
export function resetPage(): void {
  for (const undo of cleanups.splice(0).reverse()) undo();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '';
  document.title = '';
  history.replaceState(null, '', '/');
  delete (window as unknown as { weldpanel?: unknown }).weldpanel;
}
