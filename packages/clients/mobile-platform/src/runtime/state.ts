/**
 * Boot: read the saved server choice, describe that server, and keep the
 * result as the app's `MobileRuntime` for the rest of the JS lifetime.
 * Changing server saves a new choice and reloads the app (`switch.ts`), so
 * nothing ever changes the runtime under a mounted tree.
 *
 * Pure apart from the injected store and `fetch` (the public entry,
 * `index.ts`, injects AsyncStorage and the global `fetch`).
 */

import {
  parseRuntimeConfig,
  type RuntimeConfig,
} from '@weldsuite/app-api-client/schemas/runtime-config';
import { normaliseServerAddress } from './address';
import { buildGlobalRuntime, buildServerRuntime, euOriginOf, isServerPickerEnabled, offersServer } from './build';
import { assessServerConfig, fetchServerConfig } from './server-config';
import type {
  MobileAppIdentity,
  MobileBuildEnv,
  MobileRuntime,
  ServerChoice,
  ServerProblem,
} from './types';

/** Async key-value storage (AsyncStorage on the device). */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const SERVER_CHOICE_KEY = 'weldsuite:server';
const configKey = (origin: string) => `weldsuite:server-config:${origin}`;

function isServerKind(value: unknown): value is ServerChoice['kind'] {
  return value === 'global' || value === 'eu' || value === 'self-hosted';
}

