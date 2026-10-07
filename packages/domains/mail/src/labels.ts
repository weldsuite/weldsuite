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
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { generateId } from '@weldsuite/worker-kit/id';
import { accountScopeCondition } from './access';

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
  PROMOTIONS: 'PROMOTIONS',
  PINNED: 'PINNED',
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
  promotions: 'PROMOTIONS',
  pinned: 'PINNED',
};

export function isSystemLabelSlug(slug: string): boolean {
  return slug.toLowerCase() in SLUG_TO_SYSTEM_LABEL;
}

export function toSystemLabel(slug: string): string | null {
  return SLUG_TO_SYSTEM_LABEL[slug.toLowerCase()] ?? null;
}

/** The value a label is stored as: system slugs upper-cased, user labels as typed. */
export function normalizeLabel(label: string): string {
  return toSystemLabel(label) ?? label;
}

/**
 * Where a message lives. A message sits in at most one of these, so trashing,
 * archiving or marking spam takes it out of the inbox instead of adding a
 * second folder (Gmail-style location labels).
 */
export const LOCATION_LABELS = ['INBOX', 'ARCHIVE', 'TRASH', 'SPAM'] as const;
export type LocationLabel = (typeof LOCATION_LABELS)[number];

export function isLocationLabel(label: string): label is LocationLabel {
  return (LOCATION_LABELS as readonly string[]).includes(label);
}

/**
 * Labels a move to any location clears: the other locations, the promotions
 * tab, and a pending snooze (a snoozed mail that is trashed must not wake up
 * in the inbox).
 */
const CLEARED_BY_MOVE: readonly string[] = [...LOCATION_LABELS, 'PROMOTIONS', 'SNOOZED'];

/** Mail the mailbox sent or is still writing; a restore never puts it in the inbox. */
const OUTGOING_LABELS: readonly string[] = ['SENT', 'DRAFT', 'DRAFTS', 'SCHEDULED'];

function hasLabel(label: string): SQL {
  return sql`${mailMessages.labels} @> ${JSON.stringify([label])}::jsonb`;
}

/** Messages in the trash or in spam: left out of every other folder listing. */
export function inTrashOrSpamCondition(): SQL {
  return sql`(COALESCE(${mailMessages.labels}, '[]'::jsonb) @> '["TRASH"]'::jsonb OR COALESCE(${mailMessages.labels}, '[]'::jsonb) @> '["SPAM"]'::jsonb)`;
}

/**
 * JSONB containment predicate — matches messages whose `labels` array
 * holds the given label. Accepts both system slugs (resolved up-case) and
 * raw user labels.
 *
 * A user label is matched by the names in `customNames` as well, which is how
 * the `/invoices` folder finds messages labelled `Invoices`
 * (see `resolveCustomLabelNames`). Starred and important also accept the
 * boolean column, for mail flagged before the label and the column were kept
 * in step.
 */
export function labelCondition(labelSlug: string, customNames: string[] = []): SQL {
  const systemLabel = toSystemLabel(labelSlug);
  if (systemLabel === SYSTEM_LABELS.STARRED) {
    return sql`(${hasLabel(systemLabel)} OR ${mailMessages.isStarred} = true)`;
  }
  if (systemLabel === SYSTEM_LABELS.IMPORTANT) {
    return sql`(${hasLabel(systemLabel)} OR ${mailMessages.isImportant} = true)`;
  }
  if (systemLabel) return hasLabel(systemLabel);

  const names = [...new Set([labelSlug, ...customNames])];
  if (names.length === 1) return hasLabel(names[0]!);
  return sql`(${sql.join(names.map(hasLabel), sql` OR `)})`;
}

/**
 * The stored label names a non-system slug stands for. Folder links carry the
 * label name lower-cased while messages carry it as typed, so the slug is
 * matched against `mail_labels` case-insensitively (label names are unique per
 * account that way). Empty for system slugs.
 */
export async function resolveCustomLabelNames(
  db: Database,
  labelSlug: string,
  accountId?: string,
): Promise<string[]> {
  if (toSystemLabel(labelSlug)) return [];
  const conditions: SQL[] = [
    isNull(mailLabels.deletedAt)!,
    sql`LOWER(${mailLabels.name}) = LOWER(${labelSlug})`,
  ];
  if (accountId) conditions.push(eq(mailLabels.accountId, accountId));
  const rows = await db
    .selectDistinct({ name: mailLabels.name })
    .from(mailLabels)
    .where(and(...conditions));
  return rows.map((r) => r.name);
}

/**
 * Add labels the way every write path must: system slugs normalised, no
 * duplicates, and a location label replacing the previous location.
 */
export function addLabels(existing: string[] | null, ...labels: string[]): string[] {
  let next = [...new Set(existing ?? [])];
  for (const raw of labels) {
    const label = normalizeLabel(raw);
    if (isLocationLabel(label)) next = next.filter((l) => !CLEARED_BY_MOVE.includes(l));
    if (!next.includes(label)) next.push(label);
  }
  return next;
}

