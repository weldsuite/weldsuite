/**
 * Mail campaign service.
 *
 * Campaigns are bulk-send projects with their own recipient list,
 * scheduling, and A/B variants. This service covers CRUD; the actual
 * fan-out send is queued by a separate worker (planned) — we do not
 * dispatch campaign sends through the per-message Cloudflare path,
 * those rate-limits and tracking semantics are different.
 *
 * Status transitions are guarded so a `sent` campaign can't be put back
 * into `draft`.
 */

import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { schema } from '../../db';
import type { Database } from '../../db';
import { generateId } from '../../lib/id';
import type { MailRecipientList } from '@weldsuite/db/schema/mail-campaigns';

const { mailCampaigns } = schema;

export class MailCampaignError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'INVALID_TRANSITION',
    message: string,
  ) {
    super(message);
    this.name = 'MailCampaignError';
  }
}

type CampaignStatus =
  | 'draft' | 'scheduled' | 'sending' | 'sent' | 'paused' | 'cancelled' | 'failed';

const TERMINAL_STATUSES: ReadonlySet<CampaignStatus> = new Set(['sent', 'cancelled', 'failed']);

export interface ListCampaignsFilters {
  status?: CampaignStatus;
  templateId?: string;
  limit?: number;
  cursor?: string;
}

export async function listCampaigns(db: Database, filters: ListCampaignsFilters) {
  const limit = Math.min(filters.limit ?? 25, 100);
  const conditions: SQL[] = [isNull(mailCampaigns.deletedAt)!];
  if (filters.status) conditions.push(eq(mailCampaigns.status, filters.status));
  if (filters.templateId) conditions.push(eq(mailCampaigns.templateId, filters.templateId));

  if (filters.cursor) {
    const [cur] = await db
      .select({ createdAt: mailCampaigns.createdAt, id: mailCampaigns.id })
      .from(mailCampaigns)
      .where(eq(mailCampaigns.id, filters.cursor))
      .limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${mailCampaigns.createdAt} < ${cur.createdAt} OR (${mailCampaigns.createdAt} = ${cur.createdAt} AND ${mailCampaigns.id} < ${cur.id}))`,
      );
    }
  }

  const where = and(...conditions);
  const countWhere = and(...(filters.cursor ? conditions.slice(0, -1) : conditions));

  const [rows, countRes] = await Promise.all([
    db
      .select()
      .from(mailCampaigns)
      .where(where)
      .orderBy(desc(mailCampaigns.createdAt), desc(mailCampaigns.id))
      .limit(limit + 1),
    db.select({ count: sql<number>`count(*)::int` }).from(mailCampaigns).where(countWhere),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
  return { data, hasMore, cursor, totalCount: Number(countRes[0]?.count ?? 0) };
}

export async function getCampaign(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(mailCampaigns)
    .where(and(eq(mailCampaigns.id, id), isNull(mailCampaigns.deletedAt)))
    .limit(1);
  return row ?? null;
}

export interface CampaignInput {
  templateId?: string;
  name: string;
  subject: string;
  preheader?: string;
  htmlContent: string;
  textContent?: string;
  recipientList: MailRecipientList;
  fromName: string;
  fromEmail: string;
  replyToEmail?: string;
  scheduledAt?: Date | string;
  status?: CampaignStatus;
  trackOpens?: boolean;
  trackClicks?: boolean;
  tags?: string[];
}

export async function createCampaign(db: Database, data: CampaignInput) {
  const id = generateId('camp');
  const now = new Date();
  await db.insert(mailCampaigns).values({
    id,
    templateId: data.templateId,
    name: data.name,
    subject: data.subject,
    preheader: data.preheader,
    htmlContent: data.htmlContent,
    textContent: data.textContent,
    recipientList: data.recipientList,
    totalRecipients: countRecipients(data.recipientList),
    fromName: data.fromName,
    fromEmail: data.fromEmail,
    replyToEmail: data.replyToEmail,
    scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : null,
    status: data.status ?? 'draft',
    trackOpens: data.trackOpens ?? true,
    trackClicks: data.trackClicks ?? true,
    tags: data.tags,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(mailCampaigns).where(eq(mailCampaigns.id, id));
  return row!;
}

export async function updateCampaign(
  db: Database,
  id: string,
  data: Partial<CampaignInput>,
) {
  const [existing] = await db
    .select()
    .from(mailCampaigns)
    .where(and(eq(mailCampaigns.id, id), isNull(mailCampaigns.deletedAt)))
    .limit(1);
  if (!existing) throw new MailCampaignError('NOT_FOUND', 'Campaign not found');

  if (TERMINAL_STATUSES.has(existing.status as CampaignStatus)) {
    // Editing a terminal campaign would silently break the audit trail.
    // Only allow safe metadata fields through (tags, preheader copy edits).
    const allowed = new Set(['tags', 'preheader']);
    for (const key of Object.keys(data)) {
      if ((data as Record<string, unknown>)[key] !== undefined && !allowed.has(key)) {
        throw new MailCampaignError(
          'INVALID_TRANSITION',
          `Campaign is ${existing.status}; only tags/preheader can be edited.`,
        );
      }
    }
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) if (v !== undefined) patch[k] = v;
  if (data.recipientList) patch.totalRecipients = countRecipients(data.recipientList);
  if (data.scheduledAt) patch.scheduledAt = new Date(data.scheduledAt);

  await db
    .update(mailCampaigns)
    .set(patch as typeof mailCampaigns.$inferInsert)
    .where(eq(mailCampaigns.id, id));
  const [after] = await db.select().from(mailCampaigns).where(eq(mailCampaigns.id, id));
  return { before: existing, after: after! };
}

export async function softDeleteCampaign(db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(mailCampaigns)
    .where(and(eq(mailCampaigns.id, id), isNull(mailCampaigns.deletedAt)))
    .limit(1);
  if (!existing) return null;
  await db
    .update(mailCampaigns)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(mailCampaigns.id, id));
  return existing;
}

function countRecipients(list: MailRecipientList): number {
  return (
    (list.personIds?.length ?? 0) +
    (list.contactIds?.length ?? 0) +
    (list.segmentIds?.length ?? 0) +
    (list.emails?.length ?? 0)
  );
}
