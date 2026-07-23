import { defineConfig } from 'drizzle-kit';

// Drizzle Kit config for MASTER database
// Contains: workspaces, tenant routing info
export default defineConfig({
  schema: './src/schema/master.ts',
  out: './drizzle/master-migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.MASTER_DATABASE_URL!,
  },
});
