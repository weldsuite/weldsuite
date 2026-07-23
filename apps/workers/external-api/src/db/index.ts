import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '@weldsuite/db/schema';

export { schema };

export type Database = NeonHttpDatabase<typeof schema>;

export function createTenantDb(databaseUrl: string): Database {
  const sql = neon(databaseUrl);
  return drizzleNeonHttp({ client: sql, schema });
}
