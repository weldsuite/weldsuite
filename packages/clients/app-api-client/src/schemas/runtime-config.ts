/**
 * The `/config.json` contract (ADR SEC-012, P4 work package 4.F2): what a
 * Kubernetes deployment (EU, self-hosted) tells its clients about itself.
 * The Rust backend answers it (`config_json` in
 * `rust/bins/weldsuite/src/server.rs`); Global serves none.
 *
 * Shared by the platform (`apps/web/platform/lib/runtime-config.ts`, which
 * documents every field) and the mobile apps
 * (`@weldsuite/mobile-platform`, weldsuite-documentation/plans/mobile-server-choice.md), so both
 * read the same document the same way. Every field is optional and unknown
 * fields are ignored, so the backend can grow it without a client release.
 * Zod v3.
 */

import { z } from 'zod';
import { runtimeAiConfigSchema } from './ai-settings';

export const runtimeAuthSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('clerk'),
    publishableKey: z.string().min(1).nullish(),
  }),
  z.object({
    provider: z.literal('oidc'),
    issuer: z.string().url(),
    /** The platform's public client. Null when the backend has no OIDC_WEB_CLIENT_ID. */
    clientId: z.string().min(1).nullish(),
    /**
     * The mobile apps' public native client (`OIDC_MOBILE_CLIENT_ID`). Null
     * or absent: the mobile apps can't sign in to this server.
     */
    mobileClientId: z.string().min(1).nullish(),
    audience: z.string().min(1).nullish(),
    orgClaim: z.string().min(1).nullish(),
    scopes: z.array(z.string().min(1)).optional(),
    audienceScope: z.string().optional(),
    organizationScope: z.string().optional(),
    accountUrl: z.string().url().optional(),
    /**
     * Who shows the sign-in screens on the web (`OIDC_SIGN_IN`, ADR SEC-016):
     * `platform` = WeldSuite's own over the backend's `/api/sign-in`, absent or
     * `provider` = the provider's pages. A value this build doesn't know reads
     * as the provider's pages, never as a broken document.
     */
    signIn: z.enum(['provider', 'platform']).optional().catch(undefined),
  }),
]);

export const runtimeConfigSchema = z.object({
  backend: z.string().min(1).optional(),
  version: z.string().optional(),
  edition: z.string().min(1).optional(),
  modules: z.array(z.string().min(1)).optional(),
  unavailableFeatures: z.array(z.string().min(1)).optional(),
  apiBaseUrl: z.string().url().optional(),
  realtimeUrl: z.string().url().optional(),
  // Checked where they are used, so a bad value only stops joining a
  // meeting, never the whole document.
  videoProvider: z.string().min(1).optional(),
  videoUrl: z.string().min(1).optional(),
  auth: runtimeAuthSchema.optional(),
  /**
   * The AI the install runs (plan eu-ai-mistral): present only when a default
   * provider is configured. A block this build can't read counts as absent.
   */
  ai: runtimeAiConfigSchema.optional().catch(undefined),
  env: z.record(z.string()).optional(),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type RuntimeAuthConfig = NonNullable<RuntimeConfig['auth']>;
export type RuntimeOidcAuthConfig = Extract<RuntimeAuthConfig, { provider: 'oidc' }>;

/** Where the document lives, relative to the deployment's origin. */
export const RUNTIME_CONFIG_PATH = '/config.json';

/** Parse a `/config.json` body. Null when it isn't a valid document. */
export function parseRuntimeConfig(body: unknown): RuntimeConfig | null {
  const parsed = runtimeConfigSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
