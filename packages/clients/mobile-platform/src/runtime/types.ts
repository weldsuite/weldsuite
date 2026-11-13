/**
 * Which WeldSuite deployment a mobile app talks to, and everything the app
 * reads from that choice (docs/plans/mobile-server-choice.md, ADR MOB-006).
 *
 * - **global**: WeldSuite cloud. The hosts and Clerk key baked into the
 *   build by `eas.json` (`EXPO_PUBLIC_*`), exactly as before the switch.
 * - **eu**: the EU edition, at the origin this build names in
 *   `EXPO_PUBLIC_EU_SERVER_URL`. Described by its `/config.json`.
 * - **self-hosted**: an address the person types. Described by its
 *   `/config.json`, like EU.
 */

import type { ApiModuleId } from '@weldsuite/api-modules';
import type { RuntimeConfig } from '@weldsuite/app-api-client/schemas/runtime-config';

export type ServerKind = 'global' | 'eu' | 'self-hosted';

/** What the person picked; saved on the device. */
export interface ServerChoice {
  kind: ServerKind;
  /** The server's origin (`https://host[:port]`). Absent for Global. */
  origin?: string;
}

/**
 * What the build bakes in. The app passes its own `process.env.EXPO_PUBLIC_*`
 * reads (Expo inlines them only in the app's own code).
 */
export interface MobileBuildEnv {
  /** `EXPO_PUBLIC_APP_API_URL`: Global's app-api. */
  appApiUrl?: string;
  /** `EXPO_PUBLIC_API_MODULES`: Global modules served by their own worker. */
  apiModules?: string;
  /** `EXPO_PUBLIC_PERSONAL_API_URL`: Global's personal-api. */
  personalApiUrl?: string;
  /** `EXPO_PUBLIC_REALTIME_URL`: Global's realtime WebSocket. */
  realtimeUrl?: string;
  /** `EXPO_PUBLIC_PLATFORM_URL`: Global's web app. */
  platformUrl?: string;
  /** `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`: Global's Clerk instance. */
  clerkPublishableKey?: string;
  /** `EXPO_PUBLIC_EU_SERVER_URL`: the EU edition's origin; unset hides EU. */
  euServerUrl?: string;
  /** `EXPO_PUBLIC_SERVER_PICKER`: `on` shows the server picker. Off by default. */
  serverPicker?: string;
}

/** Who the app is, for the checks a server must pass. */
export interface MobileAppIdentity {
  /** App code and URL scheme: `weldmail`. */
  code: string;
  /** Display name: `WeldMail`. */
  name: string;
  /** URL scheme for sign-in redirects, when it differs from `code`. */
  scheme?: string;
  /** API modules the app can't work without, besides core. */
  requiredModules: readonly ApiModuleId[];
  /**
   * Further server requirements (true = this server can run the app), such
   * as WeldMeet needing the RealtimeKit video provider.
   */
  supportsServer?: (config: RuntimeConfig) => boolean;
}

export interface ClerkMobileAuth {
  provider: 'clerk';
  publishableKey: string;
}

export interface OidcMobileAuth {
  provider: 'oidc';
  issuer: string;
  /** The native client (`OIDC_MOBILE_CLIENT_ID`). */
  clientId: string;
  audience?: string | null;
  orgClaim?: string | null;
  scopes?: string[];
  audienceScope?: string;
  organizationScope?: string;
  accountUrl?: string;
}

export type MobileAuthConfig = ClerkMobileAuth | OidcMobileAuth;

export type MobileEdition = 'global' | 'eu' | 'self-hosted';

/** Everything the app reads about its server. Fixed for the JS lifetime. */
export interface MobileRuntime {
  app: MobileAppIdentity;
  server: ServerChoice;
  edition: MobileEdition;
  /** app-api on Global; the server's origin on Kubernetes. */
  apiOrigin: string;
  /** Modules with their own worker host (Global); empty on Kubernetes. */
  apiModules: ReadonlySet<ApiModuleId>;
  /** personal-api: its own host on Global, `<origin>/personal-api` on Kubernetes. */
  personalApiOrigin: string;
  /**
   * Realtime base URL, without `/ws`: clients append `/ws` (or
   * `/ws/personal`, `/ws/conversation/:id`) as they always have.
   */
  realtimeUrl: string;
  /** The web app, for links that open it. */
  platformUrl: string;
  auth: MobileAuthConfig;
  /** Modules the server serves; `all` on Global. */
  modules: ReadonlySet<string> | 'all';
  /** Features the server lacks (`EditionFeature` names). */
  unavailableFeatures: ReadonlySet<string>;
  /** Public settings from `/config.json` `env`, by their `VITE_*` name. */
  env: Readonly<Record<string, string>>;
  videoProvider: string | null;
  videoUrl: string | null;
  /** Backend version from `/config.json`; null on Global. */
  version: string | null;
  /**
   * Push notifications. Global only until the content-free relay exists:
   * EU promises push without content and a self-hosted server can't send
   * through WeldSuite's Expo account.
   */
  pushEnabled: boolean;
  /** This build shows the server picker. */
  serverPickerEnabled: boolean;
  /** The EU origin this build knows, or null. */
  euOrigin: string | null;
}

/** Why a server can't be used by this app. */
export type ServerProblem =
  /** No answer, or not a WeldSuite server. */
  | 'unreachable'
  /** Answers, but `/config.json` isn't a Kubernetes WeldSuite document. */
  | 'not-weldsuite'
  /** No way for the app to sign in (no `auth`, no mobile client). */
  | 'no-mobile-sign-in'
  /** The server doesn't run this app's module (or its video provider). */
  | 'app-unavailable';
