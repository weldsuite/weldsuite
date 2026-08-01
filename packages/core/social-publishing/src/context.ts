/**
 * The worker-agnostic surface this package needs.
 *
 * Publishing runs in three workers (app-api, external-api, mcp-server) and
 * they do not share a binding layout, so the service never reads a worker
 * `Env` directly and never constructs a database. Each worker builds a
 * `SocialPublishingContext` from whatever it happens to have.
 */

import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '@weldsuite/db/schema';
import type * as masterSchema from '@weldsuite/db/schema/master';

/**
 * Tenant Drizzle client. All three workers build this identically over
 * neon-http, so it can be a single concrete type.
 */
export type Database = NeonHttpDatabase<typeof schema>;

/**
 * Master Drizzle client.
 *
 * Deliberately a union rather than one type: app-api reaches master over
 * neon-http while external-api and mcp-server go through Hyperdrive with
 * postgres-js. Only `select`/`insert`/`update` are used against it here, which
 * both drivers implement identically. (`@weldsuite/credits` solves the same
 * problem with `type CreditsDb = any`; naming both drivers keeps the checking.)
 */
export type MasterDatabase =
  | NeonHttpDatabase<typeof masterSchema>
  | PostgresJsDatabase<typeof masterSchema>;

export interface SocialPublishingContext {
  /** PostPeer API key (`x-access-key`). Absent → PostPeerNotConfiguredError. */
  POSTPEER_API_KEY?: string;
  /** Override the PostPeer REST base URL. */
  POSTPEER_BASE_URL?: string;
  /** BYOK OAuth apps as JSON: platform → PostPeer app id. */
  POSTPEER_APP_IDS?: string;
  /**
   * Resolve the master DB, used for credit metering and the delivery index.
   * A factory rather than a handle so workers whose driver opens a connection
   * eagerly only pay for it when a call actually needs master.
   */
  masterDb: () => MasterDatabase;
}