export function removeLabels(existing: string[] | null, ...labels: string[]): string[] {
  const toRemove = new Set(labels.map(normalizeLabel));
  return (existing ?? []).filter((l) => !toRemove.has(l));
}

/** The boolean columns on `mail_messages` that mirror a system label. */
export interface LabelFlags {
  isStarred?: boolean;
  isImportant?: boolean;
  isTrash?: boolean;
  isSpam?: boolean;
}

/**
 * The flag columns to write alongside a label change, for the labels it
 * touched only: starring sets `isStarred`, a move sets `isTrash` / `isSpam` to
 * match the new location. Untouched flags are left alone.
 */
export function flagsForLabelChange(labels: string[], action: 'add' | 'remove'): LabelFlags {
  const flags: LabelFlags = {};
  const on = action === 'add';
  for (const raw of labels) {
    const label = normalizeLabel(raw);
    if (label === SYSTEM_LABELS.STARRED) flags.isStarred = on;
    else if (label === SYSTEM_LABELS.IMPORTANT) flags.isImportant = on;
    else if (on && isLocationLabel(label)) {
      flags.isTrash = label === SYSTEM_LABELS.TRASH;
      flags.isSpam = label === SYSTEM_LABELS.SPAM;
    } else if (label === SYSTEM_LABELS.TRASH) flags.isTrash = false;
    else if (label === SYSTEM_LABELS.SPAM) flags.isSpam = false;
  }
  return flags;
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
  /** Restricts results to these accounts (the caller's reachable mailboxes). */
  accessibleAccountIds?: string[];
}

