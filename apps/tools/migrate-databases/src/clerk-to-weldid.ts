#!/usr/bin/env tsx
/**
 * Global's Clerk users as WeldID import lines, for phase 2 of Global's
 * retirement (ADR OPS-025). The work is in `lib/clerk-to-weldid.ts`, which
 * says what comes along and what doesn't.
 *
 * Usage:
 *   pnpm --silent --filter migrate-databases clerk:weldid --export <users.csv> [--apple-links] [--report-only]
 *
 *   --export        Clerk's dashboard user export (Settings › User exports)
 *   --apple-links   also link Apple accounts: only when Clerk's production instance and
 *                   WeldID sign in with the same Apple developer team (Apple's ids are per team)
 *   --report-only   write no lines, only the report
 *
 * Environment:
 *   CLERK_SECRET_KEY   Global's production Clerk key (the Backend API: verification states, social accounts)
 *
 * The lines go to stdout and hold password digests and authenticator keys, so
 * stdout must be a pipe, never a terminal. The report goes to stderr. Straight
 * into WeldID, nothing on disk but the export itself (dry run first):
 *
 *   doppler run --project weldsuite --config prd -- \
 *     pnpm --silent --filter migrate-databases clerk:weldid --export ~/clerk-users.csv \
 *   | kubectl --context admin@weldsuite-eu -n weldid exec -i deploy/weldid -- \
 *     weldid admin user import --config /etc/weldid/weldid.toml --dry-run
 *
 * Delete the export once the import is done.
 */

import { readFile } from 'node:fs/promises';
import { sanitizeError } from './lib/global-inventory';
import { fetchClerkUsers, formatConvertReport, readClerkExport, toWeldIdAccounts } from './lib/clerk-to-weldid';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

try {
  const exportPath = arg('--export');
  if (!exportPath) throw new Error('--export <users.csv> is required: Clerk\'s dashboard user export');
  const reportOnly = process.argv.includes('--report-only');
  if (!reportOnly && process.stdout.isTTY) {
    throw new Error('stdout is a terminal: the lines hold password digests. Pipe them into `weldid admin user import`, or use --report-only');
  }
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is not set');

  const exported = readClerkExport(await readFile(exportPath, 'utf8'));
  const apiUsers = await fetchClerkUsers(secretKey);
  const { accounts, report } = toWeldIdAccounts(exported, apiUsers, {
    appleLinks: process.argv.includes('--apple-links'),
  });
  if (!reportOnly) {
    for (const account of accounts) process.stdout.write(`${JSON.stringify(account)}\n`);
  }
  for (const line of formatConvertReport(report)) console.error(line);
} catch (err) {
  console.error(sanitizeError(err));
  process.exit(1);
}
