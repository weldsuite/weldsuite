import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as masterSchema from '../schema/master';

// Master database connection - contains tenant routing info
// Uses postgres-js (TCP) which works with any PostgreSQL server (Neon, Ubicloud, etc.)
//
// postgres-js forwards any URL query param it doesn't recognise to the server as
// a startup GUC. `channel_binding` is a libpq client-side auth directive, NOT a
// server setting, so Postgres/Neon rejects the startup packet with
// "unrecognized configuration parameter \"channel_binding\"" and the lazy
// connection blows up on the first query (surfacing as a DrizzleQueryError).
// postgres-js can't honour channel binding anyway (no SCRAM-SHA-256-PLUS), so we
// strip it — TLS (sslmode) + SCRAM-SHA-256 still apply.
function stripUnsupportedParams(url: string | undefined): string {
  if (!url) return url as string;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('channel_binding');
    return parsed.toString();
  } catch {
    return url;
  }
}

const masterConnectionString = stripUnsupportedParams(process.env.MASTER_DATABASE_URL);

// Global singleton to prevent connection leaks during hot reload in development
const globalForMasterDb = globalThis as unknown as {
  masterSql: ReturnType<typeof postgres> | undefined;
};

// Reuse existing connection or create new one
const masterSql = globalForMasterDb.masterSql ?? postgres(masterConnectionString, {
  max: 1,
});

// Cache in development to prevent leaks during hot reload
if (process.env.NODE_ENV !== 'production') {
  globalForMasterDb.masterSql = masterSql;
}

export const masterDb = drizzle({ client: masterSql, schema: masterSchema });

export type MasterDB = typeof masterDb;
