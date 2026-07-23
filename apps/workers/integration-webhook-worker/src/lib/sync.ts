/**
 * Shared sync/upsert logic for integration webhook processing.
 * Used by both the webhook worker and Trigger.dev tasks.
 *
 * Writes to the new identity layer:
 *   - external "company" records → `schema.companies`
 *   - external "person" records  → `schema.people` (+ `person_companies` link
 *     when the source record had a parent company)
 *
 * Integration entity mappings use these `internalEntityType` values:
 *   - 'company' for companies, 'person' for people, 'activity' for note/task
 *   - 'list' / 'list-member' for list metadata and membership
 */

import { eq, and, isNull } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '@weldsuite/db/schema';
import type { MappedCompany, MappedPerson, ExternalNote, ExternalTask } from './integrations/types';
import { computeChecksum } from './integrations/providers/attio/mapper';
import { upsertByMapping } from './engine/sync/upsert';

type TenantDb = NeonHttpDatabase<typeof schema>;

function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
}

/**
 * Upsert a company from an external integration record.
 *
 * Strategy:
 * 1. Check entity mappings for an existing mapping
 * 2. If mapped → compare checksum → skip if unchanged, else update
 * 3. If not mapped → match by email
 * 4. If email match → create mapping + update
 * 5. No match → create new company + mapping
 */
export async function upsertCompany(
  db: TenantDb,
  connectionId: string,
  externalEntityType: string,
  externalEntityId: string,
  mapped: MappedCompany,
  rawData: unknown,
): Promise<{ action: 'created' | 'updated' | 'skipped'; companyId: string }> {
  const checksum = await computeChecksum(rawData);
  const name = mapped.data.name ?? 'Unknown Company';
  const values = {
    ...mapped.data,
    name,
    displayName: mapped.data.displayName ?? name,
  };

  const result = await upsertByMapping({
    db,
    connectionId,
    externalEntityType,
    externalEntityId,
    internalEntityType: 'company',
    table: schema.companies,
    idPrefix: 'company',
    values,
    checksum,
  });

  return { action: result.action, companyId: result.internalId };
}

/**
 * Upsert a person from an external integration record. When `parentCompanyId`
 * is provided, ensures a `person_companies` junction row exists linking the
 * person to that company.
 */
export async function upsertPerson(
  db: TenantDb,
  connectionId: string,
  externalEntityId: string,
  mapped: MappedPerson,
  parentCompanyId: string | undefined,
  rawData: unknown,
): Promise<{ action: 'created' | 'updated' | 'skipped'; personId: string }> {
  const checksum = await computeChecksum(rawData);
  const displayName =
    mapped.data.displayName ||
    mapped.data.fullName ||
    [mapped.data.firstName, mapped.data.lastName].filter(Boolean).join(' ') ||
    mapped.data.email ||
    'Unknown';
  const values = { ...mapped.data, displayName };

  const result = await upsertByMapping({
    db,
    connectionId,
    externalEntityType: 'person',
    externalEntityId,
    internalEntityType: 'person',
    table: schema.people,
    idPrefix: 'person',
    values,
    checksum,
  });

  if (parentCompanyId) {
    await ensurePersonCompanyLink(db, result.internalId, parentCompanyId);
  }

  return { action: result.action, personId: result.internalId };
}

/**
 * Ensure a `person_companies` junction row exists for the given pair.
 */
async function ensurePersonCompanyLink(
  db: TenantDb,
  personId: string,
  companyId: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: schema.personCompanies.id })
    .from(schema.personCompanies)
    .where(
      and(
        eq(schema.personCompanies.personId, personId),
        eq(schema.personCompanies.companyId, companyId),
      )
    )
    .limit(1);

  if (!existing) {
    await db.insert(schema.personCompanies).values({
      id: generateId('pc'),
      personId,
      companyId,
      isPrimary: true,
    });
  }
}

/**
 * Soft-delete an entity by its external mapping.
 */
export async function softDeleteByMapping(
  db: TenantDb,
  connectionId: string,
  externalEntityType: string,
  externalEntityId: string,
): Promise<boolean> {
  const [mapping] = await db
    .select()
    .from(schema.integrationEntityMappings)
    .where(
      and(
        eq(schema.integrationEntityMappings.connectionId, connectionId),
        eq(schema.integrationEntityMappings.externalEntityType, externalEntityType),
        eq(schema.integrationEntityMappings.externalEntityId, externalEntityId),
      )
    )
    .limit(1);

  if (!mapping) return false;

  const now = new Date();

  if (mapping.internalEntityType === 'company') {
    await db
      .update(schema.companies)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(schema.companies.id, mapping.internalEntityId));
  } else if (mapping.internalEntityType === 'person') {
    await db
      .update(schema.people)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(schema.people.id, mapping.internalEntityId));
  }

  return true;
}

