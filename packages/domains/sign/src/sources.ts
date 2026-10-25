/**
 * Where a request comes from: a WeldDrive file, or a CRM company, person or
 * opportunity (`sign_envelopes.source`). Drive access goes through the shared
 * rules in `@weldsuite/core-domain` and the CRM rows are read from the tenant
 * schema, never through another worker's code.
 */

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { canEdit, containerRole, fileRole, loadDriveAccessForUser } from '@weldsuite/core-domain/drive-access';
import { getFile } from '@weldsuite/core-domain/files';
import type { SignEnvelopeSource } from '@weldsuite/db/schema';
import type { SignRecipientSuggestion, SignSourceDto, SignSourceInput, SignSourceType } from '@weldsuite/app-api-client/schemas/weldsign';
import { notFound } from './errors';

const { companies, people, personCompanies, crmOpportunities, folders } = schema;

/** The permission that lets a member read each kind of source. */
export const SOURCE_READ_PERMISSION: Record<SignSourceType, string> = {
  file: 'files:read',
  company: 'companies:read',
  person: 'people:read',
  opportunity: 'opportunities:read',
};

export type DriveFile = NonNullable<Awaited<ReturnType<typeof getFile>>>;

/** A live WeldDrive file the member may open, or null. */
export async function visibleDriveFile(db: Database, userId: string, fileId: string): Promise<DriveFile | null> {
  const file = await getFile(db, fileId);
  if (!file) return null;
  const access = await loadDriveAccessForUser(db, userId);
  return fileRole(access, file) ? file : null;
}

/** Whether the member may add files to this live folder. */
export async function canFileInto(db: Database, userId: string, folderId: string): Promise<boolean> {
  const [folder] = await db.select({ id: folders.id }).from(folders).where(and(eq(folders.id, folderId), isNull(folders.deletedAt))).limit(1);
  if (!folder) return false;
  return canEdit(containerRole(await loadDriveAccessForUser(db, userId), folderId));
}

async function companyName(db: Database, id: string): Promise<string | null> {
  const [row] = await db.select({ name: companies.name }).from(companies).where(and(eq(companies.id, id), isNull(companies.deletedAt))).limit(1);
  return row?.name ?? null;
}

async function personName(db: Database, id: string): Promise<string | null> {
  const [row] = await db.select({ name: people.displayName }).from(people).where(and(eq(people.id, id), isNull(people.deletedAt))).limit(1);
  return row?.name ?? null;
}

async function opportunity(db: Database, id: string) {
  const [row] = await db
    .select({ name: crmOpportunities.name, customerId: crmOpportunities.customerId, primaryContactId: crmOpportunities.primaryContactId, personIds: crmOpportunities.personIds })
    .from(crmOpportunities)
    .where(and(eq(crmOpportunities.id, id), isNull(crmOpportunities.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** The source's display name, or null when the file or record is gone. */
export async function sourceName(db: Database, source: Pick<SignEnvelopeSource, 'entityType' | 'entityId'>): Promise<string | null> {
  switch (source.entityType) {
    case 'file':
      return (await getFile(db, source.entityId))?.fileName ?? null;
    case 'company':
      return companyName(db, source.entityId);
    case 'person':
      return personName(db, source.entityId);
    case 'opportunity':
      return (await opportunity(db, source.entityId))?.name ?? null;
    default:
      return null;
  }
}

export async function toSourceDto(db: Database, source: SignEnvelopeSource | null): Promise<SignSourceDto | null> {
  if (!source) return null;
  return { entityType: source.entityType as SignSourceType, entityId: source.entityId, name: await sourceName(db, source) };
}

/**
 * Check a source a member starts a request from: it exists and they may read
 * it. Anything else is `not_found`. For a Drive file, also says which folder
 * it is in, when the member may add files there (the default home of the
 * signed copy).
 */
export async function checkSource(
  db: Database,
  userId: string,
  source: SignSourceInput,
  mayRead: (permission: string) => Promise<boolean>,
): Promise<{ name: string; folderForCopy: string | null }> {
  const missing = notFound('Source', source.entityId);
  if (!(await mayRead(SOURCE_READ_PERMISSION[source.entityType]))) throw missing;
  if (source.entityType === 'file') {
    const file = await visibleDriveFile(db, userId, source.entityId);
    if (!file) throw missing;
    const folderForCopy = file.folderId && (await canFileInto(db, userId, file.folderId)) ? file.folderId : null;
    return { name: file.fileName, folderForCopy };
  }
  const name = await sourceName(db, source);
  if (!name) throw missing;
  return { name, folderForCopy: null };
}

type PersonRow = { id: string; name: string; email: string | null; title: string | null };

async function peopleByIds(db: Database, ids: string[]): Promise<PersonRow[]> {
  if (ids.length === 0) return [];
  return db
    .select({ id: people.id, name: people.displayName, email: people.email, title: people.title })
    .from(people)
    .where(and(inArray(people.id, ids), isNull(people.deletedAt), isNotNull(people.email)));
}

async function peopleOfCompany(db: Database, companyId: string): Promise<PersonRow[]> {
  const links = await db
    .select({ personId: personCompanies.personId })
    .from(personCompanies)
    .where(eq(personCompanies.companyId, companyId));
  return peopleByIds(db, links.map((l) => l.personId));
}

/** People on a CRM source who have an email address, offered as recipients. A file has none. */
export async function recipientSuggestions(db: Database, source: SignEnvelopeSource): Promise<SignRecipientSuggestion[]> {
  let rows: PersonRow[] = [];
  if (source.entityType === 'person') rows = await peopleByIds(db, [source.entityId]);
  if (source.entityType === 'company') rows = await peopleOfCompany(db, source.entityId);
  if (source.entityType === 'opportunity') {
    const opp = await opportunity(db, source.entityId);
    const ids = opp ? [opp.primaryContactId, ...(opp.personIds ?? [])].filter((id): id is string => !!id) : [];
    rows = await peopleByIds(db, [...new Set(ids)]);
  }
  const seen = new Set<string>();
  return rows
    .filter((r) => {
      const email = r.email!.toLowerCase();
      if (seen.has(email)) return false;
      seen.add(email);
      return true;
    })
    .map((r) => ({ personId: r.id, name: r.name, email: r.email!.toLowerCase(), title: r.title }));
}
