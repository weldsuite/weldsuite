import type { TenantTier } from '@weldsuite/db/schema/master';
import type { Env } from '../types/env';

/**
 * API Key session information
 * Contains validated key details and workspace context
 */
export interface ApiKeySession {
  /** Unique identifier for the API key */
  keyId: string;
  /** Type of key: 'personal' belongs to a user, 'workspace' is shared */
  keyType: 'personal' | 'workspace';
  /** The workspace this key grants access to */
  workspaceId: string;
  /** User ID for personal keys, null for workspace keys */
  userId: string | null;
  /** Permission scopes granted to this key */
  scopes: string[];
  /** Workspace tier (free, starter, professional, enterprise) */
  tier: TenantTier;
  /** Whether the workspace plan has API access */
  hasApiAccess: boolean;
  /** Workspace-specific database URL from master database */
  databaseUrl: string | null;
  /** The raw `wsk_` API key, forwarded to external-api when proxying tool calls */
  apiKey: string;
}

/**
 * Variables available in Hono context after auth middleware
 */
export interface ApiVariables {
  apiSession: ApiKeySession;
}

declare module 'hono' {
  interface ContextVariableMap extends ApiVariables {}
}

/**
 * Hono app type with environment bindings
 */
export type HonoEnv = { Bindings: Env; Variables: ApiVariables };
