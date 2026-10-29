/**
 * Runtime configuration: what this deployment offers, read once before the
 * app boots (P4 work package 4.F2, ADR SEC-012).
 *
 * Global (Cloudflare Pages) bakes its settings in as `VITE_*` at build time
 * and never asks for `/config.json`. The Kubernetes editions (EU, self-hosted)
 * describe the deployment at `GET /config.json`, which the Rust backend
 * answers (`config_json` in `rust/bins/weldsuite/src/server.rs`). Every
 * reader goes through this module: runtime config first, the build-time
 * `VITE_*` value as the fallback.
 *
 * ## The build-time switch: `VITE_RUNTIME_CONFIG`
 *
 * Unset or `off` (Global; the Pages deploys `weldsuite-test` and `weldsuite`
 * must not set it): no request, the build-time values only, and no extra
 * round trip before the app loads. `on` (the Kubernetes builds):
 * `/config.json` is fetched before the app is imported, with the fallbacks
 * below. The switch also picks the boot file (`src/boot/mode.ts`). The
 * Kubernetes build is the `spa` stage of `rust/Dockerfile`: the Rust image
 * carries it and serves it on the API's origin (`rust/bins/weldsuite/src/spa.rs`).
 *
 * ## The `/config.json` contract
 *
 * Every field is optional, and unknown fields are ignored, so the backend can
 * grow the document without a frontend release.
 *
 * ```jsonc
 * {
 *   // Which backend serves this deployment. "rust" (Kubernetes) sends every
 *   // API path to `apiBaseUrl`: the one binary serves all ported modules.
 *   // "workers" is the Cloudflare stack (Global).
 *   "backend": "rust",
 *   // Backend version, informational.
 *   "version": "0.1.0",
 *   // `ApiModuleId`s the backend serves (`@weldsuite/api-modules`): "core"
 *   // plus every module ported to Rust. The apps and features of any other
 *   // module are hidden (4.F3, see `lib/edition.ts`). Absent = every module.
 *   "modules": ["core", "know", "sign"],
 *   // Origin of the core API (what Global calls app-api). Default for
 *   // "backend": "rust" is the SPA's own origin.
 *   "apiBaseUrl": "https://weldsuite.example.eu",
 *   // Realtime WebSocket URL (`…/ws`).
 *   "realtimeUrl": "wss://weldsuite.example.eu/ws",
 *   // Who signs people in (`lib/auth`). Absent = Clerk with the build's key.
 *   // The Rust backend fills it from AUTH_PROVIDER=oidc and OIDC_* (its
 *   // `session_verifier` in rust/bins/weldsuite/src/main.rs).
 *   "auth": {
 *     "provider": "oidc",                       // or "clerk"
 *     "issuer": "https://id.example.eu",        // OIDC_ISSUER (discovery base)
 *     "clientId": "300000000000000300",         // OIDC_WEB_CLIENT_ID: public client, PKCE
 *     "audience": "300000000000000100",         // first OIDC_AUDIENCE (Zitadel: the project id)
 *     "orgClaim": "urn:zitadel:iam:org:project:300000000000000100:roles", // OIDC_ORG_CLAIM
 *     // Optional, frontend only (defaults suit Zitadel):
 *     "scopes": ["openid", "profile", "email", "offline_access", "urn:zitadel:iam:org:projects:roles"],
 *     "audienceScope": "urn:zitadel:iam:org:project:id:{audience}:aud",  // "" = none
 *     "organizationScope": "urn:zitadel:iam:org:roles:id:{orgId}",      // "" = no switching
 *     "accountUrl": "https://id.example.eu/ui/console/users/me"
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
import { isRuntimeConfigOn } from '@/src/boot/mode';

const authSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('clerk'),
    publishableKey: z.string().min(1).nullish(),
  }),
  z.object({
    provider: z.literal('oidc'),
    issuer: z.string().url(),
    /** Null when the backend has no OIDC_WEB_CLIENT_ID: the platform can't sign anyone in. */
    clientId: z.string().min(1).nullish(),
    audience: z.string().min(1).nullish(),
    orgClaim: z.string().min(1).nullish(),
    scopes: z.array(z.string().min(1)).optional(),
    audienceScope: z.string().optional(),
    organizationScope: z.string().optional(),
    accountUrl: z.string().url().optional(),
  }),
]);

export const runtimeConfigSchema = z.object({
  backend: z.string().min(1).optional(),
  version: z.string().optional(),
  modules: z.array(z.string().min(1)).optional(),
  apiBaseUrl: z.string().url().optional(),
  realtimeUrl: z.string().url().optional(),
  auth: authSchema.optional(),
  env: z.record(z.string()).optional(),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type AuthConfig = NonNullable<RuntimeConfig['auth']>;
export type OidcAuthConfig = Extract<AuthConfig, { provider: 'oidc' }>;

/** Where the document lives, relative to the SPA's origin. */
export const RUNTIME_CONFIG_PATH = '/config.json';
const LOAD_TIMEOUT_MS = 3000;

let current: RuntimeConfig | null = null;

/** The loaded runtime config, or null when the deployment serves none (Global). */
export function getRuntimeConfig(): RuntimeConfig | null {
  return current;
}

/** Replace the runtime config. Boot calls it once; tests use it to set one up. */
export function setRuntimeConfig(config: RuntimeConfig | null): void {
  current = config;
}

/** Parse a `/config.json` body. Null when it isn't a valid document. */
export function parseRuntimeConfig(body: unknown): RuntimeConfig | null {
  const parsed = runtimeConfigSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
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

/** The deployment runs the Rust backend (Kubernetes): one origin serves every module. */
export function isRustBackend(): boolean {
  return current?.backend === 'rust';
}
