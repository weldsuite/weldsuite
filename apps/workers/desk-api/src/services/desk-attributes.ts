/**
 * What an agent can pick for a conversation's ticket fields: the active
 * ticket types, their custom fields, the teams, and the tags in use.
 *
 * One read for the inbox details panel, gated on `conversations:read` so an
 * agent who may work conversations can fill them in without also holding
 * the ticket-type or department permissions.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const types = schema.helpdeskTicketTypes;
const teams = schema.helpdeskDepartments;
const defs = schema.customFieldDefinitions;
const conversations = schema.deskConversations;

/** How many of the most used tags the picker suggests. */
const TAG_SUGGESTIONS = 100;
/**
 * Tags are counted over conversations active this recently, so the read
 * stays the same size however long the workspace's history gets.
 */
const TAG_WINDOW_DAYS = 90;

export interface DeskAttributeOptions {
  ticketTypes: Array<{
    id: string;
    name: string;
    description: string | null;
    icon: string | null;
    color: string | null;
  }>;
  teams: Array<{ id: string; name: string }>;
  /** Ticket custom fields; `ticketTypeId` null applies to every type. */
  fields: Array<{
    id: string;
    ticketTypeId: string | null;
    slug: string;
    name: string;
    description: string | null;
    fieldType: string;
    options: { label: string; value: string; color?: string }[] | null;
    required: boolean;
    sortOrder: number;
  }>;
  /** Most used first, over conversations active in the last TAG_WINDOW_DAYS. */
  tags: Array<{ tag: string; count: number }>;
}

export async function getDeskAttributeOptions(db: Database): Promise<DeskAttributeOptions> {
  const [ticketTypes, teamRows, fieldRows, tagResult] = await Promise.all([
    db
      .select({ id: types.id, name: types.name, description: types.description, icon: types.icon, color: types.color })
      .from(types)
      .where(and(isNull(types.deletedAt), eq(types.isActive, true)))
      .orderBy(asc(types.sortOrder), asc(types.name)),
    db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(and(isNull(teams.deletedAt), eq(teams.isActive, true)))
      .orderBy(asc(teams.name)),
    db
      .select({
        id: defs.id,
        ticketTypeId: defs.ticketTypeId,
        slug: defs.slug,
        name: defs.name,
        description: defs.description,
        fieldType: defs.fieldType,
        options: defs.options,
        required: defs.required,
        sortOrder: defs.sortOrder,
      })
      .from(defs)
      .where(and(eq(defs.entityType, 'ticket'), isNull(defs.deletedAt)))
      .orderBy(asc(defs.sortOrder), asc(defs.name)),
    db.execute<{ tag: string; count: number }>(sql`
      SELECT tag, count(*)::int AS count
      FROM ${conversations}, jsonb_array_elements_text(${conversations.tags}) AS tag
      WHERE ${conversations.tags} <> '[]'::jsonb
        AND COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt}) > now() - make_interval(days => ${TAG_WINDOW_DAYS})
      GROUP BY tag
      ORDER BY count DESC, tag ASC
      LIMIT ${TAG_SUGGESTIONS}
    `),
  ]);

  const tagRows =
    (tagResult as unknown as { rows?: Array<{ tag: string; count: number }> }).rows ??
    (tagResult as unknown as Array<{ tag: string; count: number }>);

  return {
    ticketTypes,
    teams: teamRows,
    fields: fieldRows.map((f) => ({ ...f, required: f.required ?? false, sortOrder: f.sortOrder ?? 0 })),
    tags: (tagRows ?? []).map((r) => ({ tag: r.tag, count: Number(r.count) })),
  };
}
