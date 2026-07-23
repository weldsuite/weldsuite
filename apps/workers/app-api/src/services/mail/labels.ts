/**
 * Gmail-like label helpers + label CRUD.
 *
 * System labels use UPPERCASE slugs (`INBOX`, `SENT`, …) so they sort
 * predictably and can never collide with a user-defined label, which
 * keeps its original casing.
 *
 * The CRUD section operates on the `mail_labels` table (per-account) and
 * exposes bulk apply/unapply against `mail_messages.labels` (JSONB).
 * Both bulk paths are single-statement JSONB updates instead of the
 * row-by-row scan the legacy api-worker used.
 */

import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { schema } from '../../db';
import type { Database } from '../../db';
import { generateId } from '../../lib/id';

const { mailMessages, mailLabels } = schema;

export const SYSTEM_LABELS = {
  INBOX: 'INBOX',
  SENT: 'SENT',
  DRAFT: 'DRAFT',
  DRAFTS: 'DRAFTS',
  TRASH: 'TRASH',
  SPAM: 'SPAM',
  STARRED: 'STARRED',
  IMPORTANT: 'IMPORTANT',
  ARCHIVE: 'ARCHIVE',
  SNOOZED: 'SNOOZED',
  SCHEDULED: 'SCHEDULED',
} as const;

export type SystemLabel = (typeof SYSTEM_LABELS)[keyof typeof SYSTEM_LABELS];

const SLUG_TO_SYSTEM_LABEL: Record<string, string> = {
  inbox: 'INBOX',
  sent: 'SENT',
  draft: 'DRAFT',
  drafts: 'DRAFTS',
  trash: 'TRASH',
  spam: 'SPAM',
  starred: 'STARRED',
  important: 'IMPORTANT',
  archive: 'ARCHIVE',
  snoozed: 'SNOOZED',
  scheduled: 'SCHEDULED',
};

export function isSystemLabelSlug(slug: string): boolean {
  return slug.toLowerCase() in SLUG_TO_SYSTEM_LABEL;
}

export function toSystemLabel(slug: string): string | null {
  return SLUG_TO_SYSTEM_LABEL[slug.toLowerCase()] ?? null;
}

/**
 * JSONB containment predicate — matches messages whose `labels` array
 * holds the given label. Accepts both system slugs (resolved up-case) and
 * raw user labels.
 */
export function labelCondition(labelSlug: string) {
  const systemLabel = toSystemLabel(labelSlug);
  const label = systemLabel ?? labelSlug;
  return sql`${mailMessages.labels} @> ${JSON.stringify([label])}::jsonb`;
}

export function addLabels(existing: string[] | null, ...labels: string[]): string[] {
  const set = new Set(existing ?? []);
  for (const l of labels) set.add(l);
  return Array.from(set);
}

export function removeLabels(existing: string[] | null, ...labels: string[]): string[] {
  const toRemove = new Set(labels);
  return (existing ?? []).filter((l) => !toRemove.has(l));
}

// ===========================================================================
// CRUD
// ===========================================================================

export class MailLabelError extends Error {
  constructor(
    public readonly code:
      | 'DUPLICATE_NAME'
      | 'NOT_FOUND'
      | 'SYSTEM_LABEL_IMMUTABLE',
    message: string,
  ) {
    super(message);
    this.name = 'MailLabelError';
  }
}

export interface ListLabelsFilters {
  accountId?: string;
}

export async function listMailLabels(db: Database, filters: ListLabelsFilters) {
  const conditions: SQL[] = [isNull(mailLabels.deletedAt)!];
  if (filters.accountId) conditions.push(eq(mailLabels.accountId, filters.accountId));
  return db.select().from(mailLabels).where(and(...conditions));
}

export async function getMailLabel(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(mailLabels)
    .where(and(eq(mailLabels.id, id), isNull(mailLabels.deletedAt)))
    .limit(1);
  return row ?? null;
}

export interface CreateMailLabelInput {
  accountId: string;
  name: string;
  color?: string;
  aiEnabled?: boolean;
  aiKeywords?: string[];
  aiDescription?: string;
  aiConfidence?: number;
}

