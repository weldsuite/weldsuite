import { defineConfig } from 'drizzle-kit';

// Drizzle Kit config for SHARED PERSONAL database
// Contains: personal mail tables keyed by personalAccountId
export default defineConfig({
  schema: './src/schema/personal/index.ts',
  out: './drizzle/personal-migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.PERSONAL_DATABASE_URL!,
  },
});
