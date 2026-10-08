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

import { and, eq, isNull } from 'drizzle-orm';
import { encryptField, maybeDecryptField, keyringFromEnv, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import { getIntegrationDef, type AppInstallationConfig, type OAuthConfig } from '@weldsuite/workflow-integrations';
import { getGithubInstallationToken } from '@weldsuite/connect-domain/github/app-auth';
import { schema } from '../../../db';
import { resolveIntegration, integrationBearerToken } from '../../integrations';
import { NonRetryableStepError } from '../../errors';
import type { ActionContext } from '../../types';

const REFRESH_WINDOW_MS = 5 * 60_000;

/**
 * Owner check for third-party provider actions (`<provider>.<action>`, the
 * namespaced ids in `@weldsuite/workflow-integrations`). Unlike WeldSuite-typed
 * actions (create_contact, create_task, …), these act on the WORKSPACE's own
 * integration connection, not on data scoped to the owner — the connection was
 * already gated by `integrations:create` at connect time, and nothing about
 * posting a Slack message depends on the owner's CRM/task permissions. So
 * there is no per-object permission to check here, only membership: a run
 * must still refuse once the member who owns the workflow is gone, same as
 * every other action (docs/plans/weldconnect.md, "Phase 1 decisions"). Runs
 * started before owners were carried have no `ownerUserId` (see
 * `WorkflowTenant`) and are let through unchanged.
 *
 * Called once, here, so every current and future provider action gets it for
 * free through `getValidIntegrationToken` / `getIntegrationCredentials`.
 */
async function assertOwnerStillMember(ctx: ActionContext): Promise<void> {
  const ownerUserId = ctx.tenant.ownerUserId;
  if (!ownerUserId) return;
  const [member] = await ctx.db
    .select({ id: schema.workspaceMembers.id })
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.userId, ownerUserId), isNull(schema.workspaceMembers.deletedAt)))
    .limit(1);
  if (!member) {
    throw new NonRetryableStepError(
      "The workflow's owner is no longer a member of this workspace, so it can't use its connected integrations",
    );
  }
}

function maybeDecrypt(value: string, keyring: EncryptionKeyring): Promise<string> {
  // Handles v1 + v2 formats; pre-encryption (plaintext) values pass through.
  return maybeDecryptField(value, keyring);
}

/**
 * Refresh failures the OAuth2 spec (and Google in particular) reports as
 * `invalid_grant` mean the refresh token itself is dead — revoked by the
 * user, expired from inactivity, or the app's consent was pulled. No amount
 * of retrying fixes that; the connection needs to be reconnected. Anything
 * else (network blip, a provider's 5xx, a missing client secret while infra
 * is mid-rollout) is left retryable, since it might resolve on its own.
 */
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
    if (json.error === 'invalid_grant') {
      throw new NonRetryableStepError(
        'The connection is no longer valid (its refresh token was revoked or expired). Reconnect it from WeldConnect → Integrations.',
        { error: json.error },
      );
    }
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

type ResolvedIntegration = Awaited<ReturnType<typeof resolveIntegration>>;

/**
 * Mint a fresh token for an `app_installation`-kind integration — currently
 * only GitHub: its `workflow_integrations` row stores `installationId` in
 * `settings` and has nothing in `credentials`/`oauthTokens` to decrypt at all
 * (see `AppInstallationConfig` in `@weldsuite/workflow-integrations` and
 * "Provider pattern" in docs/plans/weldconnect.md — GitHub reuses WeldFlow's
 * existing GitHub App installation instead of a second OAuth app). Not
 * cached here: `getGithubInstallationToken` already caches per-isolate,
 * keyed by installation id.
 */