/**
 * Resolve a WeldSuite Company ID from an external company record ID.
 */
export async function resolveCompanyByExternalId(
  db: TenantDb,
  connectionId: string,
  externalCompanyId: string,
): Promise<string | undefined> {
  const [mapping] = await db
    .select({ internalEntityId: schema.integrationEntityMappings.internalEntityId })
    .from(schema.integrationEntityMappings)
    .where(
      and(
        eq(schema.integrationEntityMappings.connectionId, connectionId),
        eq(schema.integrationEntityMappings.externalEntityType, 'company'),
        eq(schema.integrationEntityMappings.externalEntityId, externalCompanyId),
      )
    )
    .limit(1);

  return mapping?.internalEntityId;
}

/**
 * Resolve the WeldSuite entity ID + type for an external record (tries any type).
 */
export async function resolveEntityByExternalId(
  db: TenantDb,
  connectionId: string,
  externalRecordId: string,
): Promise<{ internalEntityId: string; internalEntityType: string } | undefined> {
  const [mapping] = await db
    .select({
      internalEntityId: schema.integrationEntityMappings.internalEntityId,
      internalEntityType: schema.integrationEntityMappings.internalEntityType,
    })
    .from(schema.integrationEntityMappings)
    .where(
      and(
        eq(schema.integrationEntityMappings.connectionId, connectionId),
        eq(schema.integrationEntityMappings.externalEntityId, externalRecordId),
      )
    )
    .limit(1);

  return mapping || undefined;
}

/**
 * Upsert a note from an external integration. Creates/updates a CRM activity
 * of type 'note', linked to the parent company (counterparty) or person.
 */
export async function upsertNote(
  db: TenantDb,
  connectionId: string,
  externalNoteId: string,
  note: ExternalNote,
  parentEntityId: string | undefined,
  parentEntityType: string | undefined,
): Promise<{ action: 'created' | 'updated' | 'skipped'; activityId: string }> {
  const checksum = await computeChecksum(note.raw);

  const [existingMapping] = await db
    .select()
    .from(schema.integrationEntityMappings)
    .where(
      and(
        eq(schema.integrationEntityMappings.connectionId, connectionId),
        eq(schema.integrationEntityMappings.externalEntityType, 'note'),
        eq(schema.integrationEntityMappings.externalEntityId, externalNoteId),
      )
    )
    .limit(1);

  const activityData: Record<string, unknown> = {
    type: 'note',
    subject: note.title,
    description: note.content,
    status: 'completed',
    assignedToId: 'system',
    source: 'attio',
  };

  // Link to parent entity. We use the new FK columns (`counterpartyId` /
  // `personId`); the legacy `customerId`/`contactId` columns are scheduled
  // for removal in the FK-cleanup phase.
  if (parentEntityId && parentEntityType === 'company') {
    activityData.counterpartyId = parentEntityId;
    activityData.relatedTo = 'company';
    activityData.relatedToId = parentEntityId;
  } else if (parentEntityId && parentEntityType === 'person') {
    activityData.personId = parentEntityId;
    activityData.relatedTo = 'person';
    activityData.relatedToId = parentEntityId;
  }

  if (existingMapping) {
    if (existingMapping.syncChecksum === checksum) {
      return { action: 'skipped', activityId: existingMapping.internalEntityId };
    }

    await db
      .update(schema.crmActivities)
      .set({ ...activityData, updatedAt: new Date() })
      .where(eq(schema.crmActivities.id, existingMapping.internalEntityId));

    await db
      .update(schema.integrationEntityMappings)
      .set({ syncChecksum: checksum, lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.integrationEntityMappings.id, existingMapping.id));

    return { action: 'updated', activityId: existingMapping.internalEntityId };
  }

  const activityId = generateId('act');
  await db.insert(schema.crmActivities).values({
    id: activityId,
    ...activityData,
  } as typeof schema.crmActivities.$inferInsert);

  await db.insert(schema.integrationEntityMappings).values({
    id: generateId('iem'),
    connectionId,
    externalEntityType: 'note',
    externalEntityId: externalNoteId,
    internalEntityType: 'activity',
    internalEntityId: activityId,
    lastSyncedAt: new Date(),
    syncChecksum: checksum,
  });

  return { action: 'created', activityId };
}

