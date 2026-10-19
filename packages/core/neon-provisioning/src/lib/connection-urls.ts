/**
 * Connection-URL helpers for tenant databases.
 *
 * Package-internal (not re-exported from the barrel). These handle credentials,
 * so nothing here logs, and callers must not log what they return.
 */

import { NeonClient } from '../client';

/** A tenant database's two connection strings. */
export interface ConnectionUrls {
  /** Through PgBouncer (`ep-…-pooler…`), what the application uses. */
  pooledUrl: string;
  /** Straight to the compute, for session-level work (DDL, `ALTER DATABASE`, locks). */
  directUrl: string;
}

/** Both URLs for a role on an endpoint, built from the endpoint's DIRECT host. */
export function connectionUrlsFor(
  directHost: string,
  roleName: string,
  password: string,
  databaseName: string,
): ConnectionUrls {
  return {
    pooledUrl: NeonClient.buildConnectionUri(directHost, roleName, password, databaseName, { pooled: true }),
    directUrl: NeonClient.buildConnectionUri(directHost, roleName, password, databaseName, { pooled: false }),
  };
}

/**
 * The direct twin of a pooled Neon URL: the same credentials and database with
 * `-pooler` removed from the host (`ep-x-pooler.region…` → `ep-x.region…`).
 * Returns the input unchanged when the host is not a pooler host. Used for warm
 * pool slots, whose stored `database_url` is the pooled one: it is the one place
 * the slot role's password is known (a cloned slot's role is created over SQL).
 */
export function directUrlOf(pooledUrl: string): string {
  // The credentials end at the LAST '@'; a password is percent-encoded or hex,
  // but this stays correct even if it were not.
  const at = pooledUrl.lastIndexOf('@');
  if (at === -1) return pooledUrl;
  const authority = pooledUrl.slice(0, at + 1);
  const rest = pooledUrl.slice(at + 1);
  return authority + rest.replace(/^([^./:]+)-pooler(?=[./:])/, '$1');
}
