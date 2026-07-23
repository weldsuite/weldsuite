/**
 * WeldData enrichment action abstraction (pluggable registry).
 *
 * An "action" is one column type (ai, prospeo, hunter, …). The enrichment
 * Cloudflare Workflow is action-agnostic: it builds the context and calls
 * `getAction(column.type).run(ctx)`. Adding a provider is a new handler module
 * + a registry entry (./index.ts) + a shared config schema + a UI form —
 * nothing in the column/cell/run/workflow machinery changes.
 *
 * The `ai` action is stubbed (AI has been physically removed from WeldSuite —
 * see ./ai.ts) and always returns an empty result. Non-AI providers (e.g.
 * Prospeo, phone-finder's website scrape) `fetch` their own API directly
 * from `run` and are unaffected.
 */

import type { Env } from '../../../types';
import { schema, type Database } from '../../../db';

export type LeadRow = typeof schema.welddataLeads.$inferSelect;

/**
 * Slim, serializable column shape passed to actions. Deliberately not the full
 * Drizzle row: the workflow hands this across a `step.do` boundary (Cloudflare
 * Workflows require serializable step output — no `Date` fields). Actions only
 * need the action type + its config.
 */
export interface ActionColumn {
  id: string;
  listId: string;
  name: string;
  type: string;
  config: Record<string, unknown> | null;
}

export interface ActionTenant {
  /** Clerk org id — agent-worker resolves it to the internal workspace id. */
  workspaceId: string;
  userId: string;
}

export interface ActionContext {
  env: Env;
  db: Database;
  tenant: ActionTenant;
  column: ActionColumn;
  lead: LeadRow;
  /** Other columns' `done` values for this lead, keyed by lowercased column name. */
  siblingValues: Record<string, string>;
}

export interface ActionResult {
  /** Primary text rendered in the grid cell. */
  value: string;
  creditsUsed?: number;
  data?: Record<string, unknown>;
}

export interface EnrichmentAction {
  type: string;
  run(ctx: ActionContext): Promise<ActionResult>;
}
