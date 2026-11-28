/**
 * From the server choice (plus the build's values or the server's
 * `/config.json`) to the `MobileRuntime` the app reads. Pure.
 */

import type { RuntimeConfig } from '@weldsuite/app-api-client/schemas/runtime-config';
import { trimTrailing } from '../text';
import { normaliseServerAddress } from './address';
import type {
  MobileAppIdentity,
  MobileAuthConfig,
  MobileBuildEnv,
  MobileRuntime,
  ServerChoice,
  ServerKind,
} from './types';

/** `weldsuite serve` (rust/README.md): every module, personal-api and realtime on one origin. */
const LOCAL_APP_API = 'http://localhost:8080';
const LOCAL_PERSONAL_API = `${LOCAL_APP_API}/personal-api`;
const LOCAL_REALTIME = 'ws://localhost:8080';

/**
 * Global's personal-api host for each app-api host: a token from one Clerk
 * instance only verifies on the personal-api of the same environment.
 */
const PERSONAL_API_BY_APP_API: Readonly<Record<string, string>> = {
  'https://app-api-test.weldsuite.org': 'https://personal-api-test.weldsuite.org',
  'https://app-api.weldsuite.org': 'https://personal-api.weldsuite.org',
};

function trimSlash(value: string): string {
  return trimTrailing(value, '/');
}

/** The Rust backend names the socket itself (`wss://host/ws`); the apps append `/ws`. */
function realtimeBase(url: string): string {
  return trimSlash(url).replace(/\/ws$/, '');
}

export function isServerPickerEnabled(build: MobileBuildEnv): boolean {
  return build.serverPicker?.trim().toLowerCase() === 'on';
}

/** Whether the app runs against this kind of server (`MobileAppIdentity.servers`; default all). */
export function offersServer(app: Pick<MobileAppIdentity, 'servers'>, kind: ServerKind): boolean {
  return !app.servers || app.servers.includes(kind);
}

/**
 * Whether the app ships Clerk: only apps that still offer WeldSuite cloud
 * (Global) do. The others refuse a server that signs in through Clerk.
 */
export function shipsClerk(app: Pick<MobileAppIdentity, 'servers'>): boolean {
  return offersServer(app, 'global');
}

/** The EU origin this build knows, normalised; null when unset or invalid. */
export function euOriginOf(build: MobileBuildEnv): string | null {
  if (!build.euServerUrl) return null;
  const result = normaliseServerAddress(build.euServerUrl, { allowInsecure: true });
  return result.ok ? result.origin : null;
}

/** Global's personal-api: paired with app-api when that host is known. */
export function globalPersonalApiOrigin(build: MobileBuildEnv): string {
  const appApi = trimSlash(build.appApiUrl ?? '');
  return PERSONAL_API_BY_APP_API[appApi] ?? trimSlash(build.personalApiUrl || LOCAL_PERSONAL_API);
}

/**
 * Global: the build's own values, as before the server choice existed. Its
 * `.org` hosts now alias the EU server (ADR OPS-025), so every API path goes
 * to `appApiUrl` and nothing is hidden.
 */
export function buildGlobalRuntime(app: MobileAppIdentity, build: MobileBuildEnv): MobileRuntime {
  const apiOrigin = trimSlash(build.appApiUrl || LOCAL_APP_API);
  return {
    app,
    server: { kind: 'global' },
    edition: 'global',
    apiOrigin,
    personalApiOrigin: globalPersonalApiOrigin(build),
    realtimeUrl: trimSlash(build.realtimeUrl || LOCAL_REALTIME),
    platformUrl: trimSlash(build.platformUrl || apiOrigin.replace('//app-api', '//app')),
    auth: { provider: 'clerk', publishableKey: build.clerkPublishableKey ?? '' },
    modules: 'all',
    unavailableFeatures: new Set<string>(),
    env: {},
    videoProvider: null,
    videoUrl: null,
    version: null,
    pushEnabled: true,
    serverPickerEnabled: isServerPickerEnabled(build),
    euOrigin: euOriginOf(build),
  };
}

function authFrom(config: RuntimeConfig): MobileAuthConfig {
  const auth = config.auth;
  if (auth?.provider === 'oidc' && auth.mobileClientId) {
    return {
      provider: 'oidc',
      issuer: auth.issuer,
      clientId: auth.mobileClientId,
      audience: auth.audience ?? null,
      orgClaim: auth.orgClaim ?? null,
      scopes: auth.scopes,
      audienceScope: auth.audienceScope,
      organizationScope: auth.organizationScope,
      accountUrl: auth.accountUrl,
      workspaceSource: auth.workspaceSource,
    };
  }
  if (auth?.provider === 'clerk' && auth.publishableKey) {
    return { provider: 'clerk', publishableKey: auth.publishableKey };
  }
  // assessServerConfig refuses such a server before it gets here.
  throw new Error('This server has no sign-in for the mobile apps');
}

/**
 * EU or self-hosted: one origin serves every module (the Rust backend), so
 * every API path goes to `apiBaseUrl` (default: the server's origin).
 */
export function buildServerRuntime(
  app: MobileAppIdentity,
  build: MobileBuildEnv,
  choice: ServerChoice & { origin: string },
  config: RuntimeConfig,
): MobileRuntime {
  const apiOrigin = trimSlash(config.apiBaseUrl ?? choice.origin);
  return {
    app,
    server: { kind: choice.kind, origin: choice.origin },
    edition: choice.kind === 'eu' ? 'eu' : 'self-hosted',
    apiOrigin,
    personalApiOrigin: `${apiOrigin}/personal-api`,
    // Without one in /config.json, the server's own origin (it serves /ws).
    realtimeUrl: realtimeBase(config.realtimeUrl ?? apiOrigin.replace(/^http/, 'ws')),
    platformUrl: trimSlash(config.env?.VITE_PLATFORM_URL ?? choice.origin),
    auth: authFrom(config),
    modules: config.modules ? new Set(config.modules) : 'all',
    unavailableFeatures: new Set(config.unavailableFeatures ?? []),
    env: { ...config.env },
    videoProvider: config.videoProvider ?? null,
    videoUrl: config.videoUrl ?? null,
    version: config.version ?? null,
    // EU sends through WeldSuite's Expo account like Global; a self-hosted
    // server can't (no push relay yet).
    pushEnabled: choice.kind === 'eu',
    serverPickerEnabled: isServerPickerEnabled(build),
    euOrigin: euOriginOf(build),
  };
}
