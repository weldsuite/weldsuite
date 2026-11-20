import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from '../schema';

/**
 * A Postgres handle on `TSchema`, whichever driver it came from (neon-http,
 * node-postgres, pglite): they all extend `PgDatabase`.
 *
 * Generic on purpose. Written out as `PgDatabase<PgQueryResultHKT, typeof schema>`,
 * the reference makes TypeScript prove, in that one statement, that every
 * table of the tenant schema fits drizzle's relational config (the default of
 * `PgDatabase`'s third type parameter). With some 420 tables that proof runs
 * into the compiler's instantiation limit (TS2589) at whichever file a
 * program happens to check first. Inside a generic alias the proof is made
 * once, against the type parameter, and `DatabaseOf<typeof schema>` is then
 * the very same type without it: the way drizzle's own
 * `NeonHttpDatabase<typeof schema>` gets there.
 */
type DatabaseOf<TSchema extends Record<string, unknown>> = PgDatabase<PgQueryResultHKT, TSchema>;

/**
 * Any driver's handle on the tenant schema. Use this, never
 * `PgDatabase<PgQueryResultHKT, typeof schema>`, for a `db` parameter.
 */
export type TenantDb = DatabaseOf<typeof schema>;