/**
 * Upsert a task from an external integration. Creates/updates a CRM activity
 * of type 'task'.
 */
export async function upsertTask(
  db: TenantDb,
  connectionId: string,
  externalTaskId: string,
  task: ExternalTask,
  linkedEntityId: string | undefined,
  linkedEntityType: string | undefined,
): Promise<{ action: 'created' | 'updated' | 'skipped'; activityId: string }> {
  const checksum = await computeChecksum(task.raw);

  const [existingMapping] = await db
    .select()
    .from(schema.integrationEntityMappings)
    .where(
      and(
        eq(schema.integrationEntityMappings.connectionId, connectionId),
        eq(schema.integrationEntityMappings.externalEntityType, 'task'),
        eq(schema.integrationEntityMappings.externalEntityId, externalTaskId),
      )
    )
    .limit(1);

  const subject = task.content.length > 255 ? task.content.substring(0, 252) + '...' : task.content;

  const activityData: Record<string, unknown> = {
    type: 'task',
    subject: subject || 'Untitled Task',
    description: task.content,
    status: task.isCompleted ? 'completed' : 'planned',
    priority: 'medium',
    assignedToId: 'system',
    source: 'attio',
    dueDate: task.deadlineAt ? new Date(task.deadlineAt) : undefined,
  };

  if (linkedEntityId && linkedEntityType === 'company') {
    activityData.counterpartyId = linkedEntityId;
    activityData.relatedTo = 'company';
    activityData.relatedToId = linkedEntityId;
  } else if (linkedEntityId && linkedEntityType === 'person') {
    activityData.personId = linkedEntityId;
    activityData.relatedTo = 'person';
    activityData.relatedToId = linkedEntityId;
  }

  if (existingMapping) {
    if (existingMapping.syncChecksum === checksum) {
      return { action: 'skipped', activityId: existingMapping.internalEntityId };
    }

    await db
      .update(schema.crmActivities)
      .set({ ...activityData, updatedAt: new Date() })
      .where(eq(schema.crmActivities.id, existingMapping.internalEntityId));

    await db
      .update(schema.integrationEntityMappings)
      .set({ syncChecksum: checksum, lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.integrationEntityMappings.id, existingMapping.id));

    return { action: 'updated', activityId: existingMapping.internalEntityId };
  }

  const activityId = generateId('act');
  await db.insert(schema.crmActivities).values({
    id: activityId,
    ...activityData,
  } as typeof schema.crmActivities.$inferInsert);

  await db.insert(schema.integrationEntityMappings).values({
    id: generateId('iem'),
    connectionId,
    externalEntityType: 'task',
    externalEntityId: externalTaskId,
    internalEntityType: 'activity',
    internalEntityId: activityId,
    lastSyncedAt: new Date(),
    syncChecksum: checksum,
  });

  return { action: 'created', activityId };
}

/**
 * Soft-delete a task by its external task ID.
 */
export async function softDeleteTask(
  db: TenantDb,
  connectionId: string,
  externalTaskId: string,
): Promise<boolean> {
  const [mapping] = await db
    .select()
    .from(schema.integrationEntityMappings)
    .where(
      and(
        eq(schema.integrationEntityMappings.connectionId, connectionId),
        eq(schema.integrationEntityMappings.externalEntityType, 'task'),
        eq(schema.integrationEntityMappings.externalEntityId, externalTaskId),
      )
    )
    .limit(1);

  if (!mapping) return false;

  const now = new Date();
  await db
    .update(schema.crmActivities)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(schema.crmActivities.id, mapping.internalEntityId));

  return true;
}

/**
 * Upsert a list and its membership entry from an external integration.
 *
 * `lists` + `list_members` replace the legacy `customer_lists` /
 * `customer_list_members` tables. The list is typed by `kind`
 * ('company' | 'person') — the external integration always syncs company
 * lists here (matches the prior behaviour which only wired up to customers).
 */
