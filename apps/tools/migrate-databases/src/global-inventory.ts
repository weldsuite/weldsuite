#!/usr/bin/env tsx
/**
 * Read-only inventory of the Global deployment, for phase 0 of Global's
 * retirement (ADR OPS-025). The work is in `lib/global-inventory-run.ts`; the
 * report holds workspace ids and counts, not names, addresses or domains.
 *
 * Usage:
 *   pnpm --filter migrate-databases inventory:global [--out <dir>] [--only <workspaceId>] [--skip-clerk] [--skip-mail-store]
 *
 * Environment (the same names the migration runner reads):
 *   MASTER_DATABASE_URL                                required (DATABASE_URL_MASTER, Doppler's name, also works)
 *   DATABASE_ENCRYPTION_KEY, DATABASE_ENCRYPTION_KEY_V2  to open stored tenant URLs
 *   NEON_API_KEY                                       fallback for workspaces without a stored URL
 *   CLERK_SECRET_KEY                                   Clerk's users, SAML connections and OAuth applications
 *   MAIL_STORE_ADMIN_URL, OUTBOUND_ADMIN_SECRET, MAIL_STORE_ADMIN_EMAIL   mailbox store modes (optional):
 *     mail-api's origin, its admin secret, and the staff address it logs as the acting admin
 *
 * Against Global production, from Doppler (the URL and the address aren't secrets, so they go on the command line):
 *   MAIL_STORE_ADMIN_URL=https://mail-api.weldsuite.org MAIL_STORE_ADMIN_EMAIL=<you> \
 *     doppler run --project weldsuite --config prd -- pnpm --filter migrate-databases inventory:global
 */

import 'dotenv/config';
import path from 'node:path';
import { sanitizeError } from './lib/global-inventory';
import { runGlobalInventory } from './lib/global-inventory-run';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

try {
  await runGlobalInventory({
    env: process.env,
    outDir: path.resolve(arg('--out') ?? 'inventory-out'),
    only: arg('--only'),
    skipClerk: process.argv.includes('--skip-clerk'),
    skipMailStore: process.argv.includes('--skip-mail-store'),
    log: (line) => console.log(line),
  });
} catch (err) {
  console.error(sanitizeError(err));
  process.exit(1);
}
