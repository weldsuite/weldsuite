/**
 * Integration token resolution for outbound actions.
 *
 * Loads a connected `workflow_integrations` row, decrypts its OAuth access
 * token, and — for providers whose tokens expire (Google) — refreshes via the
 * provider's token endpoint and persists the re-encrypted token back. Slack bot
 * tokens never expire, so this collapses to a plain decrypt for them.
 *
 * Tokens are stored as AES-256-GCM `iv:ciphertext` hex (see
 * `@weldsuite/db/lib/crypto`). Pre-encryption (plaintext) values are tolerated
 * for back-compat.
 */

import { eq } from 'drizzle-orm';
import { encryptField, maybeDecryptField, keyringFromEnv, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import { getIntegrationDef, type OAuthConfig } from '@weldsuite/workflow-integrations';
import { schema } from '../../../db';
import { resolveIntegration, integrationBearerToken } from '../../integrations';
import type { ActionContext } from '../../types';

const REFRESH_WINDOW_MS = 5 * 60_000;

async function maybeDecrypt(value: string, keyring: EncryptionKeyring): Promise<string> {
  // Handles v1 + v2 formats; pre-encryption (plaintext) values pass through.
  return maybeDecryptField(value, keyring);
}

async function refreshOAuthToken(
  auth: OAuthConfig,
  refreshToken: string,
  env: ActionContext['env'],
): Promise<{ accessToken: string; expiresAt?: string }> {
  const clientId = env[auth.clientIdEnv] as string | undefined;
  const clientSecret = env[auth.clientSecretEnv] as string | undefined;
  if (!clientId || !clientSecret) {
    throw new Error(`Missing OAuth client env (${auth.clientIdEnv}/${auth.clientSecretEnv})`);
  }
  const res = await fetch(auth.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Token refresh failed: ${json.error || res.status}`);
  }
  return {
    accessToken: json.access_token,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : undefined,
  };
}

export interface ValidIntegrationToken {
  accessToken: string;
  integrationId: string;
}

/**
 * Resolve a usable, non-expired access token for the workspace's connected
 * integration of `type` (or a specific `integrationId`).
 */
export async function getValidIntegrationToken(
  ctx: ActionContext,
  params: { type?: string; integrationId?: string },
): Promise<ValidIntegrationToken> {
  const integ = await resolveIntegration(ctx.db, params);
  const key = keyringFromEnv(ctx.env);
  const tokens = integ.oauthTokens;

  // OAuth path
  if (tokens?.accessToken) {
    let accessToken = await maybeDecrypt(tokens.accessToken, key);
    const expiresMs = tokens.expiresAt ? Date.parse(tokens.expiresAt) : NaN;
    const expiringSoon = Number.isFinite(expiresMs) && expiresMs - Date.now() < REFRESH_WINDOW_MS;

    if (expiringSoon && tokens.refreshToken) {
      const def = getIntegrationDef(integ.type);
      if (def && def.auth.kind === 'oauth2') {
        const refreshToken = await maybeDecrypt(tokens.refreshToken, key);
        const refreshed = await refreshOAuthToken(def.auth, refreshToken, ctx.env);
        accessToken = refreshed.accessToken;
        await ctx.db
          .update(schema.workflowIntegrations)
          .set({
            oauthTokens: {
              accessToken: key.v1 || key.v2 ? await encryptField(refreshed.accessToken, key) : refreshed.accessToken,
              refreshToken: tokens.refreshToken,
              expiresAt: refreshed.expiresAt,
            },
            updatedAt: new Date(),
          })
          .where(eq(schema.workflowIntegrations.id, integ.id));
      }
    }
    return { accessToken, integrationId: integ.id };
  }

  // API-key / static-credential path
  const bearer = integrationBearerToken(integ);
  if (bearer) {
    return { accessToken: await maybeDecrypt(bearer, key), integrationId: integ.id };
  }

  throw new Error(`Integration "${integ.type}" has no usable token`);
}

export interface ResolvedCredentials {
  credentials: Record<string, string>;
  settings: Record<string, unknown> | undefined;
  integrationId: string;
}

/**
 * Resolve and decrypt the full credential bag for an API-key integration
 * (Twilio SID/token, Notion/Airtable/Asana/GitHub PATs, Teams webhook URL).
 */
export async function getIntegrationCredentials(
  ctx: ActionContext,
  params: { type?: string; integrationId?: string },
): Promise<ResolvedCredentials> {
  const integ = await resolveIntegration(ctx.db, params);
  const key = keyringFromEnv(ctx.env);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(integ.credentials || {})) {
    out[k] = typeof v === 'string' ? await maybeDecrypt(v, key) : String(v);
  }
  return { credentials: out, settings: integ.settings, integrationId: integ.id };
}
