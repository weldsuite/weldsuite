/**
 * Runtime configuration: what this deployment offers, read once before the
 * app boots (P4 work package 4.F2, ADR SEC-012).
 *
 * The deployments (EU, self-hosted) describe themselves at `GET /config.json`,
 * which the Rust backend answers (`config_json` in
 * `rust/bins/weldsuite/src/server.rs`). Every reader goes through this
 * module: runtime config first, the build-time `VITE_*` value as the
 * fallback (a local `pnpm dev` without the switch below).
 *
 * ## The build-time switch: `VITE_RUNTIME_CONFIG`
 *
 * `on` (the Kubernetes builds): `/config.json` is fetched before the app is
 * imported, with the fallbacks below. Unset or `off`: no request, the
 * build-time values only. The switch also picks the boot file
 * (`src/boot/mode.ts`). The Kubernetes build is the `spa` stage of
 * `rust/Dockerfile`: the Rust image carries it and serves it on the API's
 * origin (`rust/bins/weldsuite/src/spa.rs`).
 *
 * ## The `/config.json` contract
 *
 * Every field is optional, and unknown fields are ignored, so the backend can
 * grow the document without a frontend release.
 *
 * ```jsonc
 * {
 *   // Which backend serves this deployment: "rust". Informational: one
 *   // origin serves every module.
 *   "backend": "rust",
 *   // Backend version, informational.
 *   "version": "0.1.0",
 *   // Which edition this is: "eu" or "self-hosted". Informational.
 *   "edition": "eu",
 *   // `ApiModuleId`s the backend serves (`API_MODULE_IDS` in
 *   // `@weldsuite/app-api-client/schemas/runtime-config`): "core" plus the
 *   // `weld*` modules. The apps and features of any other module are hidden
 *   // (4.F3, see `lib/edition.ts`). Absent = every module.
 *   "modules": ["core", "know", "sign"],
 *   // Features the backend lacks inside the modules it serves
 *   // (`EditionFeature` in `lib/edition.ts`); the platform hides them.
 *   // Absent = none. Names this build doesn't know are ignored.
 *   "unavailableFeatures": ["billing", "sso-connections"],
 *   // Who bills plans (ADR BILL-014): "mollie" when the deployment has plan
 *   // billing on Mollie (`billing` is then not in `unavailableFeatures`).
 *   // Absent = Stripe (`billingProvider()` in `lib/edition.ts`).
 *   // `reach-billing` is listed in `unavailableFeatures` whenever WeldReach
 *   // inbox billing is not on Mollie.
 *   "billingProvider": "mollie",
 *   // Origin of the API, which serves every path of every module. Default:
 *   // the SPA's own origin (`lib/api/public-env.ts`).
 *   "apiBaseUrl": "https://weldsuite.example.eu",
 *   // Realtime WebSocket URL (`…/ws`). Absent = realtime is off.
 *   "realtimeUrl": "wss://weldsuite.example.eu/ws",
 *   // Which client joins WeldMeet rooms: "livekit" or "realtimekit" (absent
 *   // = RealtimeKit, Global's), and the LiveKit server it connects to. The
 *   // Rust backend writes them from VIDEO_PROVIDER and LIVEKIT_URL
 *   // (`lib/video-provider.ts`).
 *   "videoProvider": "livekit",
 *   "videoUrl": "wss://livekit.example.eu",
 *   // Who signs people in (`lib/auth`). Absent = Clerk with the build's key.
 *   // The Rust backend fills it from AUTH_PROVIDER=oidc and OIDC_* (its
 *   // `session_verifier` in rust/bins/weldsuite/src/main.rs).
 *   "auth": {
 *     "provider": "oidc",                       // or "clerk"
 *     "issuer": "https://id.example.eu",        // OIDC_ISSUER (discovery base)
 *     "clientId": "300000000000000300",         // OIDC_WEB_CLIENT_ID: public client, PKCE
 *     "mobileClientId": "300000000000000400",   // OIDC_MOBILE_CLIENT_ID: the mobile apps' native client
 *     // OIDC_DESKTOP_CLIENT_ID: the desktop app's native client (system
 *     // browser, loopback redirect; apps/desktop/docs/auth-handoff.md)
 *     "desktopClientId": "300000000000000500",
 *     // OIDC_EXTENSION_CLIENT_ID: the WeldPass browser extension's client
 *     // (chromiumapp.org redirect; apps/web/weldpass-extension, ADR PASS-009)
 *     "extensionClientId": "300000000000000600",
 *     "audience": "300000000000000100",         // first OIDC_AUDIENCE (Zitadel: the project id)
 *     "orgClaim": "urn:zitadel:iam:org:project:300000000000000100:roles", // OIDC_ORG_CLAIM
 *     // Optional, frontend only (defaults suit Zitadel):
 *     "scopes": ["openid", "profile", "email", "offline_access", "urn:zitadel:iam:org:projects:roles"],
 *     "audienceScope": "urn:zitadel:iam:org:project:id:{audience}:aud",  // "" = none
 *     "organizationScope": "urn:zitadel:iam:org:roles:id:{orgId}",      // "" = no switching
 *     "accountUrl": "https://id.example.eu/ui/console/users/me",
 *     // "weldid" when the provider is WeldID, WeldSuite's own (IDENTITY_PROVIDER=weldid):
 *     // Settings › Security then names WeldID rather than "your organization's
 *     // identity provider". Absent or null: some other provider.
 *     "identityProvider": "weldid",
 *     // Who shows the sign-in screens. "platform": WeldSuite's own, the ones
 *     // Global shows, over the backend's /api/sign-in (OIDC_SIGN_IN=platform,
 *     // ADR SEC-016). Absent or "provider": the provider's pages.
 *     "signIn": "platform",
 *     // Where the active workspace comes from (WeldID, plan
 *     // weldid-auth-server.md): "claim" (default, Zitadel's org-scoped roles
 *     // claim) or "header" (the token names no workspace; every API request
 *     // carries it as X-Weld-Workspace, and switching workspace is local,
 *     // no re-authorization). With "header", audienceScope and
 *     // organizationScope are normally null (WeldID has neither notion).
 *     "workspaceSource": "header"
 *   },
 *   // The AI this install runs (only when a default provider is configured):
 *   // the settings page (`/settings/ai`) and every model picker need it, and the
 *   // AI features are offered only with it (`lib/edition.ts`, `getAiConfig`).
 *   "ai": {
 *     "defaultProvider": "mistral",
 *     "providers": [{ "id": "mistral", "region": "eu", "keySources": ["weldsuite"] }]
 *   },
 *   // Any other public build-time value, by its `VITE_*` name. Wins over the
 *   // baked-in value (`VITE_STRIPE_PUBLISHABLE_KEY`, `VITE_MAPBOX_ACCESS_TOKEN`, …).
 *   "env": { "VITE_MEETING_PORTAL_URL": "https://meet.example.eu" }
 * }
 * ```
 *
 * With `auth.provider: "clerk"`, `auth.publishableKey` replaces
 * `VITE_CLERK_PUBLISHABLE_KEY`. How the OIDC fields pick the active
 * workspace: `lib/auth/oidc/claims.ts`.
 *
 * With the switch on, a bad answer never stops the app: a missing file, an
 * HTML answer (an SPA fallback serving `index.html` for unknown paths),
 * invalid JSON, a document that breaks the contract or a slow answer (3 s)
 * all fall back to the build-time values.
 */

