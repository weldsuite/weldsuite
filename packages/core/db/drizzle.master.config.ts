import { defineConfig } from 'drizzle-kit';

// `pnpm db:migrate:master` only: drizzle-kit applying the master migrations,
// which are generated from the Rust entities since ADR DATA-019
// (`pnpm db:generate:master`, rust/migrations/master). Without `schema`,
// `drizzle-kit generate` refuses this config, so it can't write a migration
// from the frozen Drizzle schema.
export default defineConfig({
  out: '../../../rust/migrations/master',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.MASTER_DATABASE_URL!,
  },
});