export async function readServerChoice(store: KeyValueStore): Promise<ServerChoice | null> {
  try {
    const raw = await store.getItem(SERVER_CHOICE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { kind?: unknown; origin?: unknown };
    if (!isServerKind(parsed.kind)) return null;
    if (parsed.kind === 'self-hosted') {
      if (typeof parsed.origin !== 'string') return null;
      const address = normaliseServerAddress(parsed.origin, { allowInsecure: true });
      return address.ok ? { kind: 'self-hosted', origin: address.origin } : null;
    }
    return { kind: parsed.kind };
  } catch {
    return null;
  }
}

export async function saveServerChoice(store: KeyValueStore, choice: ServerChoice): Promise<void> {
  if (choice.kind === 'global') {
    await store.removeItem(SERVER_CHOICE_KEY);
    return;
  }
  // EU's origin comes from the build, so a new build can move it.
  const saved = choice.kind === 'eu' ? { kind: 'eu' } : { kind: choice.kind, origin: choice.origin };
  await store.setItem(SERVER_CHOICE_KEY, JSON.stringify(saved));
}

export async function readCachedServerConfig(
  store: KeyValueStore,
  origin: string,
): Promise<RuntimeConfig | null> {
  try {
    const raw = await store.getItem(configKey(origin));
    return raw ? parseRuntimeConfig(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export async function cacheServerConfig(
  store: KeyValueStore,
  origin: string,
  config: RuntimeConfig,
): Promise<void> {
  try {
    await store.setItem(configKey(origin), JSON.stringify(config));
  } catch {
    // Not cached: the next start asks the server again.
  }
}

export async function forgetServerConfig(store: KeyValueStore, origin: string): Promise<void> {
  try {
    await store.removeItem(configKey(origin));
  } catch {
    // Nothing cached.
  }
}

export interface ResolveRuntimeOptions {
  app: MobileAppIdentity;
  build: MobileBuildEnv;
  store: KeyValueStore;
  fetchImpl?: typeof fetch;
  /** Called with a fresh `/config.json` fetched after a cached one was used. */
  onRefreshed?: (config: RuntimeConfig) => void;
}

export type BootResult =
  | { status: 'ready'; runtime: MobileRuntime }
  | {
      status: 'failed';
      choice: ServerChoice & { origin: string };
      problem: ServerProblem;
      /** The app's identity and build, so the error screen can offer a way back. */
      app: MobileAppIdentity;
      build: MobileBuildEnv;
    };

/** A build that leaves the app no server to start on (an EU-only app without `EXPO_PUBLIC_EU_SERVER_URL`). */
export class NoServerError extends Error {
  constructor(app: MobileAppIdentity) {
    super(
      `${app.name} runs on WeldSuite EU, but this build names no EU server: set EXPO_PUBLIC_EU_SERVER_URL.`,
    );
    this.name = 'NoServerError';
  }
}

/**
 * Where the app starts when nothing (usable) is saved: WeldSuite cloud while
 * the app offers it, else the EU server this build names.
 */
function defaultServerChoice(app: MobileAppIdentity, build: MobileBuildEnv): ServerChoice {
  if (offersServer(app, 'global')) return { kind: 'global' };
  const origin = offersServer(app, 'eu') ? euOriginOf(build) : null;
  if (!origin) throw new NoServerError(app);
  return { kind: 'eu', origin };
}

/**
 * The server this device should use: the saved choice, resolved against
 * this build and the servers the app offers.
 */
export async function resolveServerChoice(
  app: MobileAppIdentity,
  build: MobileBuildEnv,
  store: KeyValueStore,
): Promise<ServerChoice> {
  const fallback = () => defaultServerChoice(app, build);
  // With the picker off the app always starts on its default server.
  if (!isServerPickerEnabled(build)) return fallback();
  const saved = await readServerChoice(store);
  if (!saved || !offersServer(app, saved.kind)) return fallback();
  if (saved.kind === 'global') return saved;
  if (saved.kind === 'eu') {
    const origin = euOriginOf(build);
    return origin ? { kind: 'eu', origin } : fallback();
  }
  return saved;
}

/**
 * Work out the runtime. Global needs no request. EU and self-hosted use the
 * cached `/config.json` when there is one (so the app opens offline and
 * without waiting) and refresh it in the background for the next start;
 * without a cached copy they wait for the server (5 s).
 */
export async function resolveMobileRuntime(options: ResolveRuntimeOptions): Promise<BootResult> {
  const { app, build, store } = options;
  const choice = await resolveServerChoice(app, build, store);
  if (choice.kind === 'global' || !choice.origin) {
    return { status: 'ready', runtime: buildGlobalRuntime(app, build) };
  }
  const target = { kind: choice.kind, origin: choice.origin };

  let config = await readCachedServerConfig(store, target.origin);
  if (config && !assessServerConfig(config, app)) {
    void fetchServerConfig(target.origin, { fetchImpl: options.fetchImpl }).then(async (fresh) => {
      if (!fresh.ok) return;
      await cacheServerConfig(store, target.origin, fresh.config);
      options.onRefreshed?.(fresh.config);
    });
  } else {
    // No cached copy, or one this app couldn't use (say, from before the
    // server allowed the mobile apps): ask the server now.
    const fetched = await fetchServerConfig(target.origin, { fetchImpl: options.fetchImpl });
    if (!fetched.ok) return { status: 'failed', choice: target, problem: fetched.problem, app, build };
    config = fetched.config;
    await cacheServerConfig(store, target.origin, config);
  }

  const problem = assessServerConfig(config, app);
  if (problem) return { status: 'failed', choice: target, problem, app, build };
  return { status: 'ready', runtime: buildServerRuntime(app, build, target, config) };
}

let current: MobileRuntime | null = null;

/** Keep the booted runtime. Boot calls it once; tests use it to set one up. */
export function setMobileRuntime(runtime: MobileRuntime | null): void {
  current = runtime;
}

/** The booted runtime, or null before boot. */
export function peekMobileRuntime(): MobileRuntime | null {
  return current;
}

/**
 * The booted runtime. Throws before boot: read it inside functions and
 * components, never at module level (modules load before the boot gate).
 */
export function getMobileRuntime(): MobileRuntime {
  if (!current) {
    throw new Error(
      'The mobile runtime is not booted yet. Read it inside a function or component rendered under <ServerRuntimeGate>.',
    );
  }
  return current;
}