import { z } from 'zod';
import {
  RUNTIME_CONFIG_PATH,
  runtimeConfigSchema as sharedRuntimeConfigSchema,
  type RuntimeAuthConfig,
  type RuntimeOidcAuthConfig,
} from '@weldsuite/app-api-client/schemas/runtime-config';
import { isRuntimeConfigOn } from '@/src/boot/mode';

export { RUNTIME_CONFIG_PATH };

/**
 * The contract itself (Zod v3) is shared with the mobile apps; `billingProvider`
 * is read by the platform only (ADR BILL-014), so it is added here. A value
 * this build doesn't know reads as absent (Stripe).
 */
export const runtimeConfigSchema = sharedRuntimeConfigSchema.extend({
  billingProvider: z.enum(['stripe', 'mollie']).optional().catch(undefined),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type AuthConfig = RuntimeAuthConfig;
export type OidcAuthConfig = RuntimeOidcAuthConfig;

/** Parse a `/config.json` body. Null when it isn't a valid document. */
export function parseRuntimeConfig(body: unknown): RuntimeConfig | null {
  const parsed = runtimeConfigSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

const LOAD_TIMEOUT_MS = 3000;

let current: RuntimeConfig | null = null;

/** The loaded runtime config, or null when there is none (the switch is off, or it failed to load). */
export function getRuntimeConfig(): RuntimeConfig | null {
  return current;
}

/** Replace the runtime config. Boot calls it once; tests use it to set one up. */
export function setRuntimeConfig(config: RuntimeConfig | null): void {
  current = config;
}

/**
 * Fetch and parse `/config.json`. Resolves to null (never rejects) when there
 * is none, so the caller can always fall back to the build-time values.
 */
export async function fetchRuntimeConfig(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = LOAD_TIMEOUT_MS,
): Promise<RuntimeConfig | null> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(RUNTIME_CONFIG_PATH, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller?.signal,
    });
    if (!res.ok) return null;
    // Pages answers unknown paths with index.html (200, text/html).
    if (!(res.headers.get('content-type') ?? '').includes('json')) return null;
    const config = parseRuntimeConfig(await res.json());
    if (!config) console.warn(`${RUNTIME_CONFIG_PATH} is not a valid runtime config; using the build-time settings`);
    return config;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Whether this build reads `/config.json` (`VITE_RUNTIME_CONFIG=on`). */
export function isRuntimeConfigEnabled(): boolean {
  return isRuntimeConfigOn(import.meta.env.VITE_RUNTIME_CONFIG as string | undefined);
}

/**
 * Load `/config.json` and keep it for every later reader. Called once, before
 * the first render, by the Kubernetes boot. With the switch off it requests
 * nothing and resolves to null: the build-time values apply.
 */
export async function loadRuntimeConfig(fetchImpl?: typeof fetch): Promise<RuntimeConfig | null> {
  const config = isRuntimeConfigEnabled() ? await fetchRuntimeConfig(fetchImpl) : null;
  setRuntimeConfig(config);
  return config;
}

/**
 * A public setting by its `VITE_*` name: the runtime config's `env` map
 * first, then the structured fields that stand for it, then the value Vite
 * baked in at build time. Empty strings count as unset.
 */
export function publicEnv(key: `VITE_${string}`): string | undefined {
  const fromRuntime = runtimeValue(key);
  if (fromRuntime) return fromRuntime;
  const baked = (import.meta.env as Record<string, string | boolean | undefined>)[key];
  return typeof baked === 'string' && baked !== '' ? baked : undefined;
}

function runtimeValue(key: string): string | undefined {
  const config = current;
  if (!config) return undefined;
  const explicit = config.env?.[key];
  if (explicit) return explicit;
  switch (key) {
    case 'VITE_APP_API_URL':
      return config.apiBaseUrl;
    case 'VITE_REALTIME_URL':
      return config.realtimeUrl;
    case 'VITE_CLERK_PUBLISHABLE_KEY':
      return config.auth?.provider === 'clerk' ? (config.auth.publishableKey ?? undefined) : undefined;
    default:
      return undefined;
  }
}

/** True when the runtime config set this key (so it is trusted as-is, even on a hosted origin). */
export function isRuntimeEnv(key: `VITE_${string}`): boolean {
  return Boolean(runtimeValue(key));
}

/**
 * WeldDesk's helpdesk widget origin when the deployment serves its own
 * (`/config.json`'s `helpdeskWidgetUrl`, e.g. `https://widget.weldsuite.eu`).
 * Undefined otherwise, and the SDK's default host applies.
 */
export function getHelpdeskWidgetUrl(): string | undefined {
  return current?.helpdeskWidgetUrl;
}
