import { and, eq, getTableColumns, isNull } from 'drizzle-orm';
import { omitSensitive } from '@weldsuite/db/lib/sensitive-columns';
import { schema, type Database } from '@weldsuite/worker-kit/db';

/**
 * A party row without its ciphertext (`sensitiveEncrypted`: TIN and vendor ACH
 * account number). The portal only needs the commercial fields, so the blob is
 * never read, let alone handed to a response.
 */
export const portalPartyColumns = omitSensitive('parties', getTableColumns(schema.parties));

export async function findCompanyParty(db: Database, companyId: string) {
  const [party] = await db
    .select(portalPartyColumns)
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
  return Boolean(settings?.isEnabled === 1);
}
