/**
 * Stakeholder register queries shared by `/api/project-stakeholders`, the
 * status reports (who a report goes to) and the portal invitation (design:
 * weldflow-delivery-and-portfolio.md, ADR FLOW-020).
 *
 * The rules (identity, RACI checks, the portal address, the wire shape) are in
 * `@weldsuite/flow-domain/stakeholders`; this file is the database side:
 * finding a stakeholder, looking up the member or contact behind each one,
 * and the live project check.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { StakeholderIdentity } from '@weldsuite/flow-domain/stakeholders';

const stakeholders = schema.projectStakeholders;

export type StakeholderRow = typeof stakeholders.$inferSelect;
export type NewStakeholderRow = typeof stakeholders.$inferInsert;

/** Whether a live (not soft-deleted) project exists. */
export async function liveProjectExists(db: Database, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)))
    .limit(1);
  return !!row;
}

/** A live register entry by id. */
export async function findStakeholder(db: Database, id: string): Promise<StakeholderRow | null> {
  const [row] = await db
    .select()
    .from(stakeholders)
    .where(and(eq(stakeholders.id, id), isNull(stakeholders.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** Every live entry of a project's register, oldest first. */
export async function stakeholdersOfProject(db: Database, projectId: string): Promise<StakeholderRow[]> {
  return db
    .select()
    .from(stakeholders)
    .where(and(eq(stakeholders.projectId, projectId), isNull(stakeholders.deletedAt)))
    .orderBy(stakeholders.createdAt, stakeholders.id);
}

/** The member's name and email, by user id. */
export async function memberIdentities(db: Database, userIds: string[]): Promise<Map<string, StakeholderIdentity>> {
  const out = new Map<string, StakeholderIdentity>();
  if (userIds.length === 0) return out;
  const rows = await db
    .select({ userId: schema.workspaceMembers.userId, name: schema.workspaceMembers.name, email: schema.workspaceMembers.email })
    .from(schema.workspaceMembers)
    .where(inArray(schema.workspaceMembers.userId, userIds));
  for (const row of rows) {
    if (!out.has(row.userId)) out.set(row.userId, { name: row.name ?? null, email: row.email ?? null });
  }
  return out;
}

/** The CRM contact's display name and email, by `people.id`. */
export async function contactIdentities(db: Database, contactIds: string[]): Promise<Map<string, StakeholderIdentity>> {
  const out = new Map<string, StakeholderIdentity>();
  if (contactIds.length === 0) return out;
  const rows = await db
    .select({ id: schema.people.id, name: schema.people.displayName, email: schema.people.email })
    .from(schema.people)
    .where(and(inArray(schema.people.id, contactIds), isNull(schema.people.deletedAt)));
  for (const row of rows) out.set(row.id, { name: row.name ?? null, email: row.email ?? null });
  return out;
}

const NOBODY: StakeholderIdentity = { name: null, email: null };

/** The name and email behind each entry: its member's or its contact's, nulls when the person is gone. */
export async function identitiesOf(db: Database, rows: readonly StakeholderRow[]): Promise<Map<string, StakeholderIdentity>> {
  const [members, contacts] = await Promise.all([
    memberIdentities(db, rows.flatMap((row) => (row.memberId ? [row.memberId] : []))),
    contactIdentities(db, rows.flatMap((row) => (row.crmContactId ? [row.crmContactId] : []))),
  ]);
  const out = new Map<string, StakeholderIdentity>();
  for (const row of rows) {
    const contact = row.crmContactId ? contacts.get(row.crmContactId) : undefined;
    const found = row.memberId ? members.get(row.memberId) : contact;
    out.set(row.id, found ?? NOBODY);
  }
  return out;
}

export function identityOf(identities: Map<string, StakeholderIdentity>, id: string): StakeholderIdentity {
  return identities.get(id) ?? NOBODY;
}

/** True when a workspace member with this user id exists. */
export async function memberExists(db: Database, userId: string): Promise<boolean> {
  return (await memberIdentities(db, [userId])).has(userId);
}

/** True when a live CRM contact (person) with this id exists. */
export async function contactExists(db: Database, contactId: string): Promise<boolean> {
  return (await contactIdentities(db, [contactId])).has(contactId);
}

/** An ISO timestamp from a request body, or null. */
export function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}
