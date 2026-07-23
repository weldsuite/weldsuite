/**
 * Sample Data Seeding Orchestrator
 *
 * Maps app codes to module-specific seed functions and runs them
 * conditionally based on the user's selected apps during onboarding.
 */

import type { DrizzleDb, SeedContext, SeedResult } from './types';
import { seedCrmData } from './crm';
import { seedHelpdeskData } from './helpdesk';
import { seedProjectsData } from './projects';
import { seedChatData } from './chat';

type SeederFn = (db: DrizzleDb, ctx: SeedContext) => Promise<void>;

/** Map of canonical module names to their seed functions. */
const APP_SEEDERS: Record<string, SeederFn> = {
  crm: seedCrmData,
  helpdesk: seedHelpdeskData,
  projects: seedProjectsData,
  chat: seedChatData,
};

/**
 * Map prefixed app codes (used in the fallback catalog) to canonical names
 * used in the seed-script catalog and by the seeders.
 */
const CODE_ALIASES: Record<string, string> = {
  weldcrm: 'crm',
  welddesk: 'helpdesk',
  weldflow: 'projects',
  weldchat: 'chat',
};

function normalizeAppCode(code: string): string {
  return CODE_ALIASES[code] || code;
}

/**
 * Seed sample data for the given set of installed apps.
 *
 * Each module seeder is non-fatal: if one fails, the others still run.
 */
export async function seedSampleData(
  db: DrizzleDb,
  ctx: SeedContext,
  selectedApps: string[],
): Promise<SeedResult> {
  const result: SeedResult = { seeded: [], skipped: [], errors: [] };

  // Deduplicate after normalization (e.g., both 'crm' and 'weldcrm' map to 'crm')
  const seen = new Set<string>();
  for (const raw of selectedApps) {
    const code = normalizeAppCode(raw);
    if (seen.has(code)) continue;
    seen.add(code);

    const seeder = APP_SEEDERS[code];
    if (!seeder) {
      // No seeder for this app (e.g., mail, host) — not an error
      result.skipped.push(code);
      continue;
    }

    try {
      await seeder(db, ctx);
      result.seeded.push(code);
    } catch (error) {
      console.warn(`[Seed] Failed to seed ${code}:`, error);
      result.errors.push(code);
      // Non-fatal — continue with other modules
    }
  }

  return result;
}