export async function createMailLabel(db: Database, data: CreateMailLabelInput) {
  // Case-insensitive duplicate check within the account.
  const [existing] = await db
    .select({ id: mailLabels.id })
    .from(mailLabels)
    .where(
      and(
        eq(mailLabels.accountId, data.accountId),
        sql`LOWER(${mailLabels.name}) = LOWER(${data.name})`,
        isNull(mailLabels.deletedAt),
      ),
    )
    .limit(1);
  if (existing) {
    throw new MailLabelError('DUPLICATE_NAME', 'A label with this name already exists on this account');
  }

  const id = generateId('label');
  const now = new Date();
  await db.insert(mailLabels).values({
    id,
    accountId: data.accountId,
    name: data.name,
    color: data.color ?? null,
    messageCount: 0,
    aiEnabled: data.aiEnabled ?? false,
    aiKeywords: data.aiKeywords ?? null,
    aiDescription: data.aiDescription ?? null,
    aiConfidence: data.aiConfidence ?? 70,
    createdAt: now,
    updatedAt: now,
  });

  const [row] = await db.select().from(mailLabels).where(eq(mailLabels.id, id));
  return row!;
}

export interface UpdateMailLabelInput {
  name?: string;
  color?: string;
  position?: number;
  aiEnabled?: boolean;
  aiKeywords?: string[];
  aiDescription?: string;
  aiConfidence?: number;
}

export async function updateMailLabel(
  db: Database,
  id: string,
  data: UpdateMailLabelInput,
) {
  const [existing] = await db
    .select()
    .from(mailLabels)
    .where(and(eq(mailLabels.id, id), isNull(mailLabels.deletedAt)))
    .limit(1);
  if (!existing) throw new MailLabelError('NOT_FOUND', 'Label not found');

  // System labels are immutable except for `position` — renaming SENT
  // would silently break every reference in `mail_messages.labels`.
  if (existing.isSystem) {
    const allowed = new Set(['position']);
    for (const key of Object.keys(data)) {
      if (data[key as keyof UpdateMailLabelInput] !== undefined && !allowed.has(key)) {
        throw new MailLabelError(
          'SYSTEM_LABEL_IMMUTABLE',
          'System labels cannot be renamed or recoloured; only `position` may change.',
        );
      }
    }
  }

  // Rename collision check.
  if (data.name && data.name !== existing.name) {
    const [collision] = await db
      .select({ id: mailLabels.id })
      .from(mailLabels)
      .where(
        and(
          eq(mailLabels.accountId, existing.accountId),
          sql`LOWER(${mailLabels.name}) = LOWER(${data.name})`,
          isNull(mailLabels.deletedAt),
          sql`${mailLabels.id} != ${id}`,
        ),
      )
      .limit(1);
    if (collision) {
      throw new MailLabelError('DUPLICATE_NAME', 'A label with this name already exists on this account');
    }
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) if (v !== undefined) patch[k] = v;
  await db
    .update(mailLabels)
    .set(patch as typeof mailLabels.$inferInsert)
    .where(eq(mailLabels.id, id));

  // If the label was renamed, rewrite every message's JSONB labels array so
  // the rename is visible without rebuilding the index. Single SQL pass.
  if (data.name && data.name !== existing.name) {
    await db.execute(sql`
      UPDATE mail_messages
      SET labels = (
        SELECT jsonb_agg(CASE WHEN value = ${existing.name} THEN to_jsonb(${data.name}::text) ELSE value END)
        FROM jsonb_array_elements(labels)
      )
      WHERE account_id = ${existing.accountId}
        AND labels @> ${JSON.stringify([existing.name])}::jsonb
        AND deleted_at IS NULL
    `);
  }

  const [after] = await db.select().from(mailLabels).where(eq(mailLabels.id, id));
  return { before: existing, after: after! };
}

