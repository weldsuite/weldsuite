/**
 * `ConnectorDriver` — the one interface every WeldSuite connector implements.
 *
 * Promoted from the CRM sync engine's `CrmSyncAdapter`, which was already
 * provider-agnostic enough that a calendar implemented it. Three changes on the
 * way in:
 *
 *   1. **OAuth is declarative.** `CrmSyncAdapter` made every driver implement
 *      `getAuthorizeUrl`, `exchangeCodeForTokens` and `refreshAccessToken`, and
 *      every implementation was the same RFC 6749 code with a different URL. A
 *      driver now declares `oauth2` and the shared flow in `./auth` runs it.
 *      Providers that genuinely deviate override the hooks.
 *   2. **Optional means optional.** Outbound push, webhook registration and
 *      field mappings are optional members. The interface this replaces forced
 *      an inbound-only provider to write stub methods that threw, which is how
 *      a shared interface stops describing anything.
 *   3. **Context, not a bare token.** Moneybird addresses everything under an
 *      administration id, Salesforce under an instance URL. Drivers receive a
 *      `DriverContext` so per-connection identity does not have to be smuggled
 *      through the access token.
 *
 * The rule that keeps this interface honest: **nothing provider-shaped goes in
 * here.** The interface it replaces grew `resolveObjectSlug`, `fetchLists` and
 * `fetchListEntry` — all three Attio concepts — and every other provider then
 * carried stubs for them.
 */

import type { FieldMappingDirection, FieldTransformType } from '@weldsuite/db/schema';
import type { ConnectorAuthMode, OAuth2Config, OAuthClientCredentials } from './auth';
import type { ExternalEntity, FetchPageResult, PushResult, SyncEntityType } from './entities';
import type { OAuthTokens } from '@weldsuite/db/schema';

// ============================================================================
// Per-connection context
// ============================================================================

/**
 * Everything a driver needs to address one tenant's account.
 *
 * `accessToken` is already valid — `getValidAccessToken` refreshed it if needed
 * before the driver was called, so no driver method refreshes inline.
 */
export interface DriverContext {
  accessToken: string;
  authMode: ConnectorAuthMode;
  /**
   * Provider account identity: Moneybird administration id, Salesforce org id,
   * HubSpot portal id. Populated from `connector_connections.external_account_id`.
   */
  externalAccountId?: string | null;
  /** Per-connection driver settings, from `connector_connections.settings`. */
  settings?: Record<string, unknown> | null;
}

// ============================================================================
// Webhooks
// ============================================================================

export interface ParsedWebhookEvent {
  eventType: 'created' | 'updated' | 'deleted' | 'merged';
  entityType: SyncEntityType;
  externalEntityId: string;
  mergedFromId?: string;
}

export interface ParsedWebhookPayload {
  /** Provider's webhook identifier, when it sends one. Used only for logging. */
  webhookId?: string;
  events: ParsedWebhookEvent[];
}

export interface WebhookRegistration {
  webhookId: string;
  secret: string;
}

// ============================================================================
// Field mappings
// ============================================================================

export interface FieldMappingDefinition {
  externalFieldPath: string;
  internalFieldPath: string;
  direction: FieldMappingDirection;
  transformType: FieldTransformType;
  transformConfig?: Record<string, unknown>;
  isRequired?: boolean;
}

// ============================================================================
// The driver
// ============================================================================

export interface ConnectorDriver {
  /** Stable connector id. Matches `ConnectorDef.id` and the catalog key. */
  readonly connectorId: string;

  /** Entity types this driver can sync. Must be a subset of `SYNCABLE_ENTITIES`. */
  readonly supportedEntities: readonly SyncEntityType[];

  /** Auth modes the tenant may choose from. Order is the UI's preference order. */
  readonly authModes: readonly ConnectorAuthMode[];

  /** Standard OAuth endpoints. Required when `authModes` includes `oauth2`. */
  readonly oauth2?: OAuth2Config;

  /**
   * Top-level record keys to drop before checksumming — anything the provider
   * re-stamps on every delivery. Leaving a volatile field in defeats the
   * skip-if-unchanged path and turns every sweep into a full rewrite.
   */
  readonly volatileFields?: readonly string[];

  // ---------- Inbound ----------

  /**
   * One page of entities.
   *
   * `updatedSince` is a hint, not a contract: a driver whose provider offers no
   * incremental filter ignores it and full-scans. The checksum makes that
   * affordable, so it is a legitimate implementation rather than a gap.
   */
  fetchEntities(
    ctx: DriverContext,
    entityType: SyncEntityType,
    cursor?: string,
    updatedSince?: Date,
  ): Promise<FetchPageResult>;

  /** One entity by id — the webhook path, where we know exactly what changed. */
  fetchEntity(ctx: DriverContext, entityType: SyncEntityType, externalId: string): Promise<ExternalEntity>;

  // ---------- Outbound (optional) ----------

  pushEntity?(
    ctx: DriverContext,
    entityType: SyncEntityType,
    data: Record<string, unknown>,
    externalId?: string,
  ): Promise<PushResult>;

  deleteEntity?(
    ctx: DriverContext,
    entityType: SyncEntityType,
    externalId: string,
  ): Promise<{ success: boolean; error?: string }>;

  // ---------- Identity ----------

  /**
   * Read the provider account identity straight after authorisation.
   *
   * Stored on the connection and passed back as `DriverContext.externalAccountId`.
   * Moneybird needs this before it can call anything else, so it runs as part of
   * completing the connect flow rather than lazily.
   */
  fetchAccountIdentity?(ctx: Omit<DriverContext, 'externalAccountId'>): Promise<{
    externalAccountId: string;
    displayName?: string;
  }>;

  // ---------- OAuth overrides (optional) ----------

  /**
   * Override the shared authorization-code exchange. Only for providers that
   * deviate from RFC 6749; declaring `oauth2` is enough for the rest.
   */
  exchangeCodeForTokens?(
    credentials: OAuthClientCredentials,
    code: string,
    redirectUri: string,
  ): Promise<OAuthTokens>;

  /** Override the shared refresh. Same caveat as above. */
  refreshAccessToken?(credentials: OAuthClientCredentials, refreshToken: string): Promise<OAuthTokens>;

  // ---------- Webhooks (optional) ----------

  verifyWebhookSignature?(
    body: string,
    headers: Record<string, string>,
    secret: string,
  ): Promise<boolean>;

  parseWebhookPayload?(body: string): ParsedWebhookPayload;

  registerWebhooks?(
    ctx: DriverContext,
    targetUrl: string,
    entityTypes: readonly SyncEntityType[],
  ): Promise<WebhookRegistration>;

  deleteWebhooks?(ctx: DriverContext, webhookId: string, webhookSecret?: string): Promise<void>;

  // ---------- Field mappings (optional) ----------

  getDefaultFieldMappings?(entityType: SyncEntityType): FieldMappingDefinition[];
}

/** True when the driver can accept writes for `entityType`. */
export function supportsOutbound(driver: ConnectorDriver, entityType: SyncEntityType): boolean {
  return typeof driver.pushEntity === 'function' && driver.supportedEntities.includes(entityType);
}

/** True when the driver can receive provider-pushed changes. */
export function supportsWebhooks(driver: ConnectorDriver): boolean {
  return typeof driver.verifyWebhookSignature === 'function' && typeof driver.parseWebhookPayload === 'function';
}