async function getAppInstallationToken(
  ctx: ActionContext,
  integ: ResolvedIntegration,
  auth: AppInstallationConfig,
): Promise<string> {
  const appId = ctx.env[auth.appIdEnv] as string | undefined;
  const privateKey = ctx.env[auth.privateKeyEnv] as string | undefined;
  if (!appId || !privateKey) {
    throw new Error(`Missing app installation env (${auth.appIdEnv}/${auth.privateKeyEnv})`);
  }

  const installationId = Number((integ.settings as Record<string, unknown> | undefined)?.installationId);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new NonRetryableStepError(
      `The "${integ.type}" connection has no valid installation configured. Reconnect it from WeldConnect → Integrations.`,
    );
  }

  // Only GitHub implements this auth kind today; the mint mechanism (App JWT
  // → per-installation access token) is GitHub's own App model, not a
  // generic "any app_installation provider" protocol.
  if (integ.type !== 'github') {
    throw new Error(`Integration type "${integ.type}" declares app_installation auth but has no token minter wired up`);
  }
  return getGithubInstallationToken(appId, privateKey, installationId);
}

/**
 * Refresh an expiring OAuth access token via the provider's token endpoint and
 * persist the re-encrypted token. Returns the fresh access token, or `null`
 * when the integration isn't an OAuth2 definition (nothing to refresh).
 */
async function refreshAndPersistToken(
  ctx: ActionContext,
  integ: ResolvedIntegration,
  refreshTokenEncrypted: string,
  key: EncryptionKeyring,
): Promise<string | null> {
  const def = getIntegrationDef(integ.type);
  if (def?.auth.kind !== 'oauth2') return null;
  const refreshToken = await maybeDecrypt(refreshTokenEncrypted, key);
  const refreshed = await refreshOAuthToken(def.auth, refreshToken, ctx.env);
  await ctx.db
    .update(schema.workflowIntegrations)
    .set({
      oauthTokens: {
        accessToken: key.v1 || key.v2 ? await encryptField(refreshed.accessToken, key) : refreshed.accessToken,
        refreshToken: refreshTokenEncrypted,
        expiresAt: refreshed.expiresAt,
      },
      updatedAt: new Date(),
    })
    .where(eq(schema.workflowIntegrations.id, integ.id));
  return refreshed.accessToken;
}

/**
 * Resolve a usable, non-expired access token for the workspace's connected
 * integration of `type` (or a specific `integrationId`).
 */
export async function getValidIntegrationToken(
  ctx: ActionContext,
  params: { type?: string; integrationId?: string },
): Promise<ValidIntegrationToken> {
  await assertOwnerStillMember(ctx);
  const integ = await resolveIntegration(ctx.db, params);
  const def = getIntegrationDef(integ.type);

  // App-installation path (GitHub): no stored secret, mint fresh every time.
  if (def?.auth.kind === 'app_installation') {
    const accessToken = await getAppInstallationToken(ctx, integ, def.auth);
    return { accessToken, integrationId: integ.id };
  }

  const key = keyringFromEnv(ctx.env);
  const tokens = integ.oauthTokens;

  // OAuth path
  if (tokens?.accessToken) {
    let accessToken = await maybeDecrypt(tokens.accessToken, key);
    const expiresMs = tokens.expiresAt ? Date.parse(tokens.expiresAt) : NaN;
    const expiringSoon = Number.isFinite(expiresMs) && expiresMs - Date.now() < REFRESH_WINDOW_MS;

    if (expiringSoon && tokens.refreshToken) {
      accessToken = (await refreshAndPersistToken(ctx, integ, tokens.refreshToken, key)) ?? accessToken;
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
  await assertOwnerStillMember(ctx);
  const integ = await resolveIntegration(ctx.db, params);
  const key = keyringFromEnv(ctx.env);
  const out: Record<string, string> = Object.fromEntries(
    await Promise.all(
      Object.entries(integ.credentials || {}).map(async ([k, v]): Promise<[string, string]> => [
        k,
        typeof v === 'string' ? await maybeDecrypt(v, key) : String(v),
      ]),
    ),
  );
  return { credentials: out, settings: integ.settings, integrationId: integ.id };
}
