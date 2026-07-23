/**
 * CRM Sync Engine — Provider-Agnostic Types
 *
 * Core interfaces that every CRM provider (Attio, Salesforce, HubSpot, etc.)
 * implements. The sync orchestrator works with these abstractions.
 */

import type { OAuthTokens } from '../types';
import type { FieldMappingDirection, FieldTransformType } from '@weldsuite/db/schema';

// ============================================================================
// Entity types
// ============================================================================

export type SyncEntityType =
  | 'contact'
  | 'customer'
  | 'lead'
  | 'opportunity'
  | 'activity'
  | 'calendar_event'
  | 'pipeline';

// ============================================================================
// External data types
// ============================================================================

export interface ExternalEntity {
  id: string;
  type: SyncEntityType;
  data: Record<string, unknown>;
  updatedAt: string;
  isDeleted?: boolean;
  raw: unknown;
}

export interface FetchPageResult {
  entities: ExternalEntity[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface PushResult {
  externalId: string;
  success: boolean;
  error?: string;
}

// ============================================================================
// Field mapping types
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
// Webhook types
// ============================================================================

export interface ParsedWebhookEvent {
  eventType: 'created' | 'updated' | 'deleted' | 'merged';
  entityType: SyncEntityType;
  externalEntityId: string;
  mergedFromId?: string;
}

export interface ParsedWebhookPayload {
  webhookId: string;
  events: ParsedWebhookEvent[];
}

export interface WebhookRegistration {
  webhookId: string;
  secret: string;
}

// ============================================================================
// Sync stats
// ============================================================================

export interface SyncEntityStats {
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  conflicts: number;
}

// ============================================================================
// CRM Sync Adapter — the core abstraction
// ============================================================================

export interface CrmSyncAdapter {
  /** Provider identifier (matches IntegrationProvider type) */
  readonly provider: string;

  /** Which entity types this adapter supports */
  readonly supportedEntities: SyncEntityType[];

  // ---------- Field Mappings ----------

  /** Get the default field mappings for an entity type (used on initial setup) */
  getDefaultFieldMappings(entityType: SyncEntityType): FieldMappingDefinition[];

  // ---------- Data Fetching (Inbound) ----------

  /** Fetch a page of entities from the external CRM */
  fetchEntities(
    accessToken: string,
    entityType: SyncEntityType,
    cursor?: string,
    updatedSince?: Date,
  ): Promise<FetchPageResult>;

  /** Fetch a single entity by ID (for webhook-triggered updates) */
  fetchEntity(
    accessToken: string,
    entityType: SyncEntityType,
    externalId: string,
  ): Promise<ExternalEntity>;

  // ---------- Data Pushing (Outbound) ----------

  /** Push a WeldSuite entity to the external CRM */
  pushEntity(
    accessToken: string,
    entityType: SyncEntityType,
    data: Record<string, unknown>,
    externalId?: string,
  ): Promise<PushResult>;

  /** Delete an entity in the external CRM */
  deleteEntity(
    accessToken: string,
    entityType: SyncEntityType,
    externalId: string,
  ): Promise<{ success: boolean; error?: string }>;

  // ---------- OAuth ----------

  /** Build the OAuth authorization URL */
  getAuthorizeUrl(clientId: string, redirectUri: string, state: string): string;

  /** Exchange an authorization code for tokens */
  exchangeCodeForTokens(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ): Promise<OAuthTokens>;

  /** Refresh an expired access token */
  refreshAccessToken(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ): Promise<OAuthTokens>;

  // ---------- Webhooks ----------

  /** Verify a webhook signature */
  verifyWebhookSignature(
    body: string,
    headers: Record<string, string>,
    secret: string,
  ): Promise<boolean>;

  /** Parse a raw webhook payload into normalized events */
  parseWebhookPayload(body: string): ParsedWebhookPayload;

  /** Register webhooks at the provider */
  registerWebhooks(
    accessToken: string,
    targetUrl: string,
    entityTypes: SyncEntityType[],
  ): Promise<WebhookRegistration>;

  /** Remove registered webhooks */
  deleteWebhooks(accessToken: string, webhookId: string, webhookSecret?: string): Promise<void>;
}