export async function listMailLabels(db: Database, filters: ListLabelsFilters) {
  const conditions: SQL[] = [isNull(mailLabels.deletedAt)!];
  if (filters.accountId) conditions.push(eq(mailLabels.accountId, filters.accountId));
  if (filters.accessibleAccountIds) {
    conditions.push(accountScopeCondition(mailLabels.accountId, filters.accessibleAccountIds));
  }
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

/**
 * A user label may not take a system folder's name in any casing: `starred`
 * on a message always means the system label, so a custom "Starred" could
 * never be told apart from it.
 */
function assertNotReservedName(name: string): void {
  if (isSystemLabelSlug(name.trim())) {
    throw new MailLabelError('DUPLICATE_NAME', 'This name is reserved for a system folder');
  }
}

export async function createMailLabel(db: Database, data: CreateMailLabelInput) {
  assertNotReservedName(data.name);
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

/**
 * System labels are immutable except for `position` — renaming SENT
 * would silently break every reference in `mail_messages.labels`.
 */
function assertSystemLabelPatchAllowed(data: UpdateMailLabelInput): void {
  const touchesImmutable = Object.entries(data).some(([key, value]) => value !== undefined && key !== 'position');
  if (touchesImmutable) {
    throw new MailLabelError(
      'SYSTEM_LABEL_IMMUTABLE',
      'System labels cannot be renamed or recoloured; only `position` may change.',
    );
  }
}

/** Rename collision check. */
async function assertLabelNameAvailable(
  db: Database,
  existing: typeof mailLabels.$inferSelect,
  id: string,
  name: string,
): Promise<void> {
  assertNotReservedName(name);
  const [collision] = await db
    .select({ id: mailLabels.id })
    .from(mailLabels)
    .where(
      and(
        eq(mailLabels.accountId, existing.accountId),
        sql`LOWER(${mailLabels.name}) = LOWER(${name})`,
        isNull(mailLabels.deletedAt),
        sql`${mailLabels.id} != ${id}`,
      ),
    )
    .limit(1);
  if (collision) {
    throw new MailLabelError('DUPLICATE_NAME', 'A label with this name already exists on this account');
  }
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

  if (existing.isSystem) assertSystemLabelPatchAllowed(data);

  const newName = data.name && data.name !== existing.name ? data.name : null;
  if (newName) await assertLabelNameAvailable(db, existing, id, newName);

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) if (v !== undefined) patch[k] = v;

  // A rename rewrites the label row and every message carrying the old name as
  // one unit: a label that is renamed but still stored under its old name on
  // its messages has lost all of them.
  await atomically(db, (handle) => {
    const statements: unknown[] = [
      handle
        .update(mailLabels)
        .set(patch as typeof mailLabels.$inferInsert)
        .where(eq(mailLabels.id, id)),
    ];
    if (newName) {
      statements.push(
        handle
          .update(mailMessages)
          .set({
            // `value` is a jsonb element, so the old name is compared as jsonb
            // too: a bare text parameter is not valid JSON and fails the cast.
            labels: sql`(
              SELECT jsonb_agg(CASE WHEN value = to_jsonb(${existing.name}::text) THEN to_jsonb(${newName}::text) ELSE value END)
              FROM jsonb_array_elements(${mailMessages.labels})
            )`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(mailMessages.accountId, existing.accountId),
              hasLabel(existing.name),
              isNull(mailMessages.deletedAt),
            ),
          ),
      );
    }
    return statements;
  });

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

function textArray(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`;
}

/**
 * Move messages to one location in a single statement: every other location
 * label (and PROMOTIONS / SNOOZED) is dropped, the new one is added once, and
 * `is_trash` / `is_spam` follow it. Moving to the inbox puts sent, scheduled
 * and draft copies back where they were instead of listing them as received
 * mail.
 */
export async function moveMessagesToLocation(
  db: Database,
  messageIds: string[],
  location: LocationLabel,
): Promise<{ affected: number; accountIds: string[] }> {
  if (messageIds.length === 0) return { affected: 0, accountIds: [] };
  const cleared = sql`(COALESCE(${mailMessages.labels}, '[]'::jsonb) - ${textArray(CLEARED_BY_MOVE)})`;
  const target = sql`${JSON.stringify([location])}::jsonb`;
  const isOutgoing = sql.join(
    OUTGOING_LABELS.map((l) => sql`${cleared} @> ${JSON.stringify([l])}::jsonb`),
    sql` OR `,
  );
  const nextLabels =
    location === SYSTEM_LABELS.INBOX
      ? sql`CASE WHEN ${isOutgoing} THEN ${cleared} ELSE ${cleared} || ${target} END`
      : sql`${cleared} || ${target}`;

  const rows = await db
    .update(mailMessages)
    .set({
      labels: nextLabels,
      isTrash: location === SYSTEM_LABELS.TRASH,
      isSpam: location === SYSTEM_LABELS.SPAM,
      snoozedUntil: null,
      updatedAt: new Date(),
    })
    .where(and(inArray(mailMessages.id, messageIds), isNull(mailMessages.deletedAt)))
    .returning({ accountId: mailMessages.accountId });
  return { affected: rows.length, accountIds: [...new Set(rows.map((r) => r.accountId))] };
}

/**
 * Append `labelName` to every message's labels JSONB array — but only on
 * rows where it isn't already present. Returns the count of affected rows
 * plus the set of accountIds touched, so the caller can bump label counts.
 *
 * System slugs are normalised (`starred` → `STARRED`), the mirrored flag
 * column is written with the label, and a location label is a move (see
 * `moveMessagesToLocation`).
 */
export async function bulkAddLabelToMessages(
  db: Database,
  labelName: string,
  messageIds: string[],
): Promise<{ affected: number; accountIds: string[] }> {
  if (messageIds.length === 0) return { affected: 0, accountIds: [] };
  const label = normalizeLabel(labelName);
  if (isLocationLabel(label)) return moveMessagesToLocation(db, messageIds, label);

  const rows = await db
    .update(mailMessages)
    .set({
      labels: sql`COALESCE(${mailMessages.labels}, '[]'::jsonb) || ${JSON.stringify([label])}::jsonb`,
      ...flagsForLabelChange([label], 'add'),
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(mailMessages.id, messageIds),
        isNull(mailMessages.deletedAt),
        sql`NOT COALESCE(${mailMessages.labels}, '[]'::jsonb) @> ${JSON.stringify([label])}::jsonb`,
      ),
    )
    .returning({ accountId: mailMessages.accountId });
  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  await updateLabelMessageCount(db, label, accountIds, rows.length);
  return { affected: rows.length, accountIds };
}

export async function bulkRemoveLabelFromMessages(
  db: Database,
  labelName: string,
  messageIds: string[],
): Promise<{ affected: number; accountIds: string[] }> {
  if (messageIds.length === 0) return { affected: 0, accountIds: [] };
  const label = normalizeLabel(labelName);
  // Starred / important may live on the column alone (mail flagged before the
  // label and the column were kept in step), so those rows are un-flagged too.
  const flagColumn =
    label === SYSTEM_LABELS.STARRED
      ? mailMessages.isStarred
      : label === SYSTEM_LABELS.IMPORTANT
        ? mailMessages.isImportant
        : null;
  const carriesLabel = sql`COALESCE(${mailMessages.labels}, '[]'::jsonb) @> ${JSON.stringify([label])}::jsonb`;
  const rows = await db
    .update(mailMessages)
    .set({
      labels: sql`COALESCE(${mailMessages.labels}, '[]'::jsonb) - ${label}::text`,
      ...flagsForLabelChange([label], 'remove'),
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(mailMessages.id, messageIds),
        isNull(mailMessages.deletedAt),
        flagColumn ? sql`(${carriesLabel} OR ${flagColumn} = true)` : carriesLabel,
      ),
    )
    .returning({ accountId: mailMessages.accountId });
  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  await updateLabelMessageCount(db, label, accountIds, -rows.length);
  return { affected: rows.length, accountIds };
}

/**
 * Apply or remove `labelName` from every message in a thread. Returns
 * the count of messages whose JSONB array changed.
 *
 * System slugs are normalised (`archive` → `ARCHIVE`) so callers can
 * pass either form. Adding a location label (`INBOX`, `ARCHIVE`, `TRASH`,
 * `SPAM`) moves the conversation there, so it cannot sit in the inbox and
 * the trash at once — Gmail-style location labels.
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
  const result =
    action === 'add'
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
      AND account_id = ANY(${textArray(accountIds)})
      AND deleted_at IS NULL
  `);
}
