/**
 * The contact facts a document keeps.
 *
 * Invoices and bills store the contact's name (and an invoice its email) next
 * to `contactId`: the PDF, the lists, the reports and the reconciliation read
 * them from the document, and a document keeps the name it was issued to when
 * the contact is renamed later. Clients only send `contactId`, so the routes
 * fill the rest from the contact here.
 */

import { eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';

export interface ContactSnapshot {
  name: string | null;
  email: string | null;
}

const EMPTY: ContactSnapshot = { name: null, email: null };

/** Name and email of an accounting contact (a party and the company or person it wraps). */
export async function loadContactSnapshot(
  db: Database,
  contactId: string | null | undefined,
): Promise<ContactSnapshot> {
  if (!contactId) return EMPTY;
  const [party] = await db
    .select({
      displayName: schema.parties.displayName,
      companyId: schema.parties.companyId,
      personId: schema.parties.personId,
    })
    .from(schema.parties)
    .where(eq(schema.parties.id, contactId))
    .limit(1);
  if (!party) return EMPTY;

  let identity: { displayName: string; email: string | null } | undefined;
  if (party.companyId) {
    [identity] = await db
      .select({ displayName: schema.companies.displayName, email: schema.companies.email })
      .from(schema.companies)
      .where(eq(schema.companies.id, party.companyId))
      .limit(1);
  } else if (party.personId) {
    [identity] = await db
      .select({ displayName: schema.people.displayName, email: schema.people.email })
      .from(schema.people)
      .where(eq(schema.people.id, party.personId))
      .limit(1);
  }

  return {
    name: party.displayName || identity?.displayName || null,
    email: identity?.email || null,
  };
}

/**
 * The name and email to store on a document: what the client sent, else the
 * contact's own.
 */
export async function documentContactFields(
  db: Database,
  contactId: string | null | undefined,
  sent: { contactName?: string | null; contactEmail?: string | null },
): Promise<{ contactName: string | null; contactEmail: string | null }> {
  const contactName = sent.contactName?.trim() || null;
  const contactEmail = sent.contactEmail?.trim() || null;
  if (contactName && contactEmail) return { contactName, contactEmail };
  const snapshot = await loadContactSnapshot(db, contactId);
  return { contactName: contactName ?? snapshot.name, contactEmail: contactEmail ?? snapshot.email };
}

/**
 * Fill `contactName` on documents stored without one (created before the
 * routes copied it), from the contacts' current names. One query for the lot.
 */
export async function withContactNames<T extends { contactId: string | null; contactName: string | null }>(
  db: Database,
  rows: T[],
): Promise<T[]> {
  const missing = [...new Set(rows.filter((r) => !r.contactName && r.contactId).map((r) => r.contactId!))];
  if (missing.length === 0) return rows;
  const parties = await db
    .select({ id: schema.parties.id, displayName: schema.parties.displayName })
    .from(schema.parties)
    .where(inArray(schema.parties.id, missing));
  const names = new Map(parties.map((p) => [p.id, p.displayName]));
  return rows.map((r) =>
    !r.contactName && r.contactId && names.get(r.contactId) ? { ...r, contactName: names.get(r.contactId)! } : r,
  );
}
