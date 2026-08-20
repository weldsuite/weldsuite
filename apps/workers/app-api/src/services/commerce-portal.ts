import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '../db';

export async function findCompanyParty(db: Database, companyId: string) {
  const [party] = await db
    .select()
    .from(schema.parties)
    .where(
      and(
        eq(schema.parties.companyId, companyId),
        eq(schema.parties.kind, 'company'),
        isNull(schema.parties.deletedAt),
      ),
    )
    .limit(1);
  return party ?? null;
}

export async function loadPortalSettings(db: Database) {
  const [row] = await db
    .select()
    .from(schema.commercePortalSettings)
    .where(isNull(schema.commercePortalSettings.deletedAt))
    .limit(1);
  return row ?? null;
}

export function isPortalEnabled(settings: { isEnabled: number | null } | null): boolean {
  return Boolean(settings && settings.isEnabled === 1);
}
