import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

/**
 * Consumers use different Drizzle drivers (neon-http in app-api, postgres-js
 * over Hyperdrive in billing-worker) whose concrete client types differ only in
 * their query-result HKT, so the shared handle is the driver-agnostic
 * `PgDatabase` base class both extend.
 */
export type PartnerDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
