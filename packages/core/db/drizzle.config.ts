import { defineConfig } from 'drizzle-kit';

// Disable TLS verification for self-signed certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Drizzle Kit config for TENANT databases (shared + dedicated)
// Contains: projects, and other business entities
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle/tenant-migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Use shared DB URL for migrations (same schema applies to dedicated DBs)
    url: process.env.DATABASE_URL!,
  },
});
