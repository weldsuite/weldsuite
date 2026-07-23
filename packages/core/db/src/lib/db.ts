import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from '../schema';

// DEPRECATION WARNING: This hardcoded db connection breaks multi-tenant isolation.
// Use getScopedDb() for authenticated requests or getTenantDbByWorkspaceId(workspaceId) for webhooks.
console.warn(
  '[DEPRECATED] Direct `db` import from @weldsuite/db breaks multi-tenant isolation. ' +
  'Use getScopedDb() for authenticated requests or getTenantDbByWorkspaceId(workspaceId) for webhooks/tasks.'
);

// Use ws for WebSocket support on Node.js 20 (built-in WebSocket requires Node.js 22+)
neonConfig.webSocketConstructor = ws;

// Connection string for self-hosted PostgreSQL
const connectionString = process.env.DATABASE_URL!;

// Global singleton to prevent connection leaks during hot reload in development
const globalForDb = globalThis as unknown as {
  pool: Pool | undefined;
};

// Reuse existing pool or create new one
const pool = globalForDb.pool ?? new Pool({
  connectionString,
});

// Cache pool in development to prevent leaks during hot reload
if (process.env.NODE_ENV !== 'production') {
  globalForDb.pool = pool;
}

export const db = drizzle({ client: pool, schema });

export type DB = typeof db;
