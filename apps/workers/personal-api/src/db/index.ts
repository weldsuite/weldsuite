/**
 * Database clients for personal-api.
 *
 * Same pattern as app-api / mail-inbound: Neon HTTP + connection URL secrets.
 * No Hyperdrive.
 *
 *   DATABASE_URL_MASTER  — personal_accounts + mail_account_registry
 *   DATABASE_URL_PERSONAL — shared personal mail tables
 */

import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as masterSchema from '@weldsuite/db/schema/master';
import * as personalSchema from '@weldsuite/db/schema/personal';
import type { Env } from '../types';

export function getMasterDb(env: Env): NeonHttpDatabase<typeof masterSchema> {
  if (!env.DATABASE_URL_MASTER) {
    throw new Error('DATABASE_URL_MASTER secret is not set');
  }
  const sql = neon(env.DATABASE_URL_MASTER);
  return drizzleNeonHttp({ client: sql, schema: masterSchema });
}

export function getPersonalDb(env: Env): NeonHttpDatabase<typeof personalSchema> {
  if (!env.DATABASE_URL_PERSONAL) {
    throw new Error('DATABASE_URL_PERSONAL secret is not set');
  }
  const sql = neon(env.DATABASE_URL_PERSONAL);
  return drizzleNeonHttp({ client: sql, schema: personalSchema });
}

export type MasterDatabase = NeonHttpDatabase<typeof masterSchema>;
export type PersonalDatabase = NeonHttpDatabase<typeof personalSchema>;
export { masterSchema, personalSchema };
