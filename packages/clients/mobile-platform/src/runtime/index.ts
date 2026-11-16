/**
 * `@weldsuite/mobile-platform/runtime`: which server the app talks to.
 *
 * ```ts
 * // lib/server.ts in an app
 * export const APP = { code: 'weldmail', name: 'WeldMail', requiredModules: ['mail'] };
 * export const BUILD = { appApiUrl: process.env.EXPO_PUBLIC_APP_API_URL, ... };
 *
 * // app/_layout.tsx
 * <ServerRuntimeGate app={APP} build={BUILD}>…</ServerRuntimeGate>
 *
 * // anywhere, inside a function or component:
 * getMobileRuntime().apiOrigin
 * ```
 *
 * See weldsuite-documentation/plans/mobile-server-choice.md and ADR MOB-006.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';
import { DevSettings } from 'react-native';
import { signOutActive } from '../auth/active';
import { normaliseServerAddress } from './address';
import { assessServerConfig, fetchServerConfig } from './server-config';
import {
  getMobileRuntime,
  peekMobileRuntime,
  resolveMobileRuntime,
  setMobileRuntime,
  type BootResult,
  type KeyValueStore,
} from './state';
import { performServerSwitch } from './switch';
import type { MobileAppIdentity, MobileBuildEnv, ServerChoice, ServerProblem } from './types';
import type { RuntimeConfig } from '@weldsuite/app-api-client/schemas/runtime-config';

export * from './types';
export { hostOf, normaliseServerAddress, type AddressResult } from './address';
export { getMobileRuntime, peekMobileRuntime, setMobileRuntime, type BootResult } from './state';
export { onClearServerData, onLeaveServer } from './switch';
export { isServerPickerEnabled, euOriginOf } from './build';

const store: KeyValueStore = AsyncStorage;

/** Boot the runtime for this app. A ready result is kept for `getMobileRuntime()`. */
export async function bootMobileRuntime(app: MobileAppIdentity, build: MobileBuildEnv): Promise<BootResult> {
  const result = await resolveMobileRuntime({ app, build, store });
  if (result.status === 'ready') setMobileRuntime(result.runtime);
  return result;
}

export type ServerCheck =
  | { ok: true; origin: string; config: RuntimeConfig }
  | { ok: false; problem: ServerProblem | 'invalid-address' | 'insecure-address' };

/**
 * Before saving a self-hosted address: is it a WeldSuite server this app can
 * use? (Address syntax, `/config.json`, mobile sign-in, the app's module.)
 */
export async function checkServerAddress(
  input: string,
  app: MobileAppIdentity,
  options: { allowInsecure?: boolean } = {},
): Promise<ServerCheck> {
  const address = normaliseServerAddress(input, options);
  if (!address.ok) {
    return { ok: false, problem: address.reason === 'insecure' ? 'insecure-address' : 'invalid-address' };
  }
  return checkServerOrigin(address.origin, app);
}

/** Same check for an origin the build already knows (EU). */
export async function checkServerOrigin(origin: string, app: MobileAppIdentity): Promise<ServerCheck> {
  const fetched = await fetchServerConfig(origin);
  if (!fetched.ok) return { ok: false, problem: fetched.problem };
  const problem = assessServerConfig(fetched.config, app);
  if (problem) return { ok: false, problem };
  return { ok: true, origin, config: fetched.config };
}

async function reloadApp(): Promise<void> {
  try {
    await Updates.reloadAsync();
  } catch {
    // Development builds without expo-updates enabled.
    DevSettings.reload();
  }
}

/**
 * Leave the current server (push token, sign-out, local data), save `next`
 * and restart the app on it. Resolves only if the restart doesn't happen.
 */
export async function switchServer(next: ServerChoice): Promise<void> {
  await performServerSwitch(next, {
    store,
    runtime: peekMobileRuntime(),
    signOut: signOutActive,
    reload: reloadApp,
  });
}

/** The server the app runs against, for display ("WeldSuite cloud", a host). */
export function currentServer(): ServerChoice {
  return getMobileRuntime().server;
}