export async function deleteMailLabel(db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(mailLabels)
    .where(and(eq(mailLabels.id, id), isNull(mailLabels.deletedAt)))
    .limit(1);
  if (!existing) return null;
  if (existing.isSystem) {
    throw new MailLabelError('SYSTEM_LABEL_IMMUTABLE', 'System labels cannot be deleted');
  }

  await db
    .update(mailLabels)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(mailLabels.id, id));

  // Strip the label from every message that references it by name.
  await db.execute(sql`
    UPDATE mail_messages
    SET labels = labels - ${existing.name}::text, updated_at = NOW()
    WHERE account_id = ${existing.accountId}
      AND labels @> ${JSON.stringify([existing.name])}::jsonb
      AND deleted_at IS NULL
  `);

  return existing;
}

// ===========================================================================
// Bulk apply / unapply against mail_messages.labels (JSONB)
// ===========================================================================

/**
 * Append `labelName` to every message's labels JSONB array — but only on
 * rows where it isn't already present. Returns the count of affected rows
 * plus the set of accountIds touched, so the caller can bump label counts.
 */
export async function bulkAddLabelToMessages(
  db: Database,
  labelName: string,
  messageIds: string[],
): Promise<{ affected: number; accountIds: string[] }> {
  if (messageIds.length === 0) return { affected: 0, accountIds: [] };
  const rows = await db
    .update(mailMessages)
    .set({
      labels: sql`COALESCE(${mailMessages.labels}, '[]'::jsonb) || ${JSON.stringify([labelName])}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(mailMessages.id, messageIds),
        isNull(mailMessages.deletedAt),
        sql`NOT COALESCE(${mailMessages.labels}, '[]'::jsonb) @> ${JSON.stringify([labelName])}::jsonb`,
      ),
    )
    .returning({ accountId: mailMessages.accountId });
  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  await updateLabelMessageCount(db, labelName, accountIds, rows.length);
  return { affected: rows.length, accountIds };
}

export async function bulkRemoveLabelFromMessages(
  db: Database,
  labelName: string,
  messageIds: string[],
): Promise<{ affected: number; accountIds: string[] }> {
  if (messageIds.length === 0) return { affected: 0, accountIds: [] };
  const rows = await db
    .update(mailMessages)
    .set({
      labels: sql`COALESCE(${mailMessages.labels}, '[]'::jsonb) - ${labelName}::text`,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(mailMessages.id, messageIds),
        isNull(mailMessages.deletedAt),
        sql`COALESCE(${mailMessages.labels}, '[]'::jsonb) @> ${JSON.stringify([labelName])}::jsonb`,
      ),
    )
    .returning({ accountId: mailMessages.accountId });
  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  await updateLabelMessageCount(db, labelName, accountIds, -rows.length);
  return { affected: rows.length, accountIds };
}

/**
 * Apply or remove `labelName` from every message in a thread. Returns
 * the count of messages whose JSONB array changed.
 */
export async function applyLabelToThread(
  db: Database,
  accountId: string,
  threadId: string,
  labelName: string,
  action: 'add' | 'remove',
): Promise<{ affected: number }> {
  const messages = await db
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.accountId, accountId),
        sql`COALESCE(${mailMessages.threadId}, ${mailMessages.id}) = ${threadId}`,
        isNull(mailMessages.deletedAt),
      ),
    );
  if (messages.length === 0) return { affected: 0 };
  const ids = messages.map((m) => m.id);
  const result = action === 'add'
    ? await bulkAddLabelToMessages(db, labelName, ids)
    : await bulkRemoveLabelFromMessages(db, labelName, ids);
  return { affected: result.affected };
}

async function updateLabelMessageCount(
  db: Database,
  labelName: string,
  accountIds: string[],
  delta: number,
): Promise<void> {
  if (accountIds.length === 0 || delta === 0) return;
  await db.execute(sql`
    UPDATE mail_labels
    SET message_count = GREATEST(0, message_count + ${delta}),
        updated_at = NOW()
    WHERE name = ${labelName}
      AND account_id = ANY(ARRAY[${sql.join(accountIds.map((id) => sql`${id}`), sql`, `)}]::text[])
      AND deleted_at IS NULL
  `);
}
