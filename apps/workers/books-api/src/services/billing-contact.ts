/**
 * The contact person of a company customer or supplier: the person WeldBooks
 * deals with at that company.
 *
 * Stored in the CRM, not on the party: it is the company's active
 * `person_companies` link with role 'billing', so WeldCRM shows the same
 * person at the company. A company has one: making someone the billing
 * contact clears the role on the company's other links (those people keep
 * working there). Pure functions, no Hono context; the route publishes events.
 */

import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';

export const BILLING_CONTACT_ROLE = 'billing';

type PersonRow = typeof schema.people.$inferSelect;

const pc = schema.personCompanies;

/** The billing contact of each company (its newest billing link), two queries for the lot. */
export async function loadBillingContacts(
  db: Database,
  companyIds: readonly string[],
): Promise<Map<string, PersonRow>> {
  const ids = [...new Set(companyIds)];
  if (ids.length === 0) return new Map();
  const links = await db
    .select({ companyId: pc.companyId, personId: pc.personId })
    .from(pc)
    .where(and(inArray(pc.companyId, ids), eq(pc.role, BILLING_CONTACT_ROLE), isNull(pc.endedAt)))
    .orderBy(desc(pc.updatedAt));
  if (links.length === 0) return new Map();

  const people = await db
    .select()
    .from(schema.people)
    .where(and(inArray(schema.people.id, [...new Set(links.map((l) => l.personId))]), isNull(schema.people.deletedAt)));
  const peopleById = new Map(people.map((row) => [row.id, row]));

  const result = new Map<string, PersonRow>();
  for (const link of links) {
    if (result.has(link.companyId)) continue;
    const person = peopleById.get(link.personId);
    if (person) result.set(link.companyId, person);
  }
  return result;
}

export interface BillingContactLink {
  linkId: string;
  /** A new `person_companies` row was inserted (the person did not work there yet). */
  created: boolean;
  /** Anything changed: the link, or the role of another person at the company. */
  changed: boolean;
  /** People at the company who lost the billing role. */
  demotedPersonIds: string[];
}

/**
 * Make the person the company's billing contact, linking them to the company
 * when they aren't yet. A new link is the person's primary employment when
 * they have none.
 */
export async function setBillingContact(
  db: Database,
  companyId: string,
  personId: string,
): Promise<BillingContactLink> {
  const now = new Date();
  const demoted = await db
    .update(pc)
    .set({ role: null, updatedAt: now })
    .where(and(
      eq(pc.companyId, companyId),
      eq(pc.role, BILLING_CONTACT_ROLE),
      isNull(pc.endedAt),
      ne(pc.personId, personId),
    ))
    .returning({ personId: pc.personId });
  const demotedPersonIds = demoted.map((row) => row.personId);

  const [link] = await db
    .select({ id: pc.id, role: pc.role })
    .from(pc)
    .where(and(eq(pc.companyId, companyId), eq(pc.personId, personId), isNull(pc.endedAt)))
    .orderBy(desc(pc.updatedAt))
    .limit(1);

  if (link) {
    const roleChanged = link.role !== BILLING_CONTACT_ROLE;
    if (roleChanged) {
      await db.update(pc).set({ role: BILLING_CONTACT_ROLE, updatedAt: now }).where(eq(pc.id, link.id));
    }
    return { linkId: link.id, created: false, changed: roleChanged || demotedPersonIds.length > 0, demotedPersonIds };
  }

  const [primary] = await db
    .select({ id: pc.id })
    .from(pc)
    .where(and(eq(pc.personId, personId), eq(pc.isPrimary, true), isNull(pc.endedAt)))
    .limit(1);
  const id = generateId('pc');
  await db.insert(pc).values({
    id,
    createdAt: now,
    updatedAt: now,
    personId,
    companyId,
    role: BILLING_CONTACT_ROLE,
    isPrimary: !primary,
  });
  return { linkId: id, created: true, changed: true, demotedPersonIds };
}

/** The company has no billing contact any more. Returns who lost the role; they stay linked. */
export async function clearBillingContact(db: Database, companyId: string): Promise<string[]> {
  const cleared = await db
    .update(pc)
    .set({ role: null, updatedAt: new Date() })
    .where(and(eq(pc.companyId, companyId), eq(pc.role, BILLING_CONTACT_ROLE), isNull(pc.endedAt)))
    .returning({ personId: pc.personId });
  return cleared.map((row) => row.personId);
}
