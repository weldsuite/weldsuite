import type { TenantTier } from '@weldsuite/db/schema/master';
import type { Env } from '../types/env';

/**
 * An authenticated MCP session, derived from a Clerk OAuth access token.
 *
 * The MCP server no longer issues or accepts `wsk_` API keys — every caller
 * authenticates through Clerk's OAuth authorization server, so a session always
 * represents a *real user acting inside a specific organization*.
 *
 * Tool calls are served by the server's own copy of the v1 resource routes
 * (`src/api/`), which run against the tenant database resolved here.
 */
export interface McpSession {
  /** Clerk OAuth token id — the stable caller identifier. */
  tokenId: string;
  /** Clerk user ID — the OAuth token's `sub`. */
  userId: string;
  /** Clerk organization ID — the tenant selector (`workspaces.clerk_org_id`). */
  clerkOrgId: string;
  /** Internal workspace ID (`workspaces.id`), used for rate-limit keying. */
  workspaceId: string;
  /** Workspace display name, surfaced on the workspace-info resource. */
  workspaceName: string;
  /** Workspace plan tier, used to pick a rate-limit bucket. */
  tier: TenantTier;
  /** Connection string for this workspace's tenant database. */
  databaseUrl: string;
  /**
   * The user's effective WeldSuite permissions, resolved from their workspace
   * role, teams and per-member grants. `['*']` for workspace owners. This is
   * the authority for every tool call — an MCP client can never exceed what
   * its user can do in the UI.
   */
  permissions: string[];
  /** The user's workspace role (OWNER, ADMIN, MEMBER, VIEWER or a custom role). */
  role: string;
  /** The OAuth client that obtained the token, for logging/diagnostics. */
  clientId: string | null;
}

/**
 * Variables available in Hono context after auth middleware
 */
export interface ApiVariables {
  session: McpSession;
}

declare module 'hono' {
  interface ContextVariableMap extends ApiVariables {}
}

/**
 * Hono app type with environment bindings
 */
export type HonoEnv = { Bindings: Env; Variables: ApiVariables };
