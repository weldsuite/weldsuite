/**
 * Sync a helpdesk ticket type's dynamic-form fields into
 * `custom_field_definitions` (entityType='ticket', scoped by `ticketTypeId`).
 *
 * Ticket types author their fields as a `TicketTypeField[]` blob on
 * `helpdesk_ticket_types.fields`. Pile B makes those a first-class custom-field
 * definition set so ticket field VALUES can live in `custom_field_values`
 * instead of the `helpdesk_tickets.customFields` blob. This helper keeps the two
 * in step: call it after every write to a ticket type's `fields`.
 *
 * Pure (loose `AnyDb`, injected `generateId`) so it is callable from any worker.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { FIELD_TYPES } from '@weldsuite/app-api-client/schemas/custom-fields';
import * as schema from '../schema';
import type { TicketTypeField } from '../schema';
import type { IdGenerator } from './mail-contacts';

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type FieldType = (typeof FIELD_TYPES)[number];

const defs = schema.customFieldDefinitions;

/** Map a ticket-type field's `type` onto a custom-field `fieldType`. */
function mapFieldType(type: TicketTypeField['type']): FieldType {
  switch (type) {
    case 'select':
      return 'single_select';
    case 'multiselect':
      return 'multi_select';
    case 'checkbox':
      return 'boolean';
    case 'textarea':
      return 'textarea';
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'email':
      return 'email';
    case 'url':
      return 'url';
    case 'text':
    default:
      return 'text';
  }
}

/**
 * Upsert one definition per non-default ticket-type field and soft-delete
 * definitions for fields that were removed. Keyed by (entityType='ticket',
 * ticketTypeId, slug=field.key). `isDefault` fields are the built-in ones that
 * map to real `helpdesk_tickets` columns, not the blob — they are skipped.
 *
 * Safe to call on every ticket-type create/update: it diffs against the current
 * definition rows and only writes what changed.
 */
export async function syncTicketTypeDefinitions(
  db: AnyDb,
  generateId: IdGenerator,
  ticketTypeId: string,
  fields: TicketTypeField[] | null | undefined,
): Promise<void> {
  const custom = (fields ?? []).filter((f) => f && f.key && !f.isDefault);
  const desiredBySlug = new Map(custom.map((f) => [f.key, f]));

  // Current active definitions scoped to this ticket type.
  const existing = await db
    .select()
    .from(defs)
    .where(
      and(
        eq(defs.entityType, 'ticket'),
        eq(defs.ticketTypeId, ticketTypeId),
        isNull(defs.deletedAt),
      ),
    );
  const existingBySlug = new Map(existing.map((d) => [d.slug, d]));
  const now = new Date();

  // Upsert every desired field.
  for (const field of custom) {
    const fieldType = mapFieldType(field.type);
    const options =
      field.options && field.options.length > 0
        ? field.options.map((o) => ({ label: o.label, value: o.value }))
        : null;
    const prior = existingBySlug.get(field.key);

    if (prior) {
      await db
        .update(defs)
        .set({
          name: field.label,
          fieldType,
          options,
          required: field.required ?? false,
          sortOrder: field.order ?? 0,
          updatedAt: now,
        })
        .where(eq(defs.id, prior.id));
    } else {
      await db.insert(defs).values({
        id: generateId('cfld'),
        entityType: 'ticket',
        ticketTypeId,
        name: field.label,
        slug: field.key,
        fieldType,
        options,
        required: field.required ?? false,
        sortOrder: field.order ?? 0,
        createdAt: now,
        updatedAt: now,
      } as typeof defs.$inferInsert);
    }
  }

  // Soft-delete definitions whose field was removed from the ticket type. Value
  // rows keyed on the retired definition go inert (recoverable), matching how a
  // soft-deleted definition behaves everywhere else.
  for (const prior of existing) {
    if (!desiredBySlug.has(prior.slug)) {
      await db
        .update(defs)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(defs.id, prior.id));
    }
  }
}
