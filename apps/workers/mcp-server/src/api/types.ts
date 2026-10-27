import type { TenantTier } from '@weldsuite/db/schema/master';
import type { AppAccess } from '@weldsuite/worker-kit/app-access';
import type { Env } from '../types/env';
import type { Database } from './db';

export type { Env };

/**
 * Per-request session backing the ported v1 resource routes.
 *
 * These routes came from `external-api`, where the session was minted from a
 * `wsk_` API key. The MCP server has no API keys — `middleware/auth.ts` builds
 * this object from a verified Clerk OAuth token instead. The shape is kept
 * identical on purpose so `src/api/` stays a clean copy that can still be
 * diffed against external-api when routes change there.
 */
export interface ApiKeySession {
  /** Stable identifier for the caller — the OAuth token id. */
  keyId: string;
  /** Always `personal` here: an OAuth token always represents a real user. */
  keyType: 'personal' | 'workspace' | 'app';
  /** Workspace this session grants access to. */
  workspaceId: string;
  /** Clerk user ID behind the token. */
  userId: string | null;
  /** Permission scopes granted to this session. */
  scopes: string[];
  /** MCP only: the user's explicit per-member permission denies. */
  permissionDenies?: string[];
  /** Workspace plan tier (free, business, scale, enterprise). */
  tier: TenantTier;
  /**
   * The workspace's Clerk org id (the key of the app-access cache and of the
   * send sweep's due index). The OAuth session always knows it; the field is
   * optional only so the copied route libraries compile as in external-api.
   */
  clerkOrgId?: string | null;
  /** Workspace-specific database URL (resolved from master DB). */
  databaseUrl: string | null;
  /** User-app id — set only for `app` sessions. */
  appId?: string;
  /** User-app code (sidenav/app-store code) — set only for `app` sessions. */
  appCode?: string;
  /** Install grant id backing the token — set only for `app` sessions. */
  installId?: string;
}

/**
 * Hono context variables set across middleware.
 */
export type Variables = {
  /** API session set by `authMiddleware`. */
  apiSession: ApiKeySession;
  /** Per-request tenant Drizzle client set by `tenantDbMiddleware`. */
  tenantDb: Database;
  /** The master `workspaces.id` of the session's workspace (= `apiSession.workspaceId`, ADR SEC-011). */
  workspaceId: string;
  /**
   * The workspace's Clerk org id (from the OAuth token), which
   * `publishEntityEvent` stamps on every event until event consumers move to
   * `workspaces.id`, and the key of the stores still keyed by it.
   */
  clerkOrgId?: string;
  /** Actor id for entity events — the Clerk user behind the OAuth token. */
  userId: string;
  /**
   * Set by `reachAccess` on `/v1/reach/*`: the workspace's Clerk org id and its
   * approved WeldReach access (staff-set limits, billing state).
   */
  reach?: ReachRequest;
};

/** What the WeldReach approval gate resolved for the request. */
export interface ReachRequest {
  clerkOrgId: string;
  access: AppAccess;
}

export type HonoEnv = { Bindings: Env; Variables: Variables };

declare module 'hono' {
  interface ContextVariableMap extends Variables {}
}