export async function upsertListAndEntry(
  db: TenantDb,
  connectionId: string,
  externalListId: string,
  listName: string,
  externalEntryId: string,
  parentCompanyId: string,
  _rawData: unknown,
): Promise<{ action: 'created' | 'updated' | 'skipped'; listId: string; memberId: string }> {
  // Step 1: Ensure `lists` row exists (mapped under externalEntityType='list')
  const [listMapping] = await db
    .select()
    .from(schema.integrationEntityMappings)
    .where(
      and(
        eq(schema.integrationEntityMappings.connectionId, connectionId),
        eq(schema.integrationEntityMappings.externalEntityType, 'list'),
        eq(schema.integrationEntityMappings.externalEntityId, externalListId),
      )
    )
    .limit(1);

  let internalListId: string;

  if (listMapping) {
    internalListId = listMapping.internalEntityId;
    await db
      .update(schema.lists)
      .set({ name: listName, updatedAt: new Date() })
      .where(eq(schema.lists.id, internalListId));
  } else {
    internalListId = generateId('list');
    await db.insert(schema.lists).values({
      id: internalListId,
      name: listName,
      kind: 'company',
      type: 'static',
    });

    await db.insert(schema.integrationEntityMappings).values({
      id: generateId('iem'),
      connectionId,
      externalEntityType: 'list',
      externalEntityId: externalListId,
      internalEntityType: 'list',
      internalEntityId: internalListId,
      lastSyncedAt: new Date(),
    });
  }

  // Step 2: Dedup membership row
  const [existingMember] = await db
    .select({ id: schema.listMembers.id })
    .from(schema.listMembers)
    .where(
      and(
        eq(schema.listMembers.listId, internalListId),
        eq(schema.listMembers.entityId, parentCompanyId),
      )
    )
    .limit(1);

  if (existingMember) {
    const [entryMapping] = await db
      .select()
      .from(schema.integrationEntityMappings)
      .where(
        and(
          eq(schema.integrationEntityMappings.connectionId, connectionId),
          eq(schema.integrationEntityMappings.externalEntityType, 'list-entry'),
          eq(schema.integrationEntityMappings.externalEntityId, externalEntryId),
        )
      )
      .limit(1);

    if (!entryMapping) {
      await db.insert(schema.integrationEntityMappings).values({
        id: generateId('iem'),
        connectionId,
        externalEntityType: 'list-entry',
        externalEntityId: externalEntryId,
        internalEntityType: 'list-member',
        internalEntityId: existingMember.id,
        lastSyncedAt: new Date(),
      });
    }

    return { action: 'skipped', listId: internalListId, memberId: existingMember.id };
  }

  // Step 3: Create membership + mapping
  const memberId = generateId('lm');
  await db.insert(schema.listMembers).values({
    id: memberId,
    listId: internalListId,
    entityId: parentCompanyId,
  });

  await db.insert(schema.integrationEntityMappings).values({
    id: generateId('iem'),
    connectionId,
    externalEntityType: 'list-entry',
    externalEntityId: externalEntryId,
    internalEntityType: 'list-member',
    internalEntityId: memberId,
    lastSyncedAt: new Date(),
  });

  return { action: 'created', listId: internalListId, memberId };
}

/**
 * Hard-delete a list entry by its external entry ID.
 */
export async function softDeleteListEntry(
  db: TenantDb,
  connectionId: string,
  externalEntryId: string,
): Promise<boolean> {
  const [mapping] = await db
    .select()
    .from(schema.integrationEntityMappings)
    .where(
      and(
        eq(schema.integrationEntityMappings.connectionId, connectionId),
        eq(schema.integrationEntityMappings.externalEntityType, 'list-entry'),
        eq(schema.integrationEntityMappings.externalEntityId, externalEntryId),
      )
    )
    .limit(1);

  if (!mapping) return false;

  await db
    .delete(schema.listMembers)
    .where(eq(schema.listMembers.id, mapping.internalEntityId));

  await db
    .delete(schema.integrationEntityMappings)
    .where(eq(schema.integrationEntityMappings.id, mapping.id));

  return true;
}

/**
 * Soft-delete a note by its external note ID.
 */
export async function softDeleteNote(
  db: TenantDb,
  connectionId: string,
  externalNoteId: string,
): Promise<boolean> {
  const [mapping] = await db
    .select()
    .from(schema.integrationEntityMappings)
    .where(
      and(
        eq(schema.integrationEntityMappings.connectionId, connectionId),
        eq(schema.integrationEntityMappings.externalEntityType, 'note'),
        eq(schema.integrationEntityMappings.externalEntityId, externalNoteId),
      )
    )
    .limit(1);

  if (!mapping) return false;

  const now = new Date();
  await db
    .update(schema.crmActivities)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(schema.crmActivities.id, mapping.internalEntityId));

  return true;
}
